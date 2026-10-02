// Jev Browser main process. One BaseWindow per open profile: a browser UI view on top, one sandboxed view per tab.
const { app, BaseWindow, Menu, WebContentsView, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Services } = require("./services");
const { Store, Library, Sessions } = require("./store");
const { CATALOG, findModel, downloadModel, resolveModel } = require("./model");
const { Setup } = require("./setup");
const { Updater } = require("./updater");
const system = require("./system");

const CDP_PORT = 9444; // loopback only: lets the local agent attach to Jev Browser's own tabs
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.setName("Jev Browser");

const CHROME_HEIGHT = 86;
const PANEL_WIDTH = 380;
const SEARCH = {
  duckduckgo: "https://duckduckgo.com/?q=", google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=", brave: "https://search.brave.com/search?q=",
  ecosia: "https://www.ecosia.org/search?q=", startpage: "https://www.startpage.com/do/search?q=",
};
const PERMISSIONS = ["notifications", "geolocation", "media", "clipboard-read", "midi", "idle-detection"];

// ---------- app-wide settings (agent, model, updates, system) ----------
const APP_DEFAULTS = {
  version: 2,
  onboarded: false,
  profiles: [{ id: "default", name: "Personal", color: "#2f5d46" }],
  lastProfile: "default",
  agent: { mode: "local", model: "gui-owl-2b-q4", customModel: "", device: "auto", budgetMb: 2048, ctxSize: 4096,
           threads: 0, showCursor: true, autostart: true, confirmRisky: true, think: false, showThinking: true },
  update: { autoCheck: true },
  system: { hardwareAcceleration: true },
};
const PROFILE_DEFAULTS = {
  searchEngine: "duckduckgo",
  homepage: "https://duckduckgo.com/",
  startup: { mode: "newtab", pages: [] },
  appearance: { theme: "system", zoom: 1, showHomeButton: false },
  privacy: { doNotTrack: false, httpsOnly: false, blockThirdPartyCookies: false, clearOnExit: false },
  downloads: { dir: "", ask: false },
  languages: { spellcheck: true, languages: ["en-US"] },
  permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, "ask"])),
  sitePermissions: {},
  lastTabs: [],
};

function merge(defaults, saved) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(saved || {})) {
    const nested = value && typeof value === "object" && !Array.isArray(value) && defaults[key] &&
      typeof defaults[key] === "object" && !Array.isArray(defaults[key]);
    out[key] = nested ? { ...defaults[key], ...value } : value;
  }
  return out;
}

const userData = app.getPath("userData");
const appStore = new Store(path.join(userData, "app.json"), APP_DEFAULTS);
appStore.data = merge(APP_DEFAULTS, appStore.data);
if (!appStore.data.system.hardwareAcceleration) app.disableHardwareAcceleration(); // must happen before ready

// Earlier versions kept one profile's files at the top of the data folder: move them into the default profile.
function migrateLegacy() {
  const dir = path.join(userData, "profiles", "default");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["bookmarks.json", "history.json", "agent-sites.json"]) {
    const from = path.join(userData, name);
    if (fs.existsSync(from) && !fs.existsSync(path.join(dir, name))) fs.renameSync(from, path.join(dir, name));
  }
  const legacy = path.join(userData, "settings.json");
  if (!fs.existsSync(legacy)) return;
  try {
    const old = JSON.parse(fs.readFileSync(legacy, "utf8"));
    if (old.onboarded) appStore.data.onboarded = true;
    if (old.agent) appStore.data.agent = { ...appStore.data.agent, ...old.agent };
    const target = path.join(dir, "settings.json");
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, JSON.stringify({ searchEngine: old.searchEngine, homepage: old.homepage }, null, 2));
    }
  } catch { /* unreadable legacy file: start fresh */ }
  fs.renameSync(legacy, `${legacy}.migrated`);
  appStore.save(true);
}

