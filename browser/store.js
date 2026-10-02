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

module.exports = { Store, Library, HISTORY_LIMIT };
