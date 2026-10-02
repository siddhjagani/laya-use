// Automatic runtime setup: uv (Python runtime) and llama.cpp are downloaded into the app's own folder, so a user never
// has to install anything by hand. Anything already installed on the system and working is reused.
const { execFile, execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const API = process.env.JEV_GITHUB_API || "https://api.github.com";

function get(url, headers = {}, redirects = 6) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    lib.get(url, { headers: { "User-Agent": "jev-browser", ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), headers, redirects - 1));
      }
      resolve(res);
    }).on("error", reject);
  });
}

async function json(url) {
  const res = await get(url, { Accept: "application/vnd.github+json" });
  let body = "";
  for await (const chunk of res) body += chunk;
  if (res.statusCode !== 200) throw new Error(`${url} returned HTTP ${res.statusCode}`);
  return JSON.parse(body);
}

async function download(url, file, onProgress) {
  const res = await get(url);
  if (res.statusCode !== 200) throw new Error(`Download failed (HTTP ${res.statusCode}): ${url}`);
  const total = Number(res.headers["content-length"]) || 0;
  let received = 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(`${file}.part`);
    res.on("data", (chunk) => { received += chunk.length; onProgress?.({ received, total }); });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });
  fs.renameSync(`${file}.part`, file);
}

function extract(archive, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", dir]); // tar handles .tar.gz, and .zip on macOS and Windows
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

function which(name) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name],
                             { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// Returns null when the binary runs, otherwise the loader's last error line (missing libgomp, Vulkan, CUDA…).
function runs(binary, args = ["--version"], env = process.env) {
  try {
    execFileSync(binary, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30000, env });
    return null;
  } catch (error) {
    return (error.stderr?.toString() || error.message).trim().split("\n").pop().slice(0, 240) || "does not start";
  }
}

// ---------- uv ----------
function uvTriple(platform = process.platform, arch = process.arch) {
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  if (platform === "darwin") return { name: `uv-${cpu}-apple-darwin.tar.gz` };
  if (platform === "win32") return { name: `uv-${cpu}-pc-windows-msvc.zip` };
  return { name: `uv-${cpu}-unknown-linux-gnu.tar.gz` };
}