// ---------- profiles ----------
const profiles = new Map(); // id -> { id, dir, settings: Store, library, sessions, partition }
const profileInfo = (id) => appStore.data.profiles.find((p) => p.id === id);
function profile(id) {
  if (profiles.has(id)) return profiles.get(id);
  const dir = path.join(userData, "profiles", id);
  fs.mkdirSync(dir, { recursive: true });
  const settings = new Store(path.join(dir, "settings.json"), PROFILE_DEFAULTS);
  settings.data = merge(PROFILE_DEFAULTS, settings.data);
  const p = { id, dir, settings, library: new Library(dir), sessions: new Sessions(dir),
              partition: id === "default" ? "persist:jev" : `persist:jev-${id}` };
  profiles.set(id, p);
  configureSession(p, session.fromPartition(p.partition));
  configureSession(p, session.fromPartition(`jev-private-${id}`));
  watchGoogleAccount(p);
  setTimeout(() => refreshGoogleAccount(p), 2000);
  return p;
}

// Google refuses sign-in from browsers that announce "Electron"; present the standard Chrome user agent instead.
const cleanUserAgent = (ua) => ua.replace(/\s?Electron\/\S+/g, "").replace(/\s?(Jev ?Browser|jev-browser)\/\S+/gi, "");

// The Google account signed in to a profile, read the way Chromium does (accounts.google.com ListAccounts).
const GOOGLE_ACCOUNTS = "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";
const accountTimers = new Map();
async function refreshGoogleAccount(p) {
  const info = profileInfo(p.id);
  if (!info) return;
  let account = null;
  try {
    const res = await session.fromPartition(p.partition).fetch(GOOGLE_ACCOUNTS, { method: "POST", body: "" });
    const text = await res.text();
    const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
    if (email) {
      const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      const at = strings.indexOf(email);
      const photo = strings.find((s) => /^https:\/\/lh\d\.googleusercontent\.com\//.test(s)) || "";
      account = { email, name: at > 0 ? strings[at - 1] : email.split("@")[0], photo };
    }
  } catch (error) {
    console.log(`[profiles] Google account check failed: ${error.message}`);
    return;
  }
  const before = JSON.stringify(info.google || null);
  info.google = account;
  if (JSON.stringify(account) !== before) {
    appStore.save();
    broadcast("profiles", appStore.data.profiles);
  }
}
function watchGoogleAccount(p) {
  session.fromPartition(p.partition).cookies.on("changed", (_e, cookie) => {
    if (!/(^|\.)google\.com$/.test(cookie.domain.replace(/^\./, "")) || !/SID|LSID/.test(cookie.name)) return;
    clearTimeout(accountTimers.get(p.id));
    accountTimers.set(p.id, setTimeout(() => refreshGoogleAccount(p), 1500));
  });
}

function siteOf(host) {
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

const pendingPermissions = new Map();
let nextPermission = 1;

function configureSession(p, ses) {
  if (ses.__jev) return;
  ses.__jev = true;
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  const s = () => p.settings.data;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === "fullscreen" || permission === "pointerLock") return callback(true);
    let origin = "";
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { /* no origin */ }
    const key = PERMISSIONS.includes(permission) ? permission : null;
    if (!key || !origin) return callback(false);
    const decision = s().sitePermissions[origin]?.[key] || s().permissions[key] || "ask";
    if (decision !== "ask") return callback(decision === "allow");
    const win = windowForContents(wc);
    if (!win) return callback(false);
    const id = nextPermission++;
    pendingPermissions.set(id, { callback, origin, key, profile: p });
    win.send("permission-ask", { id, origin, permission: key });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (s().privacy.httpsOnly && details.url.startsWith("http://") &&
        !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(details.url)) {
      return callback({ redirectURL: `https://${details.url.slice(7)}` });
    }
    callback({});
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (s().privacy.doNotTrack) { headers.DNT = "1"; headers["Sec-GPC"] = "1"; }
    if (s().privacy.blockThirdPartyCookies && details.resourceType !== "mainFrame" && details.referrer) {
      try {
        if (siteOf(new URL(details.url).hostname) !== siteOf(new URL(details.referrer).hostname)) delete headers.Cookie;
      } catch { /* keep headers */ }
    }
    callback({ requestHeaders: headers });
  });
  ses.setSpellCheckerEnabled(!!s().languages.spellcheck);
  try { ses.setSpellCheckerLanguages(s().languages.languages); } catch { /* language not available */ }
  trackDownloads(p, ses);
}

// ---------- windows ----------
const windows = new Map(); // ui webContents id -> BrowserWin
let practiceUrl;
let nextTab = 1;

