// Browser UI: tabs, toolbar, agent chats, library, profiles, settings, setup and updates. Talks to main via window.jev.
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
let tabs = [];
let cfg = null; // { app, profile, profileId }
let services = { agent: "stopped", model: "stopped", detail: "", accelerator: "" };
let profiles = [];
let session = null; // current agent chat id
let since = 0;
let polling = null;
let step = 1;
const human = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB`
  : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} bytes`;
const clean = (message) => String(message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const get = (obj, key) => key.split(".").reduce((o, k) => o?.[k], obj);
const patchOf = (key, value) => key.split(".").reverse().reduce((acc, k) => ({ [k]: acc }), value);
const initials = (name) => (name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const thisProfile = () => profiles.find((p) => p.id === cfg?.profileId) || { name: "Personal", color: "#2f5d46" };

// ---------- tabs and toolbar ----------
function renderTabs() {
  $("tabs").replaceChildren(...tabs.map((tab) => {
    const node = el("div", { className: `tab${tab.active ? " active" : ""}${tab.private ? " private" : ""}`, title: tab.title });
    node.setAttribute("role", "tab");
    if (tab.loading) node.append(el("span", { className: "spin" }));
    else if (tab.private) node.append(Object.assign(icon("incognito", 16), { classList: "i fav" }));
    else if (tab.favicon) {
      const img = el("img", { className: "fav", src: tab.favicon, alt: "" });
      img.addEventListener("error", () => img.replaceWith(Object.assign(icon("globe", 15), { classList: "i fav" })));
      node.append(img);
    } else node.append(Object.assign(icon("page", 15), { classList: "i fav" }));
    node.append(el("span", { className: "title", textContent: tab.title }));
    const close = el("button", { className: "close", ariaLabel: "Close tab", title: "Close tab" }, icon("close", 12));
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
  $("star").classList.toggle("on", current.bookmarked);
  $("star").title = current.bookmarked ? "Remove bookmark" : "Bookmark this page (Ctrl+D)";
  const secure = /^https:/.test(current.url) || /^http:\/\/127\.0\.0\.1/.test(current.url);
  $("site-icon").replaceChildren(icon(secure ? "lock" : "globe", 14));
  $("site-icon").title = secure ? "Connection is secure" : "Connection is not secure";
  $("star").disabled = !/^https?:/.test(current.url);
  $("private-badge").hidden = !current.private;
  $("zoom-badge").hidden = current.zoom === 100;
  $("zoom-badge").textContent = `${current.zoom}%`;
  document.body.classList.toggle("private", current.private);
}
jev.tabs.onChange((list) => { tabs = list; renderTabs(); });
$("new-tab").addEventListener("click", () => jev.tabs.create());
$("back").addEventListener("click", () => jev.nav.back());
$("forward").addEventListener("click", () => jev.nav.forward());
$("reload").addEventListener("click", () => jev.nav.reload());
$("home").addEventListener("click", () => jev.nav.home());
$("star").addEventListener("click", () => jev.library.bookmark());
$("zoom-badge").addEventListener("click", () => jev.nav.zoom(0));
$("omnibox-form").addEventListener("submit", (event) => {
  event.preventDefault();
  jev.nav.go($("omnibox").value);
  $("omnibox").blur();
});
$("omnibox").addEventListener("focus", () => $("omnibox").select());

// ---------- overlays ----------
const overlays = ["library", "settings", "onboarding", "profiles", "permission"];
function openOverlay(id, open) {
  for (const other of overlays) if (other !== id && open) $(other).hidden = true;
  $(id).hidden = !open;
  jev.ui.overlay(overlays.some((name) => !$(name).hidden));
}
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () =>
  openOverlay(button.closest(".overlay").id, false)));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const id of ["library", "settings", "profiles"]) if (!$(id).hidden) openOverlay(id, false);
});

// ---------- agent panel and chats ----------
function setPanel(open) {
  $("agent").hidden = !open;
  $("toggle-agent").classList.toggle("on", open);
  jev.ui.panel(open);
}
$("toggle-agent").addEventListener("click", () => setPanel($("agent").hidden));
$("close-agent").addEventListener("click", () => setPanel(false));
$("goal").addEventListener("input", () => {
  $("goal").style.height = "auto";
  $("goal").style.height = `${Math.min(140, $("goal").scrollHeight)}px`;
});

