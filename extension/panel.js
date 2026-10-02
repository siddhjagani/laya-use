// Chat panel: sends one goal for the active tab to the local jev-chat server and shows each step as it happens.
const SERVER = "http://127.0.0.1:8767";
const $ = (id) => document.getElementById(id);
let token = "";
let since = 0;
let polling = null;

function add(kind, text) {
  const div = document.createElement("div");
  div.className = `msg ${kind === "status" ? "info" : kind}`;
  div.textContent = text;  // text only: page and model content never become HTML
  $("log").append(div);
  $("log").scrollTop = $("log").scrollHeight;
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`;
}

async function api(path, body) {
  const response = await fetch(SERVER + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Jev-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
  return data;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function showTab() {
  const tab = await activeTab();
  $("tab").textContent = tab?.url ? `On: ${tab.title || tab.url}` : "Open a web page first";
}

function busy(on) {
  $("send").disabled = on;
  $("goal").disabled = on;
  $("stop").hidden = !on;
  setStatus(on ? "working" : "ready", on ? "busy" : "ready");
}

async function poll() {
  try {
    const data = await api(`/api/events?since=${since}`);
    for (const event of data.events) {
      add(event.kind, event.text);
      since = event.n + 1;
    }
    if (!data.busy) {
      clearInterval(polling);
      polling = null;
      busy(false);
    }
  } catch (error) {
    clearInterval(polling);
    polling = null;
    busy(false);
    add("error", `Lost the local agent: ${error.message}`);
    setStatus("offline");
  }
}

async function connect() {
  ({ token = "" } = await chrome.storage.local.get("token"));
  try {
    await api("/api/ping", {});
    $("pair").hidden = true;
    setStatus("ready", "ready");
  } catch (error) {
    $("pair").hidden = false;
    setStatus("offline");
    if (token) {
      $("pair-error").hidden = false;
      $("pair-error").textContent = error.message;
    }
  }
}

$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({ token: $("token").value.trim() });
  connect();
});

$("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const goal = $("goal").value.trim();
  const tab = await activeTab();
  if (!goal) return;
  if (!tab?.url?.startsWith("http")) return add("error", "Open a normal web page (http or https) first.");
  add("you", goal);
  $("goal").value = "";
  try {
    await api("/api/run", { goal, url: tab.url });
    since = 0;
    busy(true);
    polling = setInterval(poll, 300);
  } catch (error) {
    add("error", error.message);
  }
});

$("goal").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("ask").requestSubmit();
  }
});

$("stop").addEventListener("click", () => api("/api/stop", {}).catch((error) => add("error", error.message)));
chrome.tabs.onActivated.addListener(showTab);
chrome.tabs.onUpdated.addListener(showTab);
showTab();
connect();