class BrowserWin {
  constructor(profileId) {
    this.profile = profile(profileId);
    this.tabs = new Map();
    this.activeId = null;
    this.panelOpen = true;
    this.overlay = false;
    const mac = process.platform === "darwin";
    const info = profileInfo(profileId);
    this.win = new BaseWindow({
      width: 1320, height: 880, minWidth: 760, minHeight: 520,
      title: appStore.data.profiles.length > 1 ? `Jev Browser – ${info?.name}` : "Jev Browser",
      backgroundColor: "#f6f6f2", icon: path.join(__dirname, "build", "icon.png"),
      ...(mac ? { titleBarStyle: "hiddenInset" } : { autoHideMenuBar: true }),
    });
    this.ui = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true,
                                                       sandbox: true } });
    this.win.contentView.addChildView(this.ui);
    windows.set(this.ui.webContents.id, this);
    this.ui.webContents.loadFile(path.join(__dirname, "ui", "index.html"),
                                 { query: { platform: process.platform, profile: profileId } });
    this.ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.on("resize", () => this.layout());
    this.win.on("focus", () => { appStore.data.lastProfile = profileId; appStore.save(); });
    this.win.on("close", () => this.rememberTabs());
    this.win.on("closed", () => {
      windows.delete(this.ui.webContents.id);
      if (this.profile.settings.data.privacy.clearOnExit &&
          ![...windows.values()].some((w) => w.profile.id === profileId)) clearData(this.profile, { all: true });
    });
    this.ui.webContents.once("did-finish-load", () => {
      const s = this.profile.settings.data;
      const urls = s.startup.mode === "continue" && s.lastTabs.length ? s.lastTabs
        : s.startup.mode === "pages" && s.startup.pages.length ? s.startup.pages : [s.homepage];
      urls.forEach((url, i) => this.createTab(url, { activate: i === urls.length - 1 }));
      this.send("settings", this.settings());
    });
    this.layout();
  }

  send(channel, payload) {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send(channel, payload);
  }

  settings() {
    return { app: appStore.data, profile: this.profile.settings.data, profileId: this.profile.id };
  }

  rememberTabs() {
    this.profile.settings.data.lastTabs = [...this.tabs.values()].filter((t) => !t.private)
      .map((t) => t.view.webContents.getURL()).filter((u) => /^https?:/.test(u)).slice(0, 30);
    this.profile.settings.save(true);
  }

  info(tab) {
    const wc = tab.view.webContents;
    const url = wc.getURL();
    return { id: tab.id, title: wc.getTitle() || "New tab", url, loading: wc.isLoading(), private: tab.private,
             canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
             active: tab.id === this.activeId, bookmarked: this.profile.library.isBookmarked(url), favicon: tab.favicon || null,
             zoom: Math.round(wc.getZoomFactor() * 100) };
  }

  publish() { this.send("tabs", [...this.tabs.values()].map((t) => this.info(t))); }

  layout() {
    const { width, height } = this.win.getContentBounds();
    this.ui.setBounds({ x: 0, y: 0, width, height });
    const tab = this.tabs.get(this.activeId);
    if (tab) {
      tab.view.setVisible(!this.overlay);
      tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(0, width - (this.panelOpen ? PANEL_WIDTH : 0)),
                           height: Math.max(0, height - CHROME_HEIGHT) });
    }
  }

  createTab(url, { activate = true, isPrivate = false } = {}) {
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true,
                        partition: isPrivate ? `jev-private-${this.profile.id}` : this.profile.partition },
    });
    const tab = { id: nextTab++, view, private: isPrivate };
    this.tabs.set(tab.id, tab);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) this.createTab(target, { isPrivate });
      return { action: "deny" };
    });
    const record = () => { if (!tab.private) this.profile.library.visit(wc.getURL(), wc.getTitle()); };
    wc.on("did-navigate", () => { record(); this.publish(); });
    wc.on("page-title-updated", () => { record(); this.publish(); });
    wc.on("page-favicon-updated", (_e, icons) => { tab.favicon = icons.find((u) => /^https?:|^data:image\//.test(u)) || null; this.publish(); });
    wc.on("did-start-navigation", (_e, _url, inPage, mainFrame) => { if (mainFrame && !inPage) tab.favicon = null; });
    wc.on("dom-ready", () => {
      const zoom = Number(this.profile.settings.data.appearance.zoom) || 1;
      if (!tab.zoomed && wc.getZoomFactor() !== zoom) wc.setZoomFactor(zoom);
    });
    for (const event of ["did-start-loading", "did-stop-loading", "did-navigate-in-page"]) wc.on(event, () => this.publish());
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    wc.loadURL(toUrl(url, this.profile));
    if (activate) this.activateTab(tab.id);
    this.publish();
    return tab;
  }

  activateTab(id) {
    if (!this.tabs.has(id)) return;
    for (const tab of this.tabs.values()) tab.view.setVisible(false);
    this.activeId = id;
    this.layout();
    this.publish();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    if (tab.private && ![...this.tabs.values()].some((t) => t.private)) {
      session.fromPartition(`jev-private-${this.profile.id}`).clearStorageData();
    }
    if (this.activeId === id) {
      const rest = [...this.tabs.keys()];
      if (rest.length) this.activateTab(rest[rest.length - 1]);
      else this.createTab(this.profile.settings.data.homepage);
    }
    this.publish();
  }

  zoom(delta) {
    const tab = this.tabs.get(this.activeId);
    if (!tab) return;
    tab.zoomed = true;
    const wc = tab.view.webContents;
    wc.setZoomFactor(delta === 0 ? 1 : Math.min(3, Math.max(0.3, wc.getZoomFactor() + delta)));
    this.publish();
  }

  active() { return this.tabs.get(this.activeId)?.view.webContents; }
}

function windowForContents(wc) {
  for (const w of windows.values()) {
    if (w.ui.webContents === wc) return w;
    for (const tab of w.tabs.values()) if (tab.view.webContents === wc) return w;
  }
  return null;
}

function openProfile(id) {
  const existing = [...windows.values()].find((w) => w.profile.id === id);
  if (existing) { existing.win.focus(); return existing; }
  return new BrowserWin(id);
}

const focused = () => [...windows.values()].find((w) => w.win.isFocused()) || [...windows.values()].pop();

function toUrl(input, p) {
  const text = String(input || "").trim();
  if (!text) return p.settings.data.homepage;
  if (/^(https?|file):\/\//i.test(text) || text.startsWith("about:")) return text;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(text)) return `http://${text}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  return (SEARCH[p.settings.data.searchEngine] || SEARCH.duckduckgo) + encodeURIComponent(text);
}

// ---------- downloads (per profile) ----------
const downloads = new Map();
let nextDownload = 1;
function trackDownloads(p, ses) {
  ses.on("will-download", (_event, item) => {
    const opts = p.settings.data.downloads;
    const dir = opts.dir || app.getPath("downloads");
    const record = { id: nextDownload++, profile: p.id, name: item.getFilename() || "download", path: "",
                     url: item.getURL(), received: 0, total: item.getTotalBytes(), state: "progressing" };
    if (!opts.ask) {
      fs.mkdirSync(dir, { recursive: true }); // minimal Linux installs may not have ~/Downloads yet
      const parsed = path.parse(record.name);
      let name = parsed.base;
      for (let n = 1; fs.existsSync(path.join(dir, name)); n++) name = `${parsed.name} (${n})${parsed.ext}`;
      record.name = name;
      record.path = path.join(dir, name);
      item.setSavePath(record.path);
    } // with "ask", Chromium shows its own save dialog
    downloads.set(record.id, { record, item });
    const update = () => {
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.path = item.getSavePath() || record.path;
      if (record.path) record.name = path.basename(record.path);
      const list = [...downloads.values()].map((d) => d.record).filter((r) => r.profile === p.id);
      for (const w of windows.values()) if (w.profile.id === p.id) w.send("downloads", list);
    };
    item.on("updated", (_e, state) => { record.state = state === "interrupted" ? "interrupted" : "progressing"; update(); });
    item.once("done", (_e, state) => { record.state = state; update(); });
    update();
  });
}

async function clearData(p, { history = false, cookies = false, cache = false, chats = false, all = false } = {}) {
  const ses = session.fromPartition(p.partition);
  if (all || cookies) await ses.clearStorageData();
  if (all || cache) await ses.clearCache();
  if (all || history) p.library.clearHistory();
  if (all || chats) p.sessions.clear();
}

// ---------- practice shop for the first guided task (loopback only, one page) ----------
function startPractice() {
  const page = fs.readFileSync(path.join(__dirname, "practice", "index.html"));
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || !["/", "/index.html"].includes(req.url.split("?")[0])) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page);
  });
  server.listen(0, "127.0.0.1", () => { practiceUrl = `http://127.0.0.1:${server.address().port}/`; });
}

