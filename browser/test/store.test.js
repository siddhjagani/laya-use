const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Library, Sessions, HISTORY_LIMIT } = require("../store");
const system = require("../system");

test("bookmarks toggle, persist, and ignore non-web pages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-lib-"));
  const library = new Library(dir);
  assert.equal(library.toggleBookmark("https://a.test/", "A"), true);
  assert.equal(library.toggleBookmark("file:///etc/passwd", "x"), false);
  assert.ok(library.isBookmarked("https://a.test/"));
  library.flush();
  assert.ok(new Library(dir).isBookmarked("https://a.test/"));
  assert.equal(library.toggleBookmark("https://a.test/", "A"), false);
  assert.equal(library.isBookmarked("https://a.test/"), false);
});

test("history merges repeat visits, searches, caps its size, and clears", () => {
  const library = new Library(fs.mkdtempSync(path.join(os.tmpdir(), "jev-lib-")));
  library.visit("https://a.test/", "Alpha");
  library.visit("https://a.test/", "Alpha page");
  library.visit("https://b.test/", "Beta");
  library.visit("about:blank", "x");
  assert.equal(library.history.data.length, 2);
  assert.equal(library.searchHistory("alpha")[0].title, "Alpha page");
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) library.visit(`https://c.test/${i}`, "c");
  assert.equal(library.history.data.length, HISTORY_LIMIT);
  library.clearHistory();
  assert.equal(library.history.data.length, 0);
});

test("site permissions are remembered and forgotten", () => {
  const library = new Library(fs.mkdtempSync(path.join(os.tmpdir(), "jev-lib-")));
  assert.equal(library.site("https://shop.test"), undefined);
  library.setSite("https://shop.test", "block");
  assert.equal(library.site("https://shop.test"), "block");
  library.setSite("https://shop.test", null);
  assert.equal(library.site("https://shop.test"), undefined);
});

test("system check lists every requirement and needs no model to be ready", () => {
  const result = system.check({ dataDir: os.tmpdir(), modelPath: null, modelSize: 1e9, budgetMb: 2048 });
  assert.deepEqual(result.items.map((i) => i.id), ["memory", "disk", "uv", "llama", "accelerator", "model"]);
  assert.equal(result.items.find((i) => i.id === "accelerator").optional, true);
  const model = result.items.find((i) => i.id === "model");
  assert.equal(model.setup, true, "a missing model is set up by the app, not by the user");
  assert.equal(result.needsSetup, true);
});

test("memory blocks only below the agent budget plus headroom", () => {
  const os = require("node:os");
  const real = os.totalmem;
  const GB = 1024 ** 3;
  try {
    for (const [total, ok] of [[2 * GB, false], [4 * GB, true], [16 * GB, true]]) {
      os.totalmem = () => total;
      const memory = system.check({ dataDir: os.tmpdir(), modelPath: "x", modelSize: 1e9, budgetMb: 2048 })
        .items.find((i) => i.id === "memory");
      assert.equal(memory.ok, ok, `${total / GB} GB`);
    }
  } finally {
    os.totalmem = real;
  }
});

test("agent chats are saved, titled by the first goal, listed newest first and removable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-chat-"));
  const sessions = new Sessions(dir);
  const first = sessions.create();
  sessions.append(first.id, { kind: "you", text: "Find an in-stock notebook" });
  sessions.append(first.id, { kind: "thinking", text: "The search box is empty." });
  const second = sessions.create();
  sessions.append(second.id, { kind: "you", text: "Open the article" });
  sessions.flush();
  const reopened = new Sessions(dir);
  assert.deepEqual(reopened.list().map((s) => s.title), ["Open the article", "Find an in-stock notebook"]);
  assert.deepEqual(reopened.get(first.id).messages.map((m) => m.kind), ["you", "thinking"]);
  reopened.remove(first.id);
  assert.equal(reopened.list().length, 1);
});