const MESSAGE_ICON = { step: "check", final: "check", error: "alert" };
function renderMessage(kind, text) {
  if (kind === "thinking") {
    if (!cfg?.app.agent.showThinking) return;
    $("log").append(el("details", { className: "thinking" }, el("summary", {}, icon("bulb", 14), "Thinking"),
                       el("div", { textContent: text })));
  } else if (MESSAGE_ICON[kind]) {
    $("log").append(el("div", { className: `msg ${kind}` }, icon(MESSAGE_ICON[kind], 15), el("span", { textContent: text })));
  } else {
    $("log").append(el("div", { className: `msg ${kind === "status" ? "info" : kind}`, textContent: text })); // text only
  }
  $("log").scrollTop = $("log").scrollHeight;
}

async function add(kind, text, save = true) {
  renderMessage(kind, text);
  if (!save || kind === "note") return;
  if (!session) session = (await jev.sessions.create()).id;
  await jev.sessions.append(session, { kind, text });
  if (kind === "you" && $("session-title").textContent === "New chat") $("session-title").textContent = text.slice(0, 60);
}

function intro() {
  $("log").replaceChildren();
  renderMessage("note", "Tell me what to do on this tab. I click, type, choose and scroll, and I only act on things " +
    "visible on the page. I ask before anything that buys, sends or deletes, and you can stop me at any time.");
}

function newChat() {
  session = null;
  $("session-title").textContent = "New chat";
  $("chat-list").hidden = true;
  intro();
}
$("new-chat").addEventListener("click", () => { if (!polling) newChat(); });

async function openChat(id) {
  const chat = await jev.sessions.get(id);
  if (!chat) return;
  session = chat.id;
  $("session-title").textContent = chat.title;
  $("log").replaceChildren();
  for (const m of chat.messages) renderMessage(m.kind, m.text);
  $("chat-list").hidden = true;
}

async function renderChats() {
  const q = $("chat-search").value.trim().toLowerCase();
  const list = (await jev.sessions.list()).filter((c) => !q || c.title.toLowerCase().includes(q));
  $("chats").replaceChildren(...(list.length ? list.map((c) => {
    const li = el("li", { className: c.id === session ? "current" : "" });
    const grow = el("div", { className: "grow" });
    const link = el("a", { className: "t", textContent: c.title });
    link.addEventListener("click", () => openChat(c.id));
    grow.append(link, el("div", { className: "u", textContent: `${new Date(c.updated).toLocaleString()} · ${c.count} messages` }));
    const del = el("button", { className: "icon-btn sm", title: "Delete chat", ariaLabel: "Delete chat" }, icon("trash", 15));
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      await jev.sessions.remove(c.id);
      if (c.id === session) newChat();
      renderChats();
    });
    li.addEventListener("click", () => openChat(c.id));
    li.append(grow, del);
    return li;
  }) : [el("li", { className: "empty", textContent: "No saved chats yet." })]));
}
$("show-chats").addEventListener("click", () => {
  $("chat-list").hidden = !$("chat-list").hidden;
  if (!$("chat-list").hidden) renderChats();
});
$("chat-search").addEventListener("input", renderChats);

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
  const label = ready ? "ready" : starting ? "starting" : state.model === "missing" ? "set up needed"
    : state.agent === "failed" || state.model === "failed" ? "error" : "offline";
  if (!polling) {
    $("agent-status").title = label;
    $("agent-status").className = `status-dot ${ready ? "ready" : starting ? "busy" : label === "error" ? "error" : ""}`;
    $("send").disabled = !ready;
  }
  $("agent-detail").textContent = ready ? "" : state.detail || "";
  renderModelRunning();
}
jev.services.onChange(showServices);
jev.services.get().then(showServices);

