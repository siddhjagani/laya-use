// Small JSON-file stores in the app's user-data folder. Writes are debounced and atomic (temp file + rename).
const fs = require("node:fs");
const path = require("node:path");

class Store {
  constructor(file, fallback) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = structuredClone(fallback);
    }
    this.timer = null;
  }

  save(now = false) {
    clearTimeout(this.timer);
    const write = () => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    };
    if (now) write();
    else this.timer = setTimeout(write, 300);
  }
}

const HISTORY_LIMIT = 5000;

class Library {
  constructor(dir) {
    this.bookmarks = new Store(path.join(dir, "bookmarks.json"), []);
    this.history = new Store(path.join(dir, "history.json"), []);
    this.sites = new Store(path.join(dir, "agent-sites.json"), {});
  }

  isBookmarked(url) {
    return this.bookmarks.data.some((b) => b.url === url);
  }

  toggleBookmark(url, title) {
    if (!/^https?:/.test(url)) return false;
    const at = this.bookmarks.data.findIndex((b) => b.url === url);
    if (at >= 0) this.bookmarks.data.splice(at, 1);
    else this.bookmarks.data.unshift({ url, title: title || url, added: Date.now() });
    this.bookmarks.save();
    return at < 0;
  }

  removeBookmark(url) {
    this.bookmarks.data = this.bookmarks.data.filter((b) => b.url !== url);
    this.bookmarks.save();
  }

  visit(url, title) {
    if (!/^https?:/.test(url)) return;
    const last = this.history.data[0];
    if (last && last.url === url) {
      last.title = title || last.title;
      last.at = Date.now();
    } else {
      this.history.data.unshift({ url, title: title || url, at: Date.now() });
      this.history.data.length = Math.min(this.history.data.length, HISTORY_LIMIT);
    }
    this.history.save();
  }

  searchHistory(query = "", limit = 200) {
    const q = query.trim().toLowerCase();
    return this.history.data.filter((h) => !q || h.url.toLowerCase().includes(q) ||
      (h.title || "").toLowerCase().includes(q)).slice(0, limit);
  }

  clearHistory() {
    this.history.data = [];
    this.history.save(true);
  }

  // Per-site agent permission: "allow" | "block" | undefined (ask).
  site(origin) {
    return this.sites.data[origin];
  }

  setSite(origin, value) {
    if (value) this.sites.data[origin] = value;
    else delete this.sites.data[origin];
    this.sites.save();
  }

  flush() {
    for (const store of [this.bookmarks, this.history, this.sites]) if (store.timer) store.save(true);
  }
}

const SESSION_LIMIT = 200;

// Agent chats: each keeps its transcript (goals, steps, thinking, prompts, results) so it can be reopened later.
class Sessions {
  constructor(dir) {
    this.store = new Store(path.join(dir, "agent-sessions.json"), []);
  }

  list() {
    return this.store.data.map(({ messages, ...meta }) => ({ ...meta, count: messages.length }))
      .sort((a, b) => b.updated - a.updated);
  }

  get(id) {
    return this.store.data.find((s) => s.id === id) || null;
  }

  create() {
    const session = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: "New chat",
                      created: Date.now(), updated: Date.now(), messages: [] };
    this.store.data.unshift(session);
    this.store.data.length = Math.min(this.store.data.length, SESSION_LIMIT);
    this.store.save();
    return session;
  }

  append(id, message) {
    const session = this.get(id) || this.create();
    const entry = { kind: String(message.kind || "info").slice(0, 20), text: String(message.text || "").slice(0, 4000),
                    at: Date.now() };
    session.messages.push(entry);
    if (session.title === "New chat" && entry.kind === "you") session.title = entry.text.slice(0, 80);
    session.updated = Date.now();
    this.store.save();
    return session;
  }

  rename(id, title) {
    const session = this.get(id);
    if (session) { session.title = String(title).slice(0, 80) || session.title; this.store.save(); }
  }

  remove(id) {
    this.store.data = this.store.data.filter((s) => s.id !== id);
    this.store.save();
  }

  clear() {
    this.store.data = [];
    this.store.save(true);
  }

  flush() {
    if (this.store.timer) this.store.save(true);
  }
}

module.exports = { Store, Library, Sessions, HISTORY_LIMIT, SESSION_LIMIT };