// ---------- model, automatic setup, agent services, updates ----------
const modelsDir = path.join(userData, "models");
const agentDir = app.isPackaged ? path.join(process.resourcesPath, "agent") : path.resolve(__dirname, "..");
const venvDir = app.isPackaged ? path.join(userData, "agent-env") : null;
const setup = new Setup({ dir: path.join(userData, "runtime"), agentDir, venvDir, log: (l) => console.log(l) });
const resolved = new Map(); // catalog id -> entry with size and SHA-256 from the Hub
function chosenModel() {
  const a = appStore.data.agent;
  if (a.model === "custom") return { id: "custom", name: path.basename(a.customModel || "Custom model"), file: a.customModel };
  return resolved.get(a.model) || CATALOG.find((m) => m.id === a.model) || CATALOG[0];
}
function modelPath() {
  const m = chosenModel();
  if (m.id === "custom") return m.file && fs.existsSync(m.file) ? m.file : null;
  return findModel(modelsDir, m);
}

let services, updater;
const broadcast = (channel, payload) => { for (const w of windows.values()) w.send(channel, payload); };

let setupJob = null;
function runSetup() {
  if (setupJob) return setupJob;
  const step = (id, label, extra = {}) => broadcast("setup-progress", { step: id, label, ...extra });
  setupJob = (async () => {
    try {
      if (!setup.uv()) {
        step("uv", "Downloading the Python runtime (uv)…");
        await setup.installUv((p) => step("uv", "Downloading the Python runtime (uv)…", p));
      }
      if (appStore.data.agent.mode !== "hosted") {
        if (!setup.llama()) {
          if (!setup.llamaProblem()) {
            step("llama", "Downloading the model runtime (llama.cpp)…");
            await setup.installLlama((p) => step("llama", "Downloading the model runtime (llama.cpp)…", p));
          }
          if (setup.llamaProblem()) {
            step("libs", "Adding a library llama.cpp needs…");
            await setup.installSystemLibraries();
          }
          if (!setup.llama()) throw new Error(`llama.cpp cannot start: ${setup.llamaProblem() || "unknown error"}`);
        }
        if (!modelPath()) {
          const m = await resolveModel(chosenModel());
          resolved.set(m.id, m);
          step("model", `Downloading ${m.name}…`);
          await downloadModel(modelsDir, (p) => step("model", `Downloading ${m.name}…`, p), { model: m });
        }
      }
      step("agent", "Preparing the agent (first time only)…");
      await setup.prepareAgent((line) => step("agent", "Preparing the agent (first time only)…", { line }));
      step("done", "Everything is set up.", { done: true });
      return true;
    } catch (error) {
      step("error", error.message, { error: error.message });
      return false;
    } finally {
      setupJob = null;
    }
  })();
  return setupJob;
}

