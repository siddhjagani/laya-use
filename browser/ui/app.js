// Browser UI: tabs, toolbar, agent chat, library, settings and onboarding. Talks to main only via window.jev.
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
let tabs = [];
let settings = null;
let since = 0;
let polling = null;
let services = { agent: "stopped", model: "stopped", detail: "" };
const human = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB`
  : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} bytes`;
const clean = (message) => String(message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// ---------- tabs and toolbar ----------
function renderTabs() {
  $("tabs").replaceChildren(...tabs.map((tab) => {
    const node = el("div", { className: `tab${tab.active ? " active" : ""}${tab.private ? " private" : ""}`,
                             title: tab.title });
    node.setAttribute("role", "tab");
    if (tab.loading) node.append(el("span", { className: "spin" }));
    else if (tab.private) node.append(el("span", { className: "mask", textContent: "🕶" }));
    node.append(el("span", { className: "title", textContent: tab.title }));
    const close = el("button", { className: "close", textContent: "✕", ariaLabel: "Close tab" });
    close.addEventListener("click", (event) => { event.stopPropagation(); jev.tabs.close(tab.id); });
    node.append(close);
    node.addEventListener("click", () => jev.tabs.activate(tab.id));
    node.addEventListener("auxclick", (event) => event.button === 1 && jev.tabs.close(tab.id));
    return node;
  }));
  const current = tabs.find((tab) => tab.active);
  if (!current) return;
  if (document.activeElement !== $("omnibox")) $("omnibox").value = current.url;
  $("back").disabled = !current.canGoBack;
  $("forward").disabled = !current.canGoForward;
  $("star").textContent = current.bookmarked ? "★" : "☆";
  $("star").classList.toggle("on", current.bookmarked);
  $("star").disabled = !/^https?:/.test(current.url);
  $("private-badge").hidden = !current.private;
  document.body.classList.toggle("private", current.private);
}

jev.tabs.onChange((list) => { tabs = list; renderTabs(); });
$("new-tab").addEventListener("click", () => jev.tabs.create());
$("back").addEventListener("click", () => jev.nav.back());
$("forward").addEventListener("click", () => jev.nav.forward());
$("reload").addEventListener("click", () => jev.nav.reload());
$("star").addEventListener("click", () => jev.library.bookmark());
$("omnibox-form").addEventListener("submit", (event) => {
  event.preventDefault();
  jev.nav.go($("omnibox").value);
  $("omnibox").blur();
});
$("omnibox").addEventListener("focus", () => $("omnibox").select());

// ---------- overlays ----------
const overlays = ["library", "settings", "onboarding"];
function openOverlay(id, open) {
  for (const other of overlays) if (other !== id && open) $(other).hidden = true;
  $(id).hidden = !open;
  jev.ui.overlay(overlays.some((name) => !$(name).hidden));
}
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () =>
  openOverlay(button.closest(".overlay").id, false)));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const id of ["library", "settings"]) if (!$(id).hidden) openOverlay(id, false);
});

// ---------- agent panel ----------
function setPanel(open) {
  $("agent").hidden = !open;
  $("toggle-agent").classList.toggle("on", open);
  jev.ui.panel(open);
}
$("toggle-agent").addEventListener("click", () => setPanel($("agent").hidden));

function add(kind, text) {
  const node = el("div", { className: `msg ${kind === "status" ? "info" : kind}`, textContent: text }); // text only
  $("log").append(node);
  $("log").scrollTop = $("log").scrollHeight;
}

function ask(text, buttons) {
  $("prompt-text").textContent = text;
  $("prompt-actions").replaceChildren(...buttons.map(([label, cls, onClick]) => {
    const button = el("button", { className: cls, textContent: label });
    button.addEventListener("click", () => { $("prompt").hidden = true; onClick(); });
    return button;
  }));
  $("prompt").hidden = false;
}

