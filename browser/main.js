// Jev Browser main process: one window, a browser UI view on top, one sandboxed WebContentsView per tab.
const { app, BaseWindow, Menu, WebContentsView, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Services } = require("./services");
const { Library } = require("./store");
const { MODEL, findModel, downloadModel } = require("./model");
const system = require("./system");

const CDP_PORT = 9444; // loopback only: lets the local agent attach to Jev Browser's own tabs
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.setName("Jev Browser");

const CHROME_HEIGHT = 86; // tab strip + toolbar
const PANEL_WIDTH = 380;
const SEARCH = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
};
const DEFAULTS = {
  version: 1,
  onboarded: false,
  searchEngine: "duckduckgo",
  homepage: "https://duckduckgo.com/",
  agent: { mode: "local", device: "auto", showCursor: true, budgetMb: 2048, autostart: true, confirmRisky: true },
};

let win, ui, services, library, practiceUrl;
const tabs = new Map(); // id -> { id, view, private }
const downloads = new Map(); // id -> download record
let activeId = null;
let nextId = 1;
let nextDownload = 1;
let panelOpen = true;
let overlay = false;
let modelJob = null;

const modelsDir = () => path.join(app.getPath("userData"), "models");
const modelPath = () => findModel(modelsDir());

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { ...DEFAULTS, ...saved, agent: { ...DEFAULTS.agent, ...saved.agent } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
let settings;
function saveSettings(patch) {
  settings = { ...settings, ...patch, agent: { ...settings.agent, ...(patch.agent || {}) } };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(`${settingsFile()}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${settingsFile()}.tmp`, settingsFile());
  send("settings", settings);
  return settings;
}

// ---------- helpers ----------
function send(channel, payload) {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send(channel, payload);
}

function toUrl(input) {
  const text = String(input || "").trim();
  if (!text) return settings.homepage;
  if (/^(https?|file):\/\//i.test(text) || text.startsWith("about:")) return text;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(text)) return `http://${text}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  return (SEARCH[settings.searchEngine] || SEARCH.duckduckgo) + encodeURIComponent(text);
}

function info(tab) {
  const wc = tab.view.webContents;
  const url = wc.getURL();
  return {
    id: tab.id, title: wc.getTitle() || "New tab", url, loading: wc.isLoading(), private: tab.private,
    canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
    active: tab.id === activeId, bookmarked: library.isBookmarked(url),
  };
}
const publish = () => send("tabs", [...tabs.values()].map(info));

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width, height });
  const tab = tabs.get(activeId);
  if (tab) {
    tab.view.setVisible(!overlay);
    tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(0, width - (panelOpen ? PANEL_WIDTH : 0)),
                         height: Math.max(0, height - CHROME_HEIGHT) });
  }
}

// ---------- tabs ----------
function createTab(url, { activate = true, isPrivate = false } = {}) {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
                      partition: isPrivate ? "jev-private" : "persist:jev" }, // private: in memory only
  });
  const tab = { id: nextId++, view, private: isPrivate };
  tabs.set(tab.id, tab);
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) createTab(target, { isPrivate });
    return { action: "deny" };
  });
  const record = () => { if (!tab.private) library.visit(wc.getURL(), wc.getTitle()); };
  wc.on("did-navigate", () => { record(); publish(); });
  wc.on("page-title-updated", () => { record(); publish(); });
  for (const event of ["did-start-loading", "did-stop-loading", "did-navigate-in-page"]) wc.on(event, publish);
  win.contentView.addChildView(view);
  view.setVisible(false);
  wc.loadURL(toUrl(url));
  if (activate) activateTab(tab.id);
  publish();
  return tab;
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  for (const tab of tabs.values()) tab.view.setVisible(false);
  activeId = id;
  layout();
  publish();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
  if (![...tabs.values()].some((t) => t.private)) session.fromPartition("jev-private").clearStorageData();
  if (activeId === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activateTab(rest[rest.length - 1]);
    else createTab(settings.homepage);
  }
  publish();
}

const activeTab = () => tabs.get(activeId);
const active = () => activeTab()?.view.webContents;