let starting = null;
function startServices() {
  if (services.state.agent === "ready") return services.state;
  const local = appStore.data.agent.mode !== "hosted";
  if ((local && (!modelPath() || !setup.llama())) || !setup.uv()) {
    services.set({ model: "missing", detail: "Setup is not finished. Open Settings → Model and press Set up." });
    return services.state;
  }
  starting ??= services.start(appStore.data, { modelPath: modelPath() })
    .catch((error) => services.set({ detail: error.message })).finally(() => { starting = null; });
  return services.state;
}
function restartServices() {
  services.stop();
  services.set({ model: "stopped", agent: "stopped", detail: "Restarting…", accelerator: "" });
  setTimeout(startServices, 1500);
  return services.state;
}

// ---------- IPC (from browser UI views only) ----------
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const win = windows.get(event.sender.id);
    if (!win) throw new Error("Not allowed");
    return fn(win, ...args);
  });
}
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

function saveProfile(win, patch) {
  const store = win.profile.settings;
  store.data = merge(store.data, patch);
  store.save();
  const ses = session.fromPartition(win.profile.partition);
  ses.setSpellCheckerEnabled(!!store.data.languages.spellcheck);
  try { ses.setSpellCheckerLanguages(store.data.languages.languages); } catch { /* unavailable */ }
  for (const w of windows.values()) if (w.profile.id === win.profile.id) w.send("settings", w.settings());
  return win.settings();
}
function saveApp(patch) {
  appStore.data = merge(appStore.data, patch);
  appStore.save();
  for (const w of windows.values()) w.send("settings", w.settings());
  return appStore.data;
}