function showServices(state) {
  services = state;
  const ready = state.agent === "ready";
  const starting = !ready && (state.model === "starting" || (state.model === "ready" && state.agent !== "failed"));
  const label = ready ? "ready" : starting ? "starting" : state.model === "missing" ? "no model"
    : state.agent === "failed" || state.model === "failed" ? "error" : "offline";
  if (!polling) {
    $("agent-status").textContent = label;
    $("agent-status").className = `status ${ready ? "ready" : starting ? "busy" : ""}`;
    $("send").disabled = !ready;
  }
  $("agent-detail").textContent = ready ? "" : state.detail || "";
}
jev.services.onChange(showServices);
jev.services.get().then(showServices);

function busy(on) {
  $("send").disabled = on;
  $("goal").disabled = on;
  $("stop").hidden = !on;
  $("agent-status").textContent = on ? "working" : "ready";
  $("agent-status").className = `status ${on ? "busy" : "ready"}`;
  if (!on) $("prompt").hidden = true;
}

async function poll() {
  try {
    const data = await jev.agent.events(since);
    for (const event of data.events) {
      since = event.n + 1;
      if (event.kind === "confirm") {
        add("info", event.text);
        ask(event.text, [
          ["Allow", "primary", () => jev.agent.confirm(true)],
          ["Don't allow", "", () => jev.agent.confirm(false)],
        ]);
      } else add(event.kind, event.text);
    }
    if (!data.busy) { clearInterval(polling); polling = null; busy(false); }
  } catch (error) {
    clearInterval(polling); polling = null; busy(false);
    add("error", `Lost the agent: ${clean(error.message)}`);
  }
}

async function run(goal, opts) {
  try {
    const result = await jev.agent.run(goal, opts);
    if (result?.needsPermission) {
      const origin = result.needsPermission;
      ask(`Let the agent work on ${origin}?`, [
        ["Always on this site", "primary", async () => { await jev.library.setSite(origin, "allow"); run(goal); }],
        ["Only this time", "", () => run(goal, { once: true })],
        ["Never", "", async () => { await jev.library.setSite(origin, "block"); add("info", `Blocked on ${origin}.`); }],
      ]);
      return;
    }
    since = 0;
    busy(true);
    polling = setInterval(poll, 300);
  } catch (error) {
    add("error", clean(error.message));
  }
}

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const goal = $("goal").value.trim();
  if (!goal) return;
  add("you", goal);
  $("goal").value = "";
  run(goal);
});
$("goal").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("ask").requestSubmit(); }
});
$("stop").addEventListener("click", () => jev.agent.stop());

// ---------- library ----------
function row({ title, url, meta, actions = [], onOpen }) {
  const li = el("li");
  const grow = el("div", { className: "grow" });
  const link = el("a", { className: "t", textContent: title || url });
  link.addEventListener("click", onOpen);
  grow.append(link, el("div", { className: "u", textContent: meta ? `${meta} · ${url}` : url }));
  li.append(grow);
  for (const [label, onClick] of actions) {
    const button = el("button", { textContent: label });
    button.addEventListener("click", onClick);
    li.append(button);
  }
  return li;
}
const empty = (text) => el("li", { className: "empty", textContent: text });
const openUrl = (url) => () => { openOverlay("library", false); jev.nav.go(url); };