// ---------- llama.cpp ----------
function hasVulkan() {
  if (process.platform !== "linux") return false;
  try {
    return /libvulkan\.so\.1/.test(execFileSync("ldconfig", ["-p"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch {
    return ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/aarch64-linux-gnu/libvulkan.so.1"].some(fs.existsSync);
  }
}

// The release asset for this computer, preferring a GPU build that can run here.
function llamaAsset(assets, { platform = process.platform, arch = process.arch, vulkan = hasVulkan() } = {}) {
  const names = assets.map((a) => a.name);
  const pick = (...patterns) => {
    for (const pattern of patterns) {
      const hit = names.find((n) => pattern.test(n));
      if (hit) return assets.find((a) => a.name === hit);
    }
    return null;
  };
  if (platform === "darwin") return pick(arch === "arm64" ? /bin-macos-arm64\.(tar\.gz|zip)$/ : /bin-macos-x64\.(tar\.gz|zip)$/);
  if (platform === "win32") return pick(/bin-win-vulkan-x64\.zip$/, /bin-win-cpu-x64\.zip$/);
  if (arch === "arm64") return pick(/bin-ubuntu-arm64\.tar\.gz$/);
  return vulkan ? pick(/bin-ubuntu-vulkan-x64\.tar\.gz$/, /bin-ubuntu-x64\.tar\.gz$/) : pick(/bin-ubuntu-x64\.tar\.gz$/);
}

class Setup {
  constructor({ dir, agentDir, venvDir, log = () => {} }) {
    this.dir = dir;
    this.agentDir = agentDir;
    this.venvDir = venvDir;
    this.log = log;
    this.statePath = path.join(dir, "runtime.json");
    try { this.saved = JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch { this.saved = {}; }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.saved, null, 2));
  }

  // Paths that work right now, preferring Jev Browser's own copies, then the system's.
  uv() {
    const candidates = [this.saved.uv, which("uv"), path.join(os.homedir(), ".local/bin", exe("uv"))];
    return candidates.find((c) => c && fs.existsSync(c) && !runs(c)) || null;
  }

  // Environment llama.cpp runs with: adds libraries Jev Browser unpacked itself (libgomp on minimal Linux installs).
  env(base = process.env) {
    if (!this.saved.libPath) return base;
    return { ...base, LD_LIBRARY_PATH: [this.saved.libPath, base.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  }

  llama() {
    const candidates = [process.env.JEV_LLAMA_SERVER, this.saved.llama, which("llama-server"),
                        "/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"];
    return candidates.find((c) => c && fs.existsSync(c) && !runs(c, ["--version"], this.env())) || null;
  }

  // Why the installed llama.cpp cannot start, if it is present but broken.
  llamaProblem() {
    const present = [this.saved.llama, which("llama-server")].find((c) => c && fs.existsSync(c));
    return present ? runs(present, ["--version"], this.env()) : null;
  }

  async installUv(onProgress) {
    const { name } = uvTriple();
    const archive = path.join(this.dir, "downloads", name);
    await download(`https://github.com/astral-sh/uv/releases/latest/download/${name}`, archive, onProgress);
    extract(archive, path.join(this.dir, "uv"));
    const binary = findFile(path.join(this.dir, "uv"), exe("uv"));
    if (!binary) throw new Error("uv was downloaded but its program was not found.");
    fs.chmodSync(binary, 0o755);
    const problem = runs(binary);
    if (problem) throw new Error(`uv does not start: ${problem}`);
    this.saved.uv = binary;
    this.save();
    return binary;
  }

  async installLlama(onProgress) {
    const release = await json(`${API}/repos/ggml-org/llama.cpp/releases/latest`);
    const asset = llamaAsset(release.assets);
    if (!asset) throw new Error("No llama.cpp build is published for this computer.");
    const archive = path.join(this.dir, "downloads", asset.name);
    await download(asset.browser_download_url, archive, onProgress);
    extract(archive, path.join(this.dir, "llama"));
    const binary = findFile(path.join(this.dir, "llama"), exe("llama-server"));
    if (!binary) throw new Error("llama.cpp was downloaded but llama-server was not found.");
    fs.chmodSync(binary, 0o755);
    this.saved.llama = binary;
    this.saved.llamaBuild = `${release.tag_name} ${asset.name}`;
    this.save();
    return binary;
  }

  // Linux release builds need the OpenMP runtime (libgomp1). First choice needs no password: download the
  // distribution's own package with apt and unpack it into Jev Browser's folder. Only if that fails, ask to install
  // it system-wide through the desktop's password prompt.
  async installSystemLibraries() {
    if (process.platform !== "linux") return;
    const dir = path.join(this.dir, "libs");
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "deb"), { recursive: true });
      execFileSync("apt-get", ["download", "libgomp1"], { cwd: path.join(dir, "deb"), stdio: ["ignore", "pipe", "pipe"],
                                                          timeout: 120000 });
      const deb = fs.readdirSync(path.join(dir, "deb")).find((f) => f.endsWith(".deb"));
      execFileSync("dpkg-deb", ["-x", path.join(dir, "deb", deb), path.join(dir, "root")]);
      const lib = findFile(path.join(dir, "root"), "libgomp.so.1");
      if (!lib) throw new Error("libgomp.so.1 not found in the package");
      this.saved.libPath = path.dirname(lib);
      this.save();
      if (!this.llamaProblem()) return;
    } catch (error) {
      this.log(`[setup] unpacking libgomp1 failed: ${error.message}; asking to install it system-wide`);
    }
    await new Promise((resolve, reject) => execFile("pkexec", ["apt-get", "install", "-y", "libgomp1"],
      (error, _out, stderr) => (error ? reject(new Error(stderr?.toString().trim() || error.message)) : resolve())));
  }

  // Download Python and the agent's packages ahead of time, so the first chat does not wait on the network.
  prepareAgent(onLine) {
    const uv = this.uv();
    if (!uv) return Promise.reject(new Error("uv is not installed."));
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      if (this.venvDir) env.UV_PROJECT_ENVIRONMENT = this.venvDir;
      const args = ["sync", ...(this.venvDir ? ["--frozen", "--no-editable", "--no-dev"] : []), "--project", this.agentDir];
      const child = spawn(uv, args, { cwd: this.agentDir, env });
      const read = (c) => c.toString().split("\n").filter(Boolean).forEach((l) => { this.log(`[setup] ${l}`); onLine?.(l); });
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Preparing the agent failed (exit ${code}).`))));
    });
  }
}

module.exports = { Setup, llamaAsset, uvTriple, runs, which };
