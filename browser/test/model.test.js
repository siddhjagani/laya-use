// Offline: a local HTTP server stands in for Hugging Face.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { downloadModel, findModel } = require("../model");

const body = crypto.randomBytes(300_000);
const fake = (overrides = {}) => ({ file: "fake.gguf", size: body.length, repo: "none/none",
  sha256: crypto.createHash("sha256").update(body).digest("hex"), ...overrides });

function serve(payload = body) {
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range || "");
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/model" }).end(); return; }
    if (range) {
      const start = Number(range[1]);
      res.writeHead(206, { "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}` });
      res.end(payload.subarray(start));
    } else {
      res.writeHead(200).end(payload);
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("downloads through a redirect, verifies, and is then found", async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-model-"));
  const model = fake({ url: `http://127.0.0.1:${server.address().port}/redirect` });
  const seen = [];
  const file = await downloadModel(dir, (p) => seen.push(p), { model });
  assert.deepEqual(fs.readFileSync(file), body);
  assert.ok(seen.some((p) => p.verifying));
  assert.equal(findModel(dir, model), file);
});

test("resumes a partial download with a range request", async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-model-"));
  const model = fake({ url: `http://127.0.0.1:${server.address().port}/model` });
  fs.writeFileSync(path.join(dir, `${model.file}.part`), body.subarray(0, 100_000));
  const first = [];
  const file = await downloadModel(dir, (p) => first.push(p.received), { model });
  assert.deepEqual(fs.readFileSync(file), body);
  assert.ok(first[0] > 100_000, "progress starts after the bytes already on disk");
});

test("a file that fails its checksum is deleted, never used", async (t) => {
  const server = await serve(Buffer.from(body).fill(7, 0, 10));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-model-"));
  const model = fake({ url: `http://127.0.0.1:${server.address().port}/model` });
  await assert.rejects(downloadModel(dir, null, { model }), /checksum/);
  assert.equal(findModel(dir, model), null);
  assert.equal(fs.existsSync(path.join(dir, `${model.file}.part`)), false);
});
