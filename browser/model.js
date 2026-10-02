// Local model manager: find GUI-Owl-1.5-2B in the Hugging Face cache or the app's models folder, or download it
// with resume and a SHA-256 check. The file is only used after its hash matches.
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const MODEL = {
  name: "GUI-Owl-1.5-2B-Instruct (Q4_K_M)",
  repo: "mradermacher/GUI-Owl-1.5-2B-Instruct-GGUF",
  file: "GUI-Owl-1.5-2B-Instruct.Q4_K_M.gguf",
  size: 1107410432,
  sha256: "5fd2c77781a14a91128928b5bd313252aab076b44682396af4bb2c99667f5ef5",
};
MODEL.url = `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.file}`;

function hfCandidates(model = MODEL) {
  const root = path.join(process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface"), "hub",
                         `models--${model.repo.replace("/", "--")}`);
  const found = [path.join(root, "blobs", model.sha256)];
  try {
    for (const rev of fs.readdirSync(path.join(root, "snapshots"))) found.push(path.join(root, "snapshots", rev, model.file));
  } catch { /* no cache */ }
  return found;
}

function findModel(modelsDir, model = MODEL) {
  for (const candidate of [path.join(modelsDir, model.file), ...hfCandidates(model)]) {
    try {
      if (fs.statSync(candidate).size === model.size) return candidate;
    } catch { /* missing */ }
  }
  return null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function get(url, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    lib.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), headers, redirects - 1));
      }
      resolve(res);
    }).on("error", reject);
  });
}

// onProgress({ received, total }) is called as bytes arrive; `signal.aborted` cancels between chunks.
async function downloadModel(modelsDir, onProgress, { model = MODEL, signal = {} } = {}) {
  fs.mkdirSync(modelsDir, { recursive: true });
  const target = path.join(modelsDir, model.file);
  const part = `${target}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > model.size) { fs.rmSync(part); have = 0; }
  if (have < model.size) {
    const res = await get(model.url, have ? { Range: `bytes=${have}-` } : {});
    if (res.statusCode === 200 && have) have = 0; // server ignored the range: start over
    else if (![200, 206].includes(res.statusCode)) throw new Error(`Download failed: HTTP ${res.statusCode}`);
    const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
    let received = have;
    await new Promise((resolve, reject) => {
      res.on("data", (chunk) => {
        if (signal.aborted) { res.destroy(); out.end(); reject(new Error("Download cancelled")); return; }
        received += chunk.length;
        onProgress?.({ received, total: model.size });
      });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      res.pipe(out);
    });
  }
  onProgress?.({ received: model.size, total: model.size, verifying: true });
  const digest = await sha256(part);
  if (digest !== model.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error("The downloaded model did not match its checksum and was deleted. Try again.");
  }
  fs.renameSync(part, target);
  return target;
}

module.exports = { MODEL, findModel, downloadModel, sha256 };
