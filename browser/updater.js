// In-app updates from the project's GitHub Releases. Every download is checked against the release's SHA256SUMS.txt
// before it is installed.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const http = require("node:http");
const path = require("node:path");

const REPO = "siddhjagani/laya-use";
const API = process.env.JEV_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;

function get(url, redirects = 6) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    lib.get(url, { headers: { "User-Agent": "jev-browser", Accept: "application/vnd.github+json" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      resolve(res);
    }).on("error", reject);
  });
}

async function text(url) {
  const res = await get(url);
  let body = "";
  for await (const chunk of res) body += chunk;
  if (res.statusCode !== 200) throw new Error(`Update server returned HTTP ${res.statusCode}`);
  return body;
}

// 0.10.0 > 0.9.2; tags may start with "v".
function newer(latest, current) {
  const a = String(latest).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const b = String(current).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

// Which installer this copy of the app should update itself with.
function assetFor(assets, { platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE } = {}) {
  const arm = arch === "arm64";
  const match = (re) => assets.find((a) => re.test(a.name));
  if (platform === "darwin") return match(arm ? /arm64\.dmg$/ : /x64\.dmg$|[^4]\.dmg$/);
  if (platform === "win32") return match(/\.exe$/);
  if (appImage) return match(arm ? /arm64\.AppImage$/ : /^(?!.*arm64).*\.AppImage$/);
  return match(arm ? /_arm64\.deb$/ : /_amd64\.deb$/);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

class Updater {
  constructor({ version, dir, log = () => {} }) {
    this.version = version;
    this.dir = dir;
    this.log = log;
    this.state = { status: "idle", version, latest: null, progress: 0, error: null, file: null };
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }

  set(patch) {
    Object.assign(this.state, patch);
    for (const fn of this.listeners) fn({ ...this.state });
  }

  async check() {
    this.set({ status: "checking", error: null });
    try {
      const release = JSON.parse(await text(API));
      const asset = assetFor(release.assets || []);
      if (!newer(release.tag_name, this.version)) {
        this.set({ status: "current", latest: release.tag_name });
      } else if (!asset) {
        this.set({ status: "error", latest: release.tag_name, error: "No installer for this computer in that release." });
      } else {
        this.release = release;
        this.asset = asset;
        this.set({ status: "available", latest: release.tag_name, notes: (release.body || "").slice(0, 1500),
                   size: asset.size });
      }
    } catch (error) {
      this.set({ status: "error", error: error.message });
    }
    return { ...this.state };
  }

  async download() {
    if (!this.asset) await this.check();
    if (!this.asset) return { ...this.state };
    const file = path.join(this.dir, this.asset.name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.set({ status: "downloading", progress: 0 });
    try {
      const sums = this.release.assets.find((a) => a.name === "SHA256SUMS.txt");
      if (!sums) throw new Error("The release has no SHA256SUMS.txt, so the download cannot be verified.");
      const expected = (await text(sums.browser_download_url)).split("\n")
        .map((line) => line.trim().split(/\s+/)).find(([, name]) => name === this.asset.name)?.[0];
      if (!expected) throw new Error(`SHA256SUMS.txt does not list ${this.asset.name}.`);
      const res = await get(this.asset.browser_download_url);
      if (res.statusCode !== 200) throw new Error(`Download failed: HTTP ${res.statusCode}`);
      const total = Number(res.headers["content-length"]) || this.asset.size || 0;
      let received = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(`${file}.part`);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total) this.set({ progress: received / total });
        });
        res.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        res.pipe(out);
      });
      this.set({ status: "verifying" });
      if ((await sha256(`${file}.part`)) !== expected) {
        fs.rmSync(`${file}.part`, { force: true });
        throw new Error("The update did not match its checksum and was deleted.");
      }
      fs.renameSync(`${file}.part`, file);
      this.set({ status: "ready", file, progress: 1 });
    } catch (error) {
      this.set({ status: "error", error: error.message });
    }
    return { ...this.state };
  }

  // Installs the verified file. Returns "relaunch" when the app should restart into the new version.
  install({ shell, appImage = process.env.APPIMAGE } = {}) {
    const file = this.state.file;
    if (this.state.status !== "ready" || !file) return Promise.reject(new Error("No verified update is ready."));
    if (file.endsWith(".AppImage") && appImage) {
      fs.copyFileSync(file, `${appImage}.new`);
      fs.chmodSync(`${appImage}.new`, 0o755);
      fs.renameSync(`${appImage}.new`, appImage);
      return Promise.resolve("relaunch");
    }
    if (file.endsWith(".deb")) {
      return new Promise((resolve, reject) => execFile("pkexec", ["apt-get", "install", "-y", file], (error, _o, err) =>
        error ? reject(new Error(err?.toString().trim() || error.message)) : resolve("relaunch")));
    }
    return shell.openPath(file).then(() => "opened"); // macOS .dmg / Windows installer: the system installer takes over
  }
}

module.exports = { Updater, newer, assetFor };
