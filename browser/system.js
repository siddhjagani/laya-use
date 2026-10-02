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
function gpus(llama) {
  if (!llama) return [];
  try {
    const out = execFileSync(llama, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).toString();
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

function check({ dataDir, modelPath, modelSize, budgetMb }) {
  const total = os.totalmem();
  const disk = freeDisk(dataDir);
  const uv = which("uv", [`${os.homedir()}/.local/bin/uv`, "/opt/homebrew/bin/uv", "/usr/local/bin/uv"]);
  const llama = process.env.JEV_LLAMA_SERVER || which("llama-server", ["/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server", `${os.homedir()}/.local/bin/llama-server`]);
  const broken = llama ? runs(llama) : null;
  const found = broken ? [] : gpus(llama);
  const items = [
    // Blocking only below the agent's own limit plus room for the browser and system; under 8 GB is a warning.
    { id: "memory", ok: total >= budgetMb * 1024 ** 2 + 1.5 * GB, label: `Memory: ${(total / GB).toFixed(0)} GB`,
      help: total < budgetMb * 1024 ** 2 + 1.5 * GB
        ? `The agent needs ${budgetMb / 1024} GB plus about 1.5 GB for the browser and system.`
        : total < 8 * GB ? `The agent stays under ${budgetMb / 1024} GB; close other apps if pages feel slow.`
        : `The agent stays under ${budgetMb / 1024} GB.` },
    { id: "disk", ok: !!modelPath || disk === null || disk > modelSize + 2 * GB,
      label: disk === null ? "Disk: unknown" : `Free disk: ${(disk / GB).toFixed(1)} GB`,
      help: modelPath ? "The model is already on this computer." : `The model needs ${(modelSize / GB).toFixed(1)} GB.` },
    { id: "uv", ok: !!uv, label: uv ? "Python runtime (uv): found" : "Python runtime (uv): missing",
      help: uv ? uv : "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh" },
    { id: "llama", ok: !!llama && !broken,
      label: !llama ? "Model runtime (llama.cpp): missing" : broken ? "Model runtime (llama.cpp): cannot start"
        : "Model runtime (llama.cpp): found",
      help: broken ? `${broken}${process.platform === "linux" ? " · On Mint/Ubuntu: sudo apt install libgomp1" : ""}`
        : llama ? llama : process.platform === "darwin" ? "Install it with: brew install llama.cpp"
        : process.platform === "linux" ? "Install a llama.cpp release (Vulkan or CUDA build for GPUs, or the CPU build) " +
          "and put llama-server on your PATH: https://github.com/ggml-org/llama.cpp/releases"
        : "Install llama.cpp so that llama-server is on your PATH." },
    { id: "accelerator", ok: true, optional: true,
      label: found.length ? `Accelerator: GPU (${found.join(", ")})` : "Accelerator: CPU",
      help: found.length ? "The model runs on the GPU and falls back to the CPU if the GPU cannot start it."
        : "No GPU backend found in llama.cpp; the model runs on the CPU (slower, same memory limit)." },
    { id: "model", ok: !!modelPath, optional: true, label: modelPath ? "Model: downloaded" : "Model: not downloaded",
      help: modelPath || "Jev Browser can download it now." },
  ];
  return { items, ready: items.every((i) => i.ok || i.optional), modelPath };
}

module.exports = { check };
