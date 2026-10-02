// Local sidecars: the 2 GB model server (jev-local) and the agent's chat server (jev-chat).
// Both bind to 127.0.0.1 and use per-launch random keys; nothing here is reachable from web pages.
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Ports are chosen fresh at every launch, so a second instance or a leftover process can never collide.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function findUv() {
  for (const candidate of [path.join(os.homedir(), ".local/bin/uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync("which", ["uv"]).toString().trim();
  } catch {
    return null;
  }
}

class Services {
  // agentDir: the Python agent project (the repository in development, app resources when packaged).
  // venvDir: where uv keeps its environment when the project folder is read-only (packaged apps).
  // runtime(): current { uv, llama } paths from the automatic setup (Setup), so nothing has to be on PATH.
  constructor({ cdpPort, log, agentDir, venvDir, runtime }) {
    this.cdpPort = cdpPort;
    this.runtime = runtime || (() => ({}));
    this.agentDir = agentDir;
    this.venvDir = venvDir;
    this.log = log;
    this.modelKey = crypto.randomBytes(16).toString("hex");
    this.chatToken = crypto.randomBytes(16).toString("hex");
    this.children = [];
    this.state = { model: "stopped", agent: "stopped", detail: "", accelerator: "" };
    this.listeners = new Set();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(patch) {
    Object.assign(this.state, patch);
    for (const listener of this.listeners) listener({ ...this.state });
  }

  env(extra) {
    const { llama, libPath } = this.runtime();
    const env = { ...process.env, ...(llama ? { JEV_LLAMA_SERVER: llama } : {}), ...extra,
                  JEV_PARENT_PID: String(process.pid) };
    if (libPath) env.LD_LIBRARY_PATH = [libPath, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    if (this.venvDir) env.UV_PROJECT_ENVIRONMENT = this.venvDir;
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  spawn(name, args, extra, onLine) {
    const uv = this.runtime().uv || findUv();
    if (!uv) throw new Error("The Python runtime is not set up yet. Open Settings → Model → Set up.");
    const packaged = this.venvDir ? ["--frozen", "--no-editable"] : [];
    const child = spawn(uv, ["run", ...packaged, "--project", this.agentDir, ...args],
                        { cwd: this.agentDir, env: this.env(extra) });
    this.children.push(child);
    const read = (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((line) => {
      this.log(`[${name}] ${line}`);
      onLine?.(line);
    });
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => {
      this.log(`[${name}] exited ${code}`);
      if (name === "model") this.set({ model: "stopped", detail: `Model server exited (${code}).` });
      if (name === "agent") this.set({ agent: "stopped" });
    });
    return child;
  }

  async start(settings, { modelPath } = {}) {
    const MODEL_PORT = await freePort();
    this.chatPort = await freePort();
    const CHAT_PORT = this.chatPort;
    const modelBase = `http://127.0.0.1:${MODEL_PORT}`;
    const modelEnv = settings.agent.mode === "hosted"
      ? {}
      : {
          DECISION_MODEL_BASE_URL: modelBase, DECISION_MODEL_API_KEY: this.modelKey,
          TEXT_MODEL_BASE_URL: `${modelBase}/v1`, TEXT_MODEL_API_KEY: this.modelKey, TEXT_MODEL_REASONING: "none",
        };
    if (settings.agent.mode !== "hosted") {
      this.set({ model: "starting", detail: "Starting the local model (about 1.4 GB of memory)…" });
      await new Promise((resolve, reject) => {
        this.spawn("model", ["jev-local", "--model", modelPath, "--port", String(MODEL_PORT),
                             "--budget-mb", String(settings.agent.budgetMb), "--device", settings.agent.device || "auto",
                             "--ctx-size", String(settings.agent.ctxSize || 4096),
                             "--threads", String(settings.agent.threads || 0)],
          { DECISION_MODEL_API_KEY: this.modelKey }, (line) => {
            if (line.startsWith("Accelerator:")) this.set({ accelerator: line.slice("Accelerator:".length).trim() });
            if (line.startsWith("Warm footprint")) {
              this.set({ model: "ready", detail: line });
              resolve();
            } else if (/exceeds|exceeded|exited during startup/.test(line)) {
              this.set({ model: "failed", detail: line });
              reject(new Error(line));
            }
          });
      });
    }
    const ws = await this.cdpWebSocket();
    this.spawn("agent", ["jev-chat"], {
      ...modelEnv, JEV_CDP_WS: ws, JEV_CHAT_PORT: String(CHAT_PORT),
      JEV_CHAT_TOKEN: this.chatToken, JEV_SHOW: settings.agent.showCursor ? "1" : "0",
      JEV_CONFIRM: settings.agent.confirmRisky === false ? "0" : "1",
      JEV_THINK: settings.agent.think ? "1" : "0",
    });
    for (let i = 0; i < 60; i++) {
      try {
        await this.request("POST", "/api/ping", {});
        this.set({ agent: "ready" });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    this.set({ agent: "failed", detail: "The agent server did not start." });
  }

  cdpWebSocket() {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${this.cdpPort}/json/version`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body).webSocketDebuggerUrl); } catch (error) { reject(error); }
        });
      }).on("error", reject);
    });
  }

  // Requests from the main process carry the token and no Origin header, so web pages cannot forge them.
  request(method, route, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = http.request({
        host: "127.0.0.1", port: this.chatPort, path: route, method,
        headers: { "X-Jev-Token": this.chatToken, "Content-Type": "application/json",
                   ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = {};
          try { json = JSON.parse(text || "{}"); } catch { /* reported below */ }
          if (res.statusCode >= 400) reject(new Error(json.error || `Agent returned ${res.statusCode}`));
          else resolve(json);
        });
      });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  stop() {
    for (const child of this.children) if (child.exitCode === null) child.kill("SIGTERM");
    this.children = [];
  }
}

module.exports = { Services };
