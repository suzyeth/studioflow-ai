const assert = require("assert");
const http = require("http");
const path = require("path");
const { createFirestoreMirror, withMirror } = require("../lib/store-firestore");
const { createRunStore, loadDemoData, createQueuedRun } = require("../lib/workflow");

const rootDir = path.join(__dirname, "..");
const demo = loadDemoData(rootDir);

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

(async () => {
  // A stub that is both the metadata token endpoint and Firestore. Documents
  // land in a Map so the round trip is real: what save() wrote is what
  // fetch() parses back.
  let tokenCalls = 0;
  let failWrites = false;
  const docs = new Map();

  const stub = await listen(async (req, res) => {
    if (req.url === "/token") {
      tokenCalls += 1;
      assert.equal(req.headers["metadata-flavor"], "Google", "metadata header is required");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "t0k3n", expires_in: 3600 }));
      return;
    }

    const match = req.url.match(/\/documents\/runs\/([^/?]+)/);
    if (!match) {
      res.writeHead(500);
      res.end();
      return;
    }
    const docId = decodeURIComponent(match[1]);
    assert.equal(req.headers.authorization, "Bearer t0k3n", "every call carries the token");

    // Real Firestore reserves document ids matching __.*__ and answers 400.
    // The first probe sentinel was named `__probe__` and only the first real
    // deployment caught it; this keeps the stub honest about that rule.
    if (/^__.*__$/.test(docId)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}');
      return;
    }

    if (req.method === "PATCH") {
      if (failWrites) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"unavailable"}');
        return;
      }
      docs.set(docId, JSON.parse(await readBody(req)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    if (req.method === "GET") {
      const doc = docs.get(docId);
      if (!doc) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(doc));
      return;
    }

    res.writeHead(405);
    res.end();
  });

  const mirror = createFirestoreMirror({
    projectId: "test-project",
    baseUrl: stub.baseUrl,
    tokenUrl: `${stub.baseUrl}/token`,
  });

  // --- probe: a 404 on the sentinel is success ---------------------------------
  await mirror.probe();

  // --- a mirrored store round-trips a run --------------------------------------
  const store = withMirror(createRunStore(), mirror);
  const run = store.save(createQueuedRun(demo, demo.brief.text));

  // save() is fire-and-forget; give the background write a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(docs.has(run.trace_id), "a save is mirrored to Firestore");
  assert.equal(
    JSON.parse(docs.get(run.trace_id).fields.data.stringValue).trace_id,
    run.trace_id,
    "the document holds the whole run as one string field",
  );

  const fetched = await mirror.fetch(run.trace_id);
  assert.equal(fetched.trace_id, run.trace_id, "fetch parses the run back");
  assert.equal(fetched.project.status, "queued");

  // --- update() mirrors what the updater returned ------------------------------
  store.update(run.trace_id, (current) => ({
    ...current,
    project: { ...current.project, status: "running" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    (await mirror.fetch(run.trace_id)).project.status,
    "running",
    "an update is mirrored too",
  );

  // --- rehydration: a fresh Map miss comes back from the mirror ----------------
  // This is the restart scenario: new process, empty Map, same Firestore.
  const rebooted = createRunStore();
  assert.equal(rebooted.get(run.trace_id), null, "the fresh store has never seen the run");
  const persisted = await mirror.fetch(run.trace_id);
  rebooted.save(persisted);
  assert.equal(
    rebooted.get(run.trace_id).project.status,
    "running",
    "the run survives into a store that never saw it written",
  );

  // --- an unknown id is null, not an error -------------------------------------
  assert.equal(await mirror.fetch("no-such-run"), null);

  // --- a mirror failure never reaches the caller -------------------------------
  failWrites = true;
  const during = store.save(createQueuedRun(demo, demo.brief.text));
  assert.ok(during.trace_id, "the synchronous path returns normally while the mirror is down");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(mirror.lastError.message, /HTTP 503/, "the failure is recorded for /api/health");
  failWrites = false;

  // ...and a later success clears it.
  store.save(createQueuedRun(demo, demo.brief.text));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mirror.lastError, null, "a landed write clears last_error");

  // --- the token is cached, not fetched per call -------------------------------
  assert.equal(tokenCalls, 1, `one token fetch serves every call (saw ${tokenCalls})`);

  // --- withMirror without a mirror is the store itself -------------------------
  const plain = createRunStore();
  assert.equal(withMirror(plain, null), plain, "no mirror means no wrapper");

  stub.server.close();
  console.log("firestore mirror test passed");
})();