function busy(on) {
  $("send").disabled = on;
  $("goal").disabled = on;
  $("stop").hidden = !on;
  $("send").hidden = on;
  $("new-chat").disabled = on;
  $("agent-status").title = on ? "working" : "ready";
  $("agent-status").className = `status-dot ${on ? "busy" : "ready"}`;
  if (!on) $("prompt").hidden = true;
}

async function poll() {
  try {
    const data = await jev.agent.events(since);
    for (const event of data.events) {
      since = event.n + 1;
      if (event.kind === "confirm") {
        add("info", event.text);
        ask(event.text, [["Allow", "primary", () => jev.agent.confirm(true)], ["Don't allow", "", () => jev.agent.confirm(false)]]);
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
  $("goal").style.height = "auto";
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
    const button = el("button", { className: "btn", textContent: label });
    button.addEventListener("click", onClick);
    li.append(button);
  }
  return li;
}
const empty = (text) => el("li", { className: "empty", textContent: text });
const openUrl = (url) => () => { openOverlay("library", false); jev.nav.go(url); };
async function renderBookmarks() {
  const list = await jev.library.bookmarks();
  $("bookmark-list").replaceChildren(...(list.length ? list.map((b) => row({ title: b.title, url: b.url, onOpen: openUrl(b.url),
    actions: [["Remove", async () => { await jev.library.removeBookmark(b.url); renderBookmarks(); }]] }))
    : [empty("No bookmarks yet. Click ☆ in the address bar to add one.")]));
}
async function renderHistory() {
  const list = await jev.library.history($("history-search").value);
  $("history-list").replaceChildren(...(list.length ? list.map((h) => row({ title: h.title, url: h.url,
    meta: new Date(h.at).toLocaleString(), onOpen: openUrl(h.url) })) : [empty("No history.")]));
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

// ---------- profiles ----------
function avatarOf(p, node) {
  node.replaceChildren();
  node.style.background = p.color;
  if (p.google?.photo) {
    const img = el("img", { src: p.google.photo, alt: "", referrerPolicy: "no-referrer" });
    img.addEventListener("error", () => { node.textContent = initials(p.google?.name || p.name); });
    node.append(img);
  } else node.textContent = initials(p.google?.name || p.name);
  return node;
}
function renderAvatar() {
  const p = thisProfile();
  avatarOf(p, $("profile-button"));
  avatarOf(p, $("you-avatar"));
  $("profile-button").title = p.google ? `${p.name} · ${p.google.email}` : `${p.name} · not signed in to Google`;
  $("you-name").textContent = p.name;
  $("you-email").textContent = p.google ? `Signed in to Google as ${p.google.email}` : "Not signed in to Google";
  $("you-google").replaceChildren(icon(p.google ? "logout" : "user", 15), p.google ? "Sign out of Google" : "Sign in to Google");
  $("you-google").className = p.google ? "btn" : "btn primary";
}
async function renderProfiles() {
  profiles = await jev.profiles.list();
  renderAvatar();
  $("profile-list").replaceChildren(...profiles.map((p) => {
    const current = p.id === cfg?.profileId;
    const li = el("li", { className: current ? "current" : "" });
    const info = el("div", { className: "grow" }, el("div", { className: "name", textContent: current ? `${p.name} · this window` : p.name }),
      el("div", { className: "email" }, icon(p.google ? "mail" : "user", 13),
         el("span", { textContent: p.google ? p.google.email : "Not signed in to Google" })));
    const actions = el("div", { className: "actions" });
    const action = (name, title, onClick) => {
      const b = el("button", { className: "icon-btn", title, ariaLabel: title }, icon(name, 17));
      b.addEventListener("click", onClick);
      actions.append(b);
    };
    if (!current) action("external", "Open in its window", () => { jev.profiles.open(p.id); openOverlay("profiles", false); });
    if (current) action(p.google ? "logout" : "user", p.google ? "Sign out of Google" : "Sign in to Google", googleAction);
    if (p.id !== "default") action("trash", "Remove profile", async () => {
      if (confirm(`Remove ${p.name}? Its Google sign-in, history, bookmarks, cookies and chats are deleted.`)) {
        await jev.profiles.remove(p.id);
        renderProfiles();
      }
    });
    li.append(avatarOf(p, el("span", { className: "avatar" })), info, actions);
    return li;
  }));
}
async function googleAction() {
  openOverlay("profiles", false);
  openOverlay("settings", false);
  if (thisProfile().google) await jev.profiles.googleSignOut();
  else await jev.profiles.googleSignIn();
}
$("you-google").addEventListener("click", googleAction);
jev.profiles.onChange(() => renderProfiles());
$("profile-button").addEventListener("click", () => { renderProfiles(); openOverlay("profiles", true); });
$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await jev.profiles.create($("profile-name").value.trim(), $("profile-color").value);
  $("profile-name").value = "";
  renderProfiles();
});

// ---------- site permission prompts ----------
const PERMISSION_TEXT = { notifications: "show notifications", geolocation: "know your location",
  media: "use your camera or microphone", "clipboard-read": "read your clipboard", midi: "use MIDI devices",
  "idle-detection": "know when you are idle" };
let pendingPermission = null;
jev.permission.onAsk((request) => {
  pendingPermission = request;
  $("permission-title").textContent = `${new URL(request.origin).host} wants to ${PERMISSION_TEXT[request.permission] || request.permission}`;
  $("permission-text").textContent = "You can change this later in Settings → Site settings.";
  openOverlay("permission", true);
});
for (const [id, allow] of [["permission-allow", true], ["permission-block", false]]) {
  $(id).addEventListener("click", () => {
    if (pendingPermission) jev.permission.answer(pendingPermission.id, allow, $("permission-remember").checked);
    pendingPermission = null;
    openOverlay("permission", false);
  });
}

// ---------- settings ----------
function bindSettings() {
  for (const input of document.querySelectorAll("[data-app], [data-profile]")) {
    const scope = input.dataset.app ? "app" : "profile";
    const value = get(cfg[scope], input.dataset.app || input.dataset.profile);
    if (input.type === "checkbox") input.checked = !!value;
    else if (input.type === "radio") input.checked = String(value) === input.value;
    else input.value = value ?? "";
  }
  $("startup-pages").value = (cfg.profile.startup.pages || []).join("\n");
  $("download-dir").textContent = cfg.profile.downloads.dir || "Downloads folder";
  $("spell-language").value = cfg.profile.languages.languages?.[0] || "en-US";
  $("home").hidden = !cfg.profile.appearance.showHomeButton;
}
for (const input of document.querySelectorAll("[data-app], [data-profile]")) {
  input.addEventListener("change", async () => {
    const key = input.dataset.app || input.dataset.profile;
    if (input.type === "radio" && !input.checked) return;
    let value = input.type === "checkbox" ? input.checked : input.value;
    if (input.hasAttribute("data-number")) value = Number(value);
    if (input.dataset.app) await jev.settings.setApp(patchOf(key, value));
    else await jev.settings.setProfile(patchOf(key, value));
    if (key === "appearance.theme") jev.ui.theme(value);
  });
}
jev.settings.onChange((next) => { cfg = next; bindSettings(); });

function showSection(name) {
  document.querySelectorAll("#settings-nav [data-section]").forEach((b) => b.classList.toggle("on", b.dataset.section === name));
  document.querySelectorAll("#settings-body > section").forEach((s) => { s.hidden = s.dataset.section !== name; });
  ({ agent: renderAgentSites, model: renderModel, sites: renderSitePermissions, default: renderDefault,
     about: renderAbout, you: renderProfiles })[name]?.();
}
document.querySelectorAll("#settings-nav [data-section]").forEach((b) => b.addEventListener("click", () => showSection(b.dataset.section)));
function openSettings(section = "you") { bindSettings(); openOverlay("settings", true); showSection(section); }
$("open-settings").addEventListener("click", () => openSettings());
$("settings-search").addEventListener("input", () => {
  const q = $("settings-search").value.trim().toLowerCase();
  let first = null;
  for (const button of document.querySelectorAll("#settings-nav [data-section]")) {
    const section = document.querySelector(`#settings-body > section[data-section="${button.dataset.section}"]`);
    const match = !q || section.textContent.toLowerCase().includes(q) || button.textContent.toLowerCase().includes(q);
    button.hidden = !match;
    if (match && !first) first = button.dataset.section;
  }
  if (first) showSection(first);
});

// window.prompt() does not exist in Electron, so the name is edited in place.
$("you-rename").addEventListener("click", async () => {
  const input = $("you-name-input");
  if (input.hidden) {
    input.value = thisProfile().name;
    input.hidden = false;
    $("you-name").hidden = true;
    $("you-rename").textContent = "Save";
    input.focus();
    return;
  }
  if (input.value.trim()) await jev.profiles.rename(cfg.profileId, input.value.trim());
  input.hidden = true;
  $("you-name").hidden = false;
  $("you-rename").textContent = "Rename";
  renderProfiles();
});
$("you-manage").addEventListener("click", () => { renderProfiles(); openOverlay("profiles", true); });

async function renderAgentSites() {
  const sites = Object.entries(await jev.library.sites());
  $("agent-sites").replaceChildren(...(sites.length ? sites.map(([origin, value]) => {
    const li = el("li", {}, el("div", { className: "grow", textContent: `${origin} · ${value === "allow" ? "allowed" : "blocked"}` }));
    const button = el("button", { textContent: "Forget" });
    button.addEventListener("click", async () => { await jev.library.setSite(origin, null); renderAgentSites(); });
    li.append(button);
    return li;
  }) : [empty("The agent asks on each new site.")]));
}
$("clear-chats").addEventListener("click", async () => {
  if (confirm("Delete all agent chats in this profile?")) { await jev.sessions.clear(); newChat(); }
});

// Model section: setup status, catalog, custom file, accelerator and restart.
async function renderSetupLine() {
  const s = await jev.setup.status();
  const missing = [!s.uv && "Python runtime", !s.llama && "llama.cpp", !s.model && "model"].filter(Boolean);
  $("setup-line").textContent = missing.length ? `Not set up yet: ${missing.join(", ")}.`
    : `Ready · llama.cpp ${s.build || "from the system"} · ${s.model}`;
  $("setup-run").textContent = missing.length ? "Set up" : "Repair";
  return missing.length === 0;
}
async function renderModel() {
  renderSetupLine();
  const catalog = await jev.model.catalog();
  $("model-list").replaceChildren(...catalog.map((m) => {
    const li = el("li");
    const radio = el("input", { type: "radio", name: "model", value: m.id, checked: cfg.app.agent.model === m.id });
    radio.addEventListener("change", async () => { await jev.settings.setApp({ agent: { model: m.id } }); renderModel(); });
    const tags = [m.size ? human(m.size) : "", m.thinking ? "thinking" : "", m.path ? "downloaded" : "not downloaded"]
      .filter(Boolean);
    li.append(radio, el("b", { textContent: m.name }), el("span", { className: "tag", textContent: tags.join(" · ") }),
              el("div", { className: "meta", textContent: m.note }));
    return li;
  }));
  $("model-custom-path").textContent = cfg.app.agent.model === "custom" ? cfg.app.agent.customModel : "";
  renderModelRunning();
}
function renderModelRunning() {
  if (!$("model-running")) return;
  $("model-running").textContent = services.agent === "ready"
    ? `Running on ${services.accelerator || "the selected accelerator"}.` : services.detail || "Not running.";
}
$("model-custom").addEventListener("click", async () => {
  const file = await jev.settings.pickModel();
  if (file) { await jev.settings.setApp({ agent: { model: "custom", customModel: file } }); renderModel(); }
});
$("model-restart").addEventListener("click", async () => { await jev.services.restart(); renderModelRunning(); });
function setupProgress(fill, text) {
  return (p) => {
    const pct = p.total ? Math.floor((p.received / p.total) * 100) : null;
    if (p.done) $(fill).style.width = "100%";
    else if (pct !== null) $(fill).style.width = `${pct}%`;
    $(text).textContent = p.error ? `Setup stopped: ${p.error}` : p.total
      ? `${p.label} ${human(p.received)} of ${human(p.total)}` : p.line ? `${p.label} ${p.line.slice(0, 80)}` : p.label;
  };
}
const settingsProgress = setupProgress("setup-fill", "setup-text");
const onboardProgress = setupProgress("onboard-fill", "onboard-text");
jev.setup.onProgress((p) => {
  settingsProgress(p);
  onboardProgress(p);
  if (p.done || p.error) {
    $("setup-run").disabled = false;
    $("onboard-run").disabled = false;
    renderSetupLine();
    if (step === 3 && !$("onboarding").hidden) runChecks();
    if (p.done && cfg.app.onboarded) jev.services.restart();
  }
});
$("setup-run").addEventListener("click", () => {
  $("setup-box").hidden = false;
  $("setup-run").disabled = true;
  jev.setup.run();
});

$("startup-pages").addEventListener("change", () => jev.settings.setProfile({
  startup: { pages: $("startup-pages").value.split("\n").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s)) } }));