// ---------- downloads ----------
function trackDownloads(ses) {
  ses.on("will-download", (_event, item) => {
    const dir = app.getPath("downloads");
    fs.mkdirSync(dir, { recursive: true }); // minimal Linux installs may not have ~/Downloads yet
    const parsed = path.parse(item.getFilename() || "download");
    let name = parsed.base;
    for (let n = 1; fs.existsSync(path.join(dir, name)); n++) name = `${parsed.name} (${n})${parsed.ext}`;
    const record = { id: nextDownload++, name, path: path.join(dir, name), url: item.getURL(), received: 0,
                     total: item.getTotalBytes(), state: "progressing", started: Date.now() };
    item.setSavePath(record.path);
    downloads.set(record.id, { record, item });
    const update = () => {
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      send("downloads", [...downloads.values()].map((d) => d.record));
    };
    item.on("updated", (_e, state) => { record.state = state === "interrupted" ? "interrupted" : "progressing"; update(); });
    item.once("done", (_e, state) => { record.state = state; update(); });
    update();
  });
}

// ---------- practice shop for the first guided task (loopback only, one page) ----------
function startPractice() {
  const page = fs.readFileSync(path.join(__dirname, "practice", "index.html"));
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || !["/", "/index.html"].includes(req.url.split("?")[0])) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page);
  });
  server.listen(0, "127.0.0.1", () => { practiceUrl = `http://127.0.0.1:${server.address().port}/`; });
}

// ---------- IPC (from the browser UI only) ----------
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== ui.webContents) throw new Error("Not allowed");
    return fn(...args);
  });
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function wireIpc() {
  handle("tabs:new", (url, opts = {}) => createTab(url || settings.homepage, { isPrivate: !!opts.private }).id);
  handle("tabs:close", (id) => closeTab(id));
  handle("tabs:activate", (id) => activateTab(id));
  handle("nav:go", (input) => active()?.loadURL(toUrl(input)));
  handle("nav:back", () => active()?.navigationHistory.goBack());
  handle("nav:forward", () => active()?.navigationHistory.goForward());
  handle("nav:reload", () => active()?.reload());
  handle("ui:panel", (open) => { panelOpen = !!open; layout(); return panelOpen; });
  handle("ui:overlay", (on) => { overlay = !!on; layout(); });
  handle("settings:get", () => settings);
  handle("settings:set", (patch) => saveSettings(patch));

  handle("library:bookmark", () => {
    const wc = active();
    const added = wc ? library.toggleBookmark(wc.getURL(), wc.getTitle()) : false;
    publish();
    return added;
  });
  handle("library:bookmarks", () => library.bookmarks.data);
  handle("library:removeBookmark", (url) => { library.removeBookmark(url); publish(); });
  handle("library:history", (query) => library.searchHistory(query));
  handle("library:clearHistory", () => library.clearHistory());
  handle("library:sites", () => library.sites.data);
  handle("library:setSite", (origin, value) => library.setSite(origin, value));
  handle("downloads:list", () => [...downloads.values()].map((d) => d.record));
  handle("downloads:open", (id) => downloads.get(id)?.record.state === "completed" && shell.openPath(downloads.get(id).record.path));
  handle("downloads:show", (id) => downloads.has(id) && shell.showItemInFolder(downloads.get(id).record.path));
  handle("downloads:cancel", (id) => downloads.get(id)?.item.cancel());

  handle("system:check", () => system.check({ dataDir: app.getPath("userData"), modelPath: modelPath(),
                                               modelSize: MODEL.size, budgetMb: settings.agent.budgetMb }));
  handle("model:info", () => ({ ...MODEL, path: modelPath(), downloading: !!modelJob }));
  handle("model:download", () => {
    if (modelPath()) return modelPath();
    if (modelJob) return null;
    const signal = { aborted: false };
    let last = 0;
    modelJob = { signal };
    downloadModel(modelsDir(), (progress) => {
      if (Date.now() - last > 250 || progress.verifying) { last = Date.now(); send("model-progress", progress); }
    }, { signal }).then((file) => send("model-progress", { done: true, path: file }))
      .catch((error) => send("model-progress", { error: error.message }))
      .finally(() => { modelJob = null; });
    return null;
  });
  handle("model:cancel", () => { if (modelJob) modelJob.signal.aborted = true; });

  handle("services:get", () => services.state);
  handle("services:start", () => startServices());
  handle("practice:open", () => practiceUrl && createTab(practiceUrl).id);
  handle("agent:run", async (goal, { once = false } = {}) => {
    const url = active()?.getURL() || "";
    if (!/^https?:/.test(url)) throw new Error("Open a web page in this tab first.");
    const origin = originOf(url);
    const permission = url.startsWith(practiceUrl || "\0") ? "allow" : library.site(origin);
    if (permission === "block") throw new Error(`The agent is blocked on ${origin}. Change it in Settings → Sites.`);
    if (!permission && !once) return { needsPermission: origin };
    return services.request("POST", "/api/run", { goal, url });
  });
  handle("agent:events", (since) => services.request("GET", `/api/events?since=${Number(since) || 0}`));
  handle("agent:stop", () => services.request("POST", "/api/stop", {}));
  handle("agent:confirm", (allow) => services.request("POST", "/api/confirm", { allow: allow === true }));
  handle("shell:open", (url) => /^https:\/\//.test(url) && shell.openExternal(url));
}

let starting = null;
function startServices() {
  if (services.state.agent === "ready") return services.state;
  if (settings.agent.mode !== "hosted" && !modelPath()) {
    services.set({ model: "missing", detail: "Download the local model in Settings → Agent to start." });
    return services.state;
  }
  starting ??= services.start(settings, { modelPath: modelPath() }).catch((error) => {
    services.set({ detail: error.message });
  }).finally(() => { starting = null; });
  return services.state;
}

// ---------- menu: shortcuts work wherever focus is, including inside web pages ----------
function buildMenu() {
  const command = (name) => () => send("command", name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => createTab(settings.homepage) },
      { label: "New Private Tab", accelerator: "Shift+CmdOrCtrl+N",
        click: () => createTab(settings.homepage, { isPrivate: true }) },
      { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => closeTab(activeId) },
      { label: "Open Location", accelerator: "CmdOrCtrl+L", click: command("focus-omnibox") },
      { type: "separator" },
      { label: "Bookmark This Page", accelerator: "CmdOrCtrl+D", click: () => {
        const wc = active();
        if (wc) library.toggleBookmark(wc.getURL(), wc.getTitle());
        publish();
      } },
      { label: "Library", accelerator: "CmdOrCtrl+Y", click: command("library") },
      { label: "Settings", accelerator: "CmdOrCtrl+,", click: command("settings") },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => active()?.reload() },
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => active()?.navigationHistory.goBack() },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => active()?.navigationHistory.goForward() },
      { label: "Agent Panel", accelerator: "CmdOrCtrl+J", click: command("toggle-agent") },
      { type: "separator" },
      { label: "Developer Tools for Page", accelerator: "Alt+CmdOrCtrl+I", click: () => active()?.openDevTools() },
    ] },
    { role: "windowMenu" },
  ]));
}