function wireIpc() {
  handle("tabs:new", (w, url, opts = {}) => w.createTab(url || w.profile.settings.data.homepage, { isPrivate: !!opts.private }).id);
  handle("tabs:close", (w, id) => w.closeTab(id));
  handle("tabs:activate", (w, id) => w.activateTab(id));
  handle("nav:go", (w, input) => w.active()?.loadURL(toUrl(input, w.profile)));
  handle("nav:back", (w) => w.active()?.navigationHistory.goBack());
  handle("nav:forward", (w) => w.active()?.navigationHistory.goForward());
  handle("nav:reload", (w) => w.active()?.reload());
  handle("nav:home", (w) => w.active()?.loadURL(w.profile.settings.data.homepage));
  handle("nav:zoom", (w, delta) => w.zoom(Number(delta) || 0));
  handle("ui:panel", (w, open) => { w.panelOpen = !!open; w.layout(); return w.panelOpen; });
  handle("ui:overlay", (w, on) => { w.overlay = !!on; w.layout(); });
  handle("ui:theme", (_w, theme) => { nativeTheme.themeSource = ["light", "dark"].includes(theme) ? theme : "system"; });

  handle("settings:get", (w) => w.settings());
  handle("settings:setProfile", (w, patch) => saveProfile(w, patch));
  handle("settings:setApp", (_w, patch) => saveApp(patch));
  handle("settings:resetProfile", (w) => {
    w.profile.settings.data = merge(PROFILE_DEFAULTS, { lastTabs: w.profile.settings.data.lastTabs });
    w.profile.settings.save(true);
    return saveProfile(w, {});
  });
  handle("settings:pickFolder", async (w) => {
    const result = await dialog.showOpenDialog(w.win, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("settings:pickModel", async (w) => {
    const result = await dialog.showOpenDialog(w.win, { properties: ["openFile"],
                                                        filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("settings:clearData", (w, opts) => clearData(w.profile, opts || {}));
  handle("browser:isDefault", () => app.isDefaultProtocolClient("https"));
  handle("browser:makeDefault", () => app.setAsDefaultProtocolClient("http") && app.setAsDefaultProtocolClient("https"));
  handle("app:info", () => ({ version: app.getVersion(), electron: process.versions.electron,
                              chrome: process.versions.chrome, platform: `${process.platform} ${process.arch}`,
                              dataDir: userData }));
  handle("app:relaunch", () => { app.relaunch(); app.quit(); });

  handle("permission:answer", (_w, id, allow, remember) => {
    const pending = pendingPermissions.get(id);
    if (!pending) return;
    pendingPermissions.delete(id);
    if (remember) {
      const s = pending.profile.settings;
      s.data.sitePermissions[pending.origin] = { ...s.data.sitePermissions[pending.origin],
                                                 [pending.key]: allow ? "allow" : "block" };
      s.save();
    }
    pending.callback(!!allow);
  });
  handle("permission:forget", (w, origin) => {
    delete w.profile.settings.data.sitePermissions[origin];
    w.profile.settings.save();
    return saveProfile(w, {});
  });

  handle("profiles:list", () => appStore.data.profiles);
  handle("profiles:create", (_w, name, color) => {
    const id = `p${Date.now().toString(36)}`;
    appStore.data.profiles.push({ id, name: String(name || "New profile").slice(0, 40), color: color || "#6b4fbb" });
    appStore.save(true);
    broadcast("profiles", appStore.data.profiles);
    openProfile(id);
    return id;
  });
  handle("profiles:rename", (_w, id, name, color) => {
    const p = profileInfo(id);
    if (p) { p.name = String(name || p.name).slice(0, 40); if (color) p.color = color; appStore.save(true); }
    broadcast("profiles", appStore.data.profiles);
  });
  handle("profiles:open", (_w, id) => { if (profileInfo(id)) openProfile(id); });
  handle("profiles:googleSignIn", (w) => w.createTab("https://accounts.google.com/ServiceLogin?continue=" +
    encodeURIComponent("https://myaccount.google.com/")).id);
  handle("profiles:googleSignOut", (w) => {
    w.createTab("https://accounts.google.com/Logout");
    setTimeout(() => refreshGoogleAccount(w.profile), 4000);
  });
  handle("profiles:refreshAccount", (w) => refreshGoogleAccount(w.profile).then(() => profileInfo(w.profile.id)?.google || null));
  handle("profiles:remove", async (_w, id) => {
    if (id === "default" || !profileInfo(id)) throw new Error("The first profile cannot be removed.");
    for (const w of [...windows.values()]) if (w.profile.id === id) w.win.close();
    await session.fromPartition(profile(id).partition).clearStorageData();
    appStore.data.profiles = appStore.data.profiles.filter((p) => p.id !== id);
    if (appStore.data.lastProfile === id) appStore.data.lastProfile = "default";
    appStore.save(true);
    fs.rmSync(path.join(userData, "profiles", id), { recursive: true, force: true });
    profiles.delete(id);
    broadcast("profiles", appStore.data.profiles);
  });

  handle("library:bookmark", (w) => {
    const wc = w.active();
    const added = wc ? w.profile.library.toggleBookmark(wc.getURL(), wc.getTitle()) : false;
    w.publish();
    return added;
  });
  handle("library:bookmarks", (w) => w.profile.library.bookmarks.data);
  handle("library:removeBookmark", (w, url) => { w.profile.library.removeBookmark(url); w.publish(); });
  handle("library:history", (w, query) => w.profile.library.searchHistory(query));
  handle("library:clearHistory", (w) => w.profile.library.clearHistory());
  handle("library:sites", (w) => w.profile.library.sites.data);
  handle("library:setSite", (w, origin, value) => w.profile.library.setSite(origin, value));
  handle("downloads:list", (w) => [...downloads.values()].map((d) => d.record).filter((r) => r.profile === w.profile.id));
  handle("downloads:open", (_w, id) => downloads.get(id)?.record.state === "completed" &&
    shell.openPath(downloads.get(id).record.path));
  handle("downloads:show", (_w, id) => downloads.has(id) && shell.showItemInFolder(downloads.get(id).record.path));
  handle("downloads:cancel", (_w, id) => downloads.get(id)?.item.cancel());

  handle("sessions:list", (w) => w.profile.sessions.list());
  handle("sessions:get", (w, id) => w.profile.sessions.get(id));
  handle("sessions:create", (w) => w.profile.sessions.create());
  handle("sessions:append", (w, id, message) => { w.profile.sessions.append(id, message); });
  handle("sessions:rename", (w, id, title) => w.profile.sessions.rename(id, title));
  handle("sessions:remove", (w, id) => w.profile.sessions.remove(id));
  handle("sessions:clear", (w) => w.profile.sessions.clear());

  handle("system:check", () => system.check({ dataDir: userData, modelPath: modelPath(),
                                               modelSize: chosenModel().size || 1.2e9,
                                               budgetMb: appStore.data.agent.budgetMb, setup }));
  handle("setup:run", () => runSetup());
  handle("setup:status", () => ({ uv: setup.uv(), llama: setup.llama(), llamaProblem: setup.llamaProblem(),
                                  build: setup.saved.llamaBuild || null, model: modelPath(), running: !!setupJob }));
  handle("model:catalog", () => CATALOG.map((m) => {
    const entry = { ...m, ...(resolved.get(m.id) || {}) };
    return { ...entry, path: findModel(modelsDir, entry) };
  }));
  handle("model:info", () => ({ ...chosenModel(), path: modelPath(), downloading: !!setupJob }));

  handle("services:get", () => services.state);
  handle("services:start", () => startServices());
  handle("services:restart", () => restartServices());
  handle("practice:open", (w) => practiceUrl && w.createTab(practiceUrl).id);
  handle("agent:run", async (w, goal, { once = false } = {}) => {
    const url = w.active()?.getURL() || "";
    if (!/^https?:/.test(url)) throw new Error("Open a web page in this tab first.");
    const origin = originOf(url);
    const permission = url.startsWith(practiceUrl || "\0") ? "allow" : w.profile.library.site(origin);
    if (permission === "block") throw new Error(`The agent is blocked on ${origin}. Change it in Settings → Agent.`);
    if (!permission && !once) return { needsPermission: origin };
    return services.request("POST", "/api/run", { goal, url });
  });
  handle("agent:events", (_w, since) => services.request("GET", `/api/events?since=${Number(since) || 0}`));
  handle("agent:stop", () => services.request("POST", "/api/stop", {}));
  handle("agent:confirm", (_w, allow) => services.request("POST", "/api/confirm", { allow: allow === true }));

  handle("update:check", () => updater.check());
  handle("update:download", () => updater.download());
  handle("update:install", async () => {
    const result = await updater.install({ shell });
    if (result === "relaunch") { app.relaunch(); app.quit(); }
    return result;
  });
  handle("update:state", () => updater.state);
  handle("shell:open", (_w, url) => /^https:\/\//.test(url) && shell.openExternal(url));
}

// ---------- menu ----------
function buildMenu() {
  const command = (name) => () => focused()?.send("command", name);
  const w = () => focused();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => w()?.createTab(w().profile.settings.data.homepage) },
      { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => new BrowserWin(w()?.profile.id || "default") },
      { label: "New Private Tab", accelerator: "Shift+CmdOrCtrl+N",
        click: () => w()?.createTab(w().profile.settings.data.homepage, { isPrivate: true }) },
      { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => w()?.closeTab(w().activeId) },
      { label: "Open Location", accelerator: "CmdOrCtrl+L", click: command("focus-omnibox") },
      { type: "separator" },
      { label: "Bookmark This Page", accelerator: "CmdOrCtrl+D", click: () => {
        const win = w(); const wc = win?.active();
        if (wc) win.profile.library.toggleBookmark(wc.getURL(), wc.getTitle());
        win?.publish();
      } },
      { label: "History", accelerator: "CmdOrCtrl+Y", click: command("library") },
      { label: "Settings", accelerator: "CmdOrCtrl+,", click: command("settings") },
      { label: "Check for Updates…", click: command("updates") },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => w()?.active()?.reload() },
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => w()?.active()?.navigationHistory.goBack() },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => w()?.active()?.navigationHistory.goForward() },
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => w()?.zoom(0.1) },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => w()?.zoom(-0.1) },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => w()?.zoom(0) },
      { label: "Agent Panel", accelerator: "CmdOrCtrl+J", click: command("toggle-agent") },
      { type: "separator" },
      { label: "Developer Tools for Page", accelerator: "Alt+CmdOrCtrl+I", click: () => w()?.active()?.openDevTools() },
    ] },
    { role: "windowMenu" },
  ]));
}