$("clear-data").addEventListener("click", async () => {
  await jev.settings.clearData({ history: $("clear-history-box").checked, cookies: $("clear-cookies-box").checked,
                                 cache: $("clear-cache-box").checked, chats: $("clear-chats-box").checked });
  $("clear-done").textContent = "Cleared.";
  if ($("clear-chats-box").checked) newChat();
});
function renderSitePermissions() {
  $("permission-defaults").replaceChildren(el("h3", { textContent: "Default behaviour" }), ...Object.keys(PERMISSION_TEXT).map((key) => {
    const select = el("select");
    for (const [value, label] of [["ask", "Ask"], ["allow", "Allow"], ["block", "Block"]]) {
      select.append(el("option", { value, textContent: label, selected: cfg.profile.permissions[key] === value }));
    }
    select.addEventListener("change", () => jev.settings.setProfile({ permissions: { [key]: select.value } }));
    return el("div", { className: "perm-row" }, el("span", { textContent: `Sites that want to ${PERMISSION_TEXT[key]}` }), select);
  }));
  const sites = Object.entries(cfg.profile.sitePermissions || {});
  $("site-permissions").replaceChildren(...(sites.length ? sites.map(([origin, perms]) => {
    const li = el("li", {}, el("div", { className: "grow",
      textContent: `${origin} · ${Object.entries(perms).map(([k, v]) => `${k}: ${v}`).join(", ")}` }));
    const button = el("button", { textContent: "Reset" });
    button.addEventListener("click", async () => { cfg = await jev.permission.forget(origin); renderSitePermissions(); });
    li.append(button);
    return li;
  }) : [empty("No site has its own permissions yet.")]));
}
$("download-change").addEventListener("click", async () => {
  const dir = await jev.settings.pickFolder();
  if (dir) jev.settings.setProfile({ downloads: { dir } });
});
$("spell-language").addEventListener("change", () =>
  jev.settings.setProfile({ languages: { languages: [$("spell-language").value] } }));