// ---------- app ----------
app.whenReady().then(() => {
  settings = loadSettings();
  library = new Library(app.getPath("userData"));
  for (const partition of ["persist:jev", "jev-private"]) {
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); // nothing granted by default
    trackDownloads(ses);
  }
  startPractice();
  const mac = process.platform === "darwin";
  win = new BaseWindow({ width: 1320, height: 880, minWidth: 760, minHeight: 520, title: "Jev Browser",
                         backgroundColor: "#f6f6f2", icon: path.join(__dirname, "build", "icon.png"),
                         ...(mac ? { titleBarStyle: "hiddenInset" } : { autoHideMenuBar: true }) });
  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(__dirname, "ui", "index.html"), { query: { platform: process.platform } });
  ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("resize", layout);
  win.on("closed", () => app.quit());
  services = new Services({
    cdpPort: CDP_PORT, log: (line) => console.log(line),
    agentDir: app.isPackaged ? path.join(process.resourcesPath, "agent") : path.resolve(__dirname, ".."),
    venvDir: app.isPackaged ? path.join(app.getPath("userData"), "agent-env") : null,
  });
  services.onChange((state) => send("services", state));
  wireIpc();
  buildMenu();
  ui.webContents.once("did-finish-load", () => {
    createTab(settings.homepage);
    send("settings", settings);
    if (settings.onboarded && settings.agent.autostart) startServices();
  });
  layout();
});

app.on("before-quit", () => { library?.flush(); services?.stop(); });
app.on("window-all-closed", () => app.quit());