// ---------- app ----------
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_event, argv) => {
  const target = focused() || openProfile(appStore.data.lastProfile);
  const url = argv.find((a) => /^https?:\/\//.test(a));
  if (url) target.createTab(url);
  target.win.focus();
});
app.on("open-url", (event, url) => { event.preventDefault(); focused()?.createTab(url); });

app.whenReady().then(() => {
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
  migrateLegacy();
  startPractice();
  services = new Services({
    cdpPort: CDP_PORT, log: (line) => console.log(line), agentDir, venvDir,
    runtime: () => ({ uv: setup.uv(), llama: setup.llama(), libPath: setup.saved.libPath }),
  });
  services.onChange((state) => broadcast("services", state));
  updater = new Updater({ version: app.getVersion(), dir: path.join(userData, "updates"), log: (l) => console.log(l) });
  updater.onChange((state) => broadcast("update", state));
  wireIpc();
  buildMenu();
  const startId = profileInfo(appStore.data.lastProfile) ? appStore.data.lastProfile : "default";
  const first = openProfile(startId);
  nativeTheme.themeSource = first.profile.settings.data.appearance.theme || "system";
  const url = process.argv.find((a) => /^https?:\/\//.test(a));
  if (url) first.ui.webContents.once("did-finish-load", () => first.createTab(url));
  if (appStore.data.onboarded && appStore.data.agent.autostart) setTimeout(startServices, 500);
  if (appStore.data.update.autoCheck && app.isPackaged) setTimeout(() => updater.check(), 15000);
});

app.on("before-quit", () => {
  for (const w of windows.values()) w.rememberTabs();
  for (const p of profiles.values()) { p.library.flush(); p.sessions.flush(); p.settings.save(true); }
  appStore.save(true);
  services?.stop();
});
app.on("window-all-closed", () => app.quit());