async function renderDefault() {
  const isDefault = await jev.browser.isDefault();
  $("default-line").textContent = isDefault ? "Jev Browser is your default browser." : "Jev Browser is not your default browser.";
  $("make-default").hidden = isDefault;
}
$("make-default").addEventListener("click", async () => { await jev.browser.makeDefault(); renderDefault(); });
$("relaunch").addEventListener("click", () => jev.app.relaunch());
$("reset-profile").addEventListener("click", async () => {
  if (confirm("Reset this profile's settings to their defaults?")) { cfg = await jev.settings.resetProfile(); bindSettings(); }
});

// ---------- updates ----------
function showUpdate(state) {
  $("update-badge").hidden = !["available", "ready"].includes(state.status);
  const line = { idle: "", checking: "Checking for updates…", current: `Jev Browser is up to date (${state.version}).`,
    available: `Version ${state.latest} is available.`,
    downloading: `Downloading ${state.latest}… ${Math.round((state.progress || 0) * 100)}%`,
    verifying: "Checking the download…", ready: `Version ${state.latest} is downloaded and verified.`,
    error: `Could not update: ${state.error}` }[state.status] || "";
  $("update-line").textContent = line;
  $("update-box").hidden = state.status !== "downloading";
  $("update-fill").style.width = `${Math.round((state.progress || 0) * 100)}%`;
  $("update-action").textContent = state.status === "available" ? "Download update" : state.status === "ready"
    ? "Install and restart" : "Check for updates";
  $("update-action").disabled = ["checking", "downloading", "verifying"].includes(state.status);
}
jev.update.onChange(showUpdate);
async function renderAbout() {
  const info = await jev.app.info();
  $("about-version").textContent = `Version ${info.version} · Chromium ${info.chrome} · Electron ${info.electron} · ${info.platform}`;
  $("about-data").textContent = `Data folder: ${info.dataDir}`;
  showUpdate(await jev.update.state());
}
$("update-action").addEventListener("click", async () => {
  const state = await jev.update.state();
  if (state.status === "available") jev.update.download();
  else if (state.status === "ready") jev.update.install().catch((e) => { $("update-line").textContent = clean(e.message); });
  else jev.update.check();
});
$("update-badge").addEventListener("click", () => openSettings("about"));

