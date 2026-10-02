// What onboarding needs to know about this computer before the local agent can run.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

const GB = 1024 ** 3;

function which(name, extra = []) {
  for (const candidate of extra) if (fs.existsSync(candidate)) return candidate;
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name],
                             { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// GPUs this llama.cpp build can offload to (Metal, CUDA, ROCm/HIP, Vulkan…); host backends are not GPUs.
function gpus(llama, env = process.env) {
  if (!llama) return [];
  try {
    const out = execFileSync(llama, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000, env }).toString();
    return [...out.matchAll(/^\s+(\S+?):\s+(.+?)\s+\(/gm)]
      .filter(([, name]) => !/^(CPU|BLAS)/i.test(name)).map(([, name, desc]) => `${desc} (${name})`);
  } catch {
    return [];
  }
}

// Found is not enough: a llama.cpp build can be present but miss a shared library (libgomp, CUDA, Vulkan loader).
function runs(llama) {
  try {
    execFileSync(llama, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    return null;
  } catch (error) {
    return (error.stderr?.toString() || error.message).trim().split("\n").pop().slice(0, 240);
  }
}

function freeDisk(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

// setup: the automatic installer (setup.js). Missing pieces are set up by the app, never by the user.
function check({ dataDir, modelPath, modelSize, budgetMb, setup }) {
  const total = os.totalmem();
  const disk = freeDisk(dataDir);
  const uv = setup ? setup.uv() : which("uv", [`${os.homedir()}/.local/bin/uv`, "/opt/homebrew/bin/uv", "/usr/local/bin/uv"]);
  const llama = setup ? setup.llama() : process.env.JEV_LLAMA_SERVER || which("llama-server", [
    "/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server", `${os.homedir()}/.local/bin/llama-server`]);
  const broken = setup ? setup.llamaProblem() : llama ? runs(llama) : null;
  const found = llama && !broken ? gpus(llama, setup ? setup.env() : process.env) : [];
  const needMb = budgetMb * 1024 ** 2 + 1.5 * GB;
  const items = [
    // Blocking only below the agent's own limit plus room for the browser and system; under 8 GB is a warning.
    { id: "memory", ok: total >= needMb, label: `Memory: ${(total / GB).toFixed(0)} GB`,
      help: total < needMb ? `The agent needs ${budgetMb / 1024} GB plus about 1.5 GB for the browser and system.`
        : total < 8 * GB ? `The agent stays under ${budgetMb / 1024} GB; close other apps if pages feel slow.`
        : `The agent stays under ${budgetMb / 1024} GB.` },
    { id: "disk", ok: !!modelPath || disk === null || disk > modelSize + 2 * GB,
      label: disk === null ? "Disk: unknown" : `Free disk: ${(disk / GB).toFixed(1)} GB`,
      help: modelPath ? "The model is already on this computer." : `Setup needs about ${(modelSize / GB + 0.3).toFixed(1)} GB.` },
    { id: "uv", ok: !!uv, setup: !uv, label: uv ? "Python runtime: ready" : "Python runtime: not installed yet",
      help: uv || "Jev Browser downloads it for you (about 20 MB)." },
    { id: "llama", ok: !!llama, setup: !llama,
      label: llama ? "Model runtime (llama.cpp): ready" : "Model runtime (llama.cpp): not installed yet",
      help: llama || (broken ? `Installed but cannot start (${broken}). Setup will fix it.`
        : "Jev Browser downloads the right build for this computer (about 20–40 MB).") },
    { id: "accelerator", ok: true, optional: true,
      label: !llama ? "Accelerator: checked after setup" : found.length ? `Accelerator: GPU (${found.join(", ")})` : "Accelerator: CPU",
      help: found.length ? "The model runs on the GPU and falls back to the CPU if the GPU cannot start it."
        : llama ? "No usable GPU found; the model runs on the CPU (slower, same memory limit)." : "" },
    { id: "model", ok: !!modelPath, setup: !modelPath, label: modelPath ? "Model: downloaded" : "Model: not downloaded yet",
      help: modelPath || `Jev Browser downloads it for you (${(modelSize / GB).toFixed(1)} GB).` },
  ];
  return { items, ready: items.every((i) => i.ok || i.optional), needsSetup: items.some((i) => i.setup), modelPath };
}

module.exports = { check, gpus, runs };