async function renderBookmarks() {
  const list = await jev.library.bookmarks();
  $("bookmark-list").replaceChildren(...(list.length ? list.map((b) => row({
    title: b.title, url: b.url, onOpen: openUrl(b.url),
    actions: [["Remove", async () => { await jev.library.removeBookmark(b.url); renderBookmarks(); }]],
  })) : [empty("No bookmarks yet. Click ☆ in the address bar to add one.")]));
}
async function renderHistory() {
  const list = await jev.library.history($("history-search").value);
  $("history-list").replaceChildren(...(list.length ? list.map((h) => row({
    title: h.title, url: h.url, meta: new Date(h.at).toLocaleString(), onOpen: openUrl(h.url),
  })) : [empty("No history.")]));
}
function renderDownloads(list) {
  $("download-list").replaceChildren(...(list.length ? list.slice().reverse().map((d) => {
    const status = d.state === "completed" ? human(d.total || d.received)
      : d.state === "progressing" ? `${human(d.received)}${d.total ? ` of ${human(d.total)}` : ""}` : d.state;
    const actions = d.state === "completed" ? [["Open", () => jev.downloads.open(d.id)], ["Show", () => jev.downloads.show(d.id)]]
      : d.state === "progressing" ? [["Cancel", () => jev.downloads.cancel(d.id)]] : [];
    return row({ title: d.name, url: d.url, meta: status, actions, onOpen: () => jev.downloads.show(d.id) });
  }) : [empty("No downloads in this session.")]));
}
jev.downloads.onChange(renderDownloads);
function showPane(name) {
  document.querySelectorAll("#library .seg button").forEach((b) => b.classList.toggle("on", b.dataset.pane === name));
  document.querySelectorAll("#library .pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === "bookmarks") renderBookmarks();
  if (name === "history") renderHistory();
  if (name === "downloads") jev.downloads.list().then(renderDownloads);
}
document.querySelectorAll("#library .seg button").forEach((b) => b.addEventListener("click", () => showPane(b.dataset.pane)));
$("history-search").addEventListener("input", renderHistory);
$("clear-history").addEventListener("click", async () => { await jev.library.clearHistory(); renderHistory(); });
function openLibrary(pane = "bookmarks") { openOverlay("library", true); showPane(pane); }
$("open-library").addEventListener("click", () => openLibrary());

// ---------- settings ----------
async function renderSites() {
  const sites = Object.entries(await jev.library.sites());
  $("site-list").replaceChildren(...(sites.length ? sites.map(([origin, value]) => {
    const li = el("li");
    li.append(el("div", { className: "grow", textContent: `${origin} · agent ${value === "allow" ? "allowed" : "blocked"}` }));
    const button = el("button", { textContent: "Forget" });
    button.addEventListener("click", async () => { await jev.library.setSite(origin, null); renderSites(); });
    li.append(button);
    return li;
  }) : [empty("The agent asks on each new site.")]));
}
async function renderModel() {
  const info = await jev.model.info();
  const running = services.accelerator ? ` · running on ${services.accelerator}` : "";
  $("model-line").textContent = info.path ? `${info.name}: ready (${human(info.size)})${running}`
    : info.downloading ? `${info.name}: downloading…` : `${info.name}: not downloaded`;
  $("model-download").hidden = !!info.path || info.downloading;
}
function fillSettings() {
  $("set-search").value = settings.searchEngine;
  $("set-home").value = settings.homepage;
  $("set-mode").value = settings.agent.mode;
  $("set-budget").value = String(settings.agent.budgetMb);
  $("set-device").value = settings.agent.device || "auto";
  $("set-cursor").checked = settings.agent.showCursor;
  $("set-confirm").checked = settings.agent.confirmRisky !== false;
  $("set-autostart").checked = settings.agent.autostart;
  renderSites();
  renderModel();
}
function openSettings() { fillSettings(); openOverlay("settings", true); }
$("open-settings").addEventListener("click", openSettings);
const save = () => jev.settings.set({
  searchEngine: $("set-search").value,
  homepage: /^https?:\/\//.test($("set-home").value) ? $("set-home").value : settings.homepage,
  agent: { mode: $("set-mode").value, device: $("set-device").value, budgetMb: Number($("set-budget").value),
           showCursor: $("set-cursor").checked,
           confirmRisky: $("set-confirm").checked, autostart: $("set-autostart").checked },
});
["set-search", "set-home", "set-mode", "set-device", "set-budget", "set-cursor", "set-confirm", "set-autostart"]
  .forEach((id) =>
  $(id).addEventListener("change", save));
$("settings-clear-history").addEventListener("click", async () => {
  await jev.library.clearHistory();
  $("settings-clear-history").textContent = "History cleared";
});
$("model-download").addEventListener("click", () => { jev.model.download(); renderModel(); });
jev.settings.onChange((next) => { settings = next; });

// ---------- onboarding ----------
let step = 1;
const chosenMode = () => document.querySelector("#onboarding input[name=mode]:checked").value;
function showStep(n) {
  step = n;
  document.querySelectorAll("#onboarding .step").forEach((node) => { node.hidden = Number(node.dataset.step) !== n; });
  document.querySelectorAll("#onboarding .dots li").forEach((dot, i) => dot.classList.toggle("on", i < n));
  if (n === 3) runChecks();
}
async function runChecks() {
  const result = await jev.system.check();
  const local = chosenMode() === "local";
  const items = result.items.filter((item) => local || !["llama", "accelerator", "model", "disk"].includes(item.id));
  $("check-list").replaceChildren(...items.map((item) => {
    const li = el("li", { className: item.ok ? "ok" : item.optional ? "" : "bad" });
    li.append(el("span", { className: "mark", textContent: item.ok ? "✓" : item.optional ? "•" : "!" }),
              el("span", { textContent: item.label }), el("span", { className: "help", textContent: item.help }));
    return li;
  }));
  const needsModel = local && !result.modelPath;
  $("download-box").hidden = !needsModel;
  const blocking = items.some((item) => !item.ok && !item.optional);
  $("check-next").disabled = blocking || needsModel;
}
jev.model.onProgress((progress) => {
  if (progress.error) {
    $("download-text").textContent = progress.error;
    $("download-start").hidden = false;
    $("download-cancel").hidden = true;
    return;
  }
  if (progress.done) {
    $("download-fill").style.width = "100%";
    $("download-text").textContent = "Model ready.";
    $("download-cancel").hidden = true;
    if (step === 3) runChecks();
    renderModel();
    return;
  }
  const pct = Math.floor((progress.received / progress.total) * 100);
  $("download-fill").style.width = `${pct}%`;
  $("download-text").textContent = progress.verifying ? "Checking the file…"
    : `${human(progress.received)} of ${human(progress.total)} (${pct}%)`;
});
$("download-start").addEventListener("click", () => {
  $("download-start").hidden = true;
  $("download-cancel").hidden = false;
  $("download-text").textContent = "Starting…";
  jev.model.download();
});
$("download-cancel").addEventListener("click", () => {
  jev.model.cancel();
  $("download-start").hidden = false;
  $("download-cancel").hidden = true;
});
document.querySelectorAll("#onboarding [data-next]").forEach((b) => b.addEventListener("click", () => showStep(step + 1)));
document.querySelectorAll("#onboarding [data-back]").forEach((b) => b.addEventListener("click", () => showStep(step - 1)));
document.querySelector("#onboarding [data-finish]").addEventListener("click", async () => {
  settings = await jev.settings.set({ onboarded: true, agent: { mode: chosenMode() } });
  openOverlay("onboarding", false);
  jev.services.start();
  await jev.practice.open();
  setPanel(true);
  $("goal").value = "Find an in-stock notebook and order it";
  add("info", "This is a practice shop. Press Send to watch the agent work; it will ask before placing the order.");
});

// ---------- menu commands (shortcuts live in the app menu) ----------
jev.onCommand((name) => {
  if (name === "focus-omnibox") $("omnibox").focus();
  if (name === "toggle-agent") setPanel($("agent").hidden);
  if (name === "settings") openSettings();
  if (name === "library") openLibrary("history");
});

document.body.classList.add(`os-${new URLSearchParams(location.search).get("platform") || "unknown"}`);

jev.settings.get().then((value) => {
  settings = value;
  if (!settings.onboarded) { showStep(1); openOverlay("onboarding", true); }
});
setPanel(true);