// ---------- onboarding ----------
const chosenMode = () => document.querySelector("#onboarding input[name=mode]:checked").value;
function showStep(n) {
  step = n;
  document.querySelectorAll("#onboarding .step").forEach((node) => { node.hidden = Number(node.dataset.step) !== n; });
  document.querySelectorAll("#onboarding .dots li").forEach((dot, i) => dot.classList.toggle("on", i < n));
  if (n === 3) runChecks();
}
async function runChecks() {
  await jev.settings.setApp({ agent: { mode: chosenMode() } });
  const result = await jev.system.check();
  const local = chosenMode() === "local";
  const items = result.items.filter((item) => local || !["llama", "accelerator", "model", "disk"].includes(item.id));
  $("check-list").replaceChildren(...items.map((item) => {
    const li = el("li", { className: item.ok ? "ok" : item.setup || item.optional ? "" : "bad" });
    li.append(el("span", { className: "mark", textContent: item.ok ? "✓" : item.setup ? "↓" : item.optional ? "•" : "!" }),
              el("span", { textContent: item.label }), el("span", { className: "help", textContent: item.help }));
    return li;
  }));
  const needsSetup = items.some((item) => item.setup);
  $("onboard-setup").hidden = !needsSetup && !$("onboard-text").textContent;
  $("onboard-run").hidden = !needsSetup;
  const blocking = items.some((item) => !item.ok && !item.optional && !item.setup);
  $("check-next").disabled = blocking || needsSetup;
}
$("onboard-run").addEventListener("click", () => {
  $("onboard-setup").hidden = false;
  $("onboard-run").disabled = true;
  jev.setup.run();
});
document.querySelectorAll("#onboarding [data-next]").forEach((b) => b.addEventListener("click", () => showStep(step + 1)));
document.querySelectorAll("#onboarding [data-back]").forEach((b) => b.addEventListener("click", () => showStep(step - 1)));
document.querySelector("#onboarding [data-finish]").addEventListener("click", async () => {
  cfg.app = await jev.settings.setApp({ onboarded: true, agent: { mode: chosenMode() } });
  openOverlay("onboarding", false);
  jev.services.start();
  await jev.practice.open();
  setPanel(true);
  newChat();
  $("goal").value = "Find an in-stock notebook and order it";
  renderMessage("info", "This is a practice shop. Press Send to watch the agent work; it will ask before placing the order.");
});

// ---------- menu commands (shortcuts live in the app menu) ----------
jev.onCommand((name) => {
  if (name === "focus-omnibox") $("omnibox").focus();
  if (name === "toggle-agent") setPanel($("agent").hidden);
  if (name === "settings") openSettings();
  if (name === "library") openLibrary("history");
  if (name === "updates") { openSettings("about"); jev.update.check(); }
});

hydrateIcons();
document.body.classList.add(`os-${new URLSearchParams(location.search).get("platform") || "unknown"}`);
jev.settings.get().then(async (value) => {
  cfg = value;
  bindSettings();
  await renderProfiles();
  intro();
  if (!cfg.app.onboarded) { showStep(1); openOverlay("onboarding", true); }
  showUpdate(await jev.update.state());
});
setPanel(true);
