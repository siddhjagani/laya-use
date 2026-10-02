// Offline: asset selection for every platform, and the updater against a local stand-in for GitHub Releases.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { llamaAsset, uvTriple } = require("../setup");

const names = ["llama-b1-bin-macos-arm64.tar.gz", "llama-b1-bin-macos-x64.tar.gz", "llama-b1-bin-ubuntu-x64.tar.gz",
  "llama-b1-bin-ubuntu-vulkan-x64.tar.gz", "llama-b1-bin-ubuntu-arm64.tar.gz", "llama-b1-bin-win-cpu-x64.zip",
  "llama-b1-bin-win-vulkan-x64.zip", "llama-b1-bin-ubuntu-rocm-10.0-x64.tar.gz"].map((name) => ({ name }));

test("llama.cpp build matches the computer, preferring a GPU build only where it can run", () => {
  const pick = (opts) => llamaAsset(names, opts)?.name;
  assert.equal(pick({ platform: "darwin", arch: "arm64" }), "llama-b1-bin-macos-arm64.tar.gz");
  assert.equal(pick({ platform: "linux", arch: "x64", vulkan: true }), "llama-b1-bin-ubuntu-vulkan-x64.tar.gz");
  assert.equal(pick({ platform: "linux", arch: "x64", vulkan: false }), "llama-b1-bin-ubuntu-x64.tar.gz");
  assert.equal(pick({ platform: "linux", arch: "arm64" }), "llama-b1-bin-ubuntu-arm64.tar.gz");
  assert.equal(pick({ platform: "win32", arch: "x64" }), "llama-b1-bin-win-vulkan-x64.zip");
  assert.equal(uvTriple("linux", "x64").name, "uv-x86_64-unknown-linux-gnu.tar.gz");
  assert.equal(uvTriple("darwin", "arm64").name, "uv-aarch64-apple-darwin.tar.gz");
});

test("version comparison and installer choice", () => {
  const { newer, assetFor } = require("../updater");
  assert.ok(newer("v0.2.0", "0.1.0"));
  assert.ok(newer("v0.10.0", "0.9.9"));
  assert.ok(!newer("v0.1.0", "0.1.0"));
  assert.ok(!newer("v0.1.0", "0.2.0"));
  const assets = ["Jev.Browser-0.2.0-arm64.dmg", "jev-browser_0.2.0_amd64.deb", "jev-browser_0.2.0_arm64.deb",
    "jev-browser-0.2.0.AppImage", "jev-browser-0.2.0-arm64.AppImage"].map((name) => ({ name }));
  assert.equal(assetFor(assets, { platform: "linux", arch: "x64" }).name, "jev-browser_0.2.0_amd64.deb");
  assert.equal(assetFor(assets, { platform: "linux", arch: "x64", appImage: "/a/x.AppImage" }).name, "jev-browser-0.2.0.AppImage");
  assert.equal(assetFor(assets, { platform: "linux", arch: "arm64", appImage: "/a" }).name, "jev-browser-0.2.0-arm64.AppImage");
  assert.equal(assetFor(assets, { platform: "darwin", arch: "arm64" }).name, "Jev.Browser-0.2.0-arm64.dmg");
});

function releaseServer(files, sums) {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/latest") {
      const assets = Object.entries(files).map(([name, body]) => ({ name, size: body.length, browser_download_url: `${base}/f/${name}` }));
      assets.push({ name: "SHA256SUMS.txt", size: sums.length, browser_download_url: `${base}/f/SHA256SUMS.txt` });
      return res.end(JSON.stringify({ tag_name: "v9.0.0", body: "notes", assets }));
    }
    const name = decodeURIComponent(req.url.replace("/f/", ""));
    if (name === "SHA256SUMS.txt") return res.end(sums);
    if (files[name]) return res.end(files[name]);
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("updater finds a newer release, downloads it and verifies the checksum", async (t) => {
  const body = crypto.randomBytes(50_000);
  const name = process.arch === "arm64" ? "jev-browser_9.0.0_arm64.deb" : "jev-browser_9.0.0_amd64.deb";
  const dmg = process.arch === "arm64" ? "Jev.Browser-9.0.0-arm64.dmg" : "Jev.Browser-9.0.0-x64.dmg";
  const sum = crypto.createHash("sha256").update(body).digest("hex");
  const server = await releaseServer({ [name]: body, [dmg]: body }, `${sum}  ${name}\n${sum}  ${dmg}\n`);
  t.after(() => server.close());
  process.env.JEV_UPDATE_API = `http://127.0.0.1:${server.address().port}/latest`;
  delete require.cache[require.resolve("../updater")];
  const { Updater } = require("../updater");
  const updater = new Updater({ version: "0.2.0", dir: fs.mkdtempSync(path.join(os.tmpdir(), "jev-up-")) });
  assert.equal((await updater.check()).status, "available");
  const state = await updater.download();
  assert.equal(state.status, "ready", state.error);
  assert.deepEqual(fs.readFileSync(state.file), body);
});

test("updater refuses a download whose checksum does not match", async (t) => {
  const body = crypto.randomBytes(20_000);
  const name = process.arch === "arm64" ? "jev-browser_9.0.0_arm64.deb" : "jev-browser_9.0.0_amd64.deb";
  const dmg = process.arch === "arm64" ? "Jev.Browser-9.0.0-arm64.dmg" : "Jev.Browser-9.0.0-x64.dmg";
  const wrong = "0".repeat(64);
  const server = await releaseServer({ [name]: body, [dmg]: body }, `${wrong}  ${name}\n${wrong}  ${dmg}\n`);
  t.after(() => server.close());
  process.env.JEV_UPDATE_API = `http://127.0.0.1:${server.address().port}/latest`;
  delete require.cache[require.resolve("../updater")];
  const { Updater } = require("../updater");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-up-"));
  const updater = new Updater({ version: "0.2.0", dir });
  await updater.check();
  const state = await updater.download();
  assert.equal(state.status, "error");
  assert.match(state.error, /checksum/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(updater.state.file, null);
});
