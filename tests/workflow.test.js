// Run lifecycle, review handling, the store, and the script cache.
//
// Everything here drives the SAME path the server uses: createQueuedRun +
// executeRun + closeReviewItem. There is no second run-building code path to
// test against, by design.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLocalProvider } = require("../lib/llm");
const {
  closeReviewItem,
  createQueuedRun,
  createRunStore,
  executeRun,
  loadBrowserGlobal,
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
  loadViewModel,
} = require("../lib/workflow");

const rootDir = path.join(__dirname, "..");
const demo = loadDemoData(rootDir);
const intakeHeuristics = loadIntakeHeuristics(rootDir);
const production = loadProductionHeuristics(rootDir);
const view = loadViewModel(rootDir);
const agentDeps = {
  provider: createLocalProvider(intakeHeuristics),
  intakeHeuristics,
  production,
};

async function freshRun(briefText = demo.brief.text) {
  const store = createRunStore();
  const queued = store.save(createQueuedRun(demo, briefText));
  await executeRun(queued.trace_id, { store, demo, agentDeps, stepDelayMs: 0 });
  return { store, run: store.get(queued.trace_id) };
}

// --- the three hardcoded file lists ------------------------------------------
// A new top-level source file has to be registered in the check script, the
// Dockerfile, and (for browser scripts) index.html. Missing one silently drops
// the file from validation, the container image, or the page. Enforce it.
const topLevelSources = fs
  .readdirSync(rootDir)
  .filter((name) => /\.(js|css|html)$/.test(name));

const dockerfile = fs.readFileSync(path.join(rootDir, "Dockerfile"), "utf8");
const checkScript = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"))
  .scripts.check;
const indexHtml = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");

for (const name of topLevelSources) {
  assert.ok(
    new RegExp(`^COPY ${name.replace(".", "\\.")} `, "m").test(dockerfile),
    `${name} is missing from the Dockerfile COPY list`,
  );

  if (name.endsWith(".js")) {
    assert.ok(checkScript.includes(name), `${name} is missing from the check script`);

    // server.js is the only top-level script that is Node-only. Anything else at
    // the top level is a browser script and must be loaded by the page.
    if (name !== "server.js") {
      assert.ok(
        indexHtml.includes(`src="${name}"`),
        `${name} has no <script> tag in index.html (add one, or move it under lib/ if it is server-only)`,
      );
    }
  }
}

// app-render.js must load before app.js, whose boot() calls renderAll().
assert.ok(
  indexHtml.indexOf('src="app-render.js"') < indexHtml.indexOf('src="app.js"'),
  "app-render.js must be loaded before app.js",
);

// Browser scripts must not use module syntax: Node evaluates the same files in a
// sandbox, and the page loads them as classic scripts.
for (const name of ["data.js", "intake-heuristics.js", "production-heuristics.js", "view-model.js"]) {
  const code = fs
    .readFileSync(path.join(rootDir, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, ""); // comments describe the rule; only code breaks it

  assert.ok(
    !/(require\s*\(|module\.exports|^\s*import\s|^\s*export\s)/m.test(code),
    `${name} is a dual-runtime browser script and must not use module syntax`,
  );
}

// --- the store ---------------------------------------------------------------
const store = createRunStore();
const sample = createQueuedRun(demo, "sample");
store.save(sample);
assert.equal(store.get(sample.trace_id).trace_id, sample.trace_id);
assert.equal(store.get("missing-trace"), null);
assert.notStrictEqual(store.get(sample.trace_id), store.get(sample.trace_id), "reads are copies");

const boundedStore = createRunStore(3);
for (const traceId of ["a", "b", "c"]) {
  boundedStore.save({ ...sample, trace_id: traceId });
}
assert.equal(boundedStore.size, 3);

boundedStore.get("a");
boundedStore.save({ ...sample, trace_id: "d" });
assert.equal(boundedStore.size, 3, "the store stays at its cap");
assert.ok(boundedStore.get("a"), "a recently read run survives eviction");
assert.equal(boundedStore.get("b"), null, "the least recently used run is evicted");

boundedStore.update("c", (current) => current);
boundedStore.save({ ...sample, trace_id: "e" });
assert.ok(boundedStore.get("c"), "an updated run survives eviction");

// --- browser-global cache ----------------------------------------------------
const demoA = loadDemoData(rootDir);
const demoB = loadDemoData(rootDir);
assert.notStrictEqual(demoA, demoB, "each load returns an independent copy");
demoA.tasks.length = 0;
assert.equal(loadDemoData(rootDir).tasks.length, 6, "mutating a copy does not poison the cache");
assert.strictEqual(loadViewModel(rootDir), loadViewModel(rootDir), "function bags are shared");

const tmpScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studioflow-")), "probe.js");
try {
  // These writes land back-to-back on purpose: this filesystem reports mtime at
  // whole-second resolution, so an mtime-keyed cache serves stale values here.
  // Do not "stabilise" this by bumping timestamps — the tight loop is the point.
  for (const value of [1, 2, 3, 4, 5]) {
    fs.writeFileSync(tmpScript, `const PROBE = { value: ${value} };\n`);
    assert.equal(loadBrowserGlobal(tmpScript, "PROBE").value, value);
  }
} finally {
  fs.rmSync(path.dirname(tmpScript), { recursive: true, force: true });
}

(async () => {
  // --- a completed run ---------------------------------------------------------
  const { store: liveStore, run } = await freshRun();

  assert.equal(run.project.status, "needs_review");
  assert.equal(run.tasks.length, 6);
  assert.equal(run.artifacts.length, 6);
  assert.ok(run.trace_id.startsWith("local-"));
  assert.ok(run.packet_markdown.includes("## Shot List"));
  assert.ok(
    run.artifacts.every((artifact) => artifact.version === 1),
    "every artifact starts at version 1",
  );
  assert.equal(run.tasks.find((task) => task.id === "critic").state, "needs_review");
  assert.ok(run.review_items.length > 0);
  assert.ok(
    run.review_items.every((item) => item.target_task_ids?.length > 0),
    "every finding names the tasks that must rerun",
  );

  // --- revision reruns the agents ---------------------------------------------
  const heroFinding = run.review_items.find((item) => item.id === "hero-window");
  assert.ok(heroFinding, "the bundled brief trips the first-five-seconds constraint");

  const shotsBefore = run.artifacts.find((a) => a.type === "shots");
  const revised = await closeReviewItem(run, heroFinding.id, "revise", {
    ...agentDeps,
    production,
  });
  const shotsAfter = revised.artifacts.find((a) => a.type === "shots");

  assert.equal(revised.review_items.length, run.review_items.length - 1);
  assert.equal(shotsAfter.version, 2);
  assert.notEqual(
    shotsAfter.content_markdown,
    shotsBefore.content_markdown,
    "the rerun produced different content, not just a version bump",
  );
  assert.match(shotsAfter.content_markdown.split("\n")[0], /presented clearly in frame/);
  assert.deepEqual(revised.enforce, { heroFirst: true }, "the constraint is remembered");
  assert.notEqual(revised.packet_markdown, run.packet_markdown, "the packet is rebuilt");
  assert.equal(
    revised.artifacts.find((a) => a.type === "intake").version,
    1,
    "untargeted artifacts are untouched",
  );
  assert.equal(
    revised.audit_events.filter((e) => e.event_type === "artifact_created").length,
    heroFinding.target_task_ids.length,
  );
  assert.equal(run.review_items.length, revised.review_items.length + 1, "input is not mutated");

  // Approving must not touch artifacts.
  const approved = await closeReviewItem(revised, revised.review_items[0].id, "approve", {
    ...agentDeps,
    production,
  });
  assert.equal(
    approved.artifacts.find((a) => a.type === "shots").version,
    2,
    "approve leaves artifacts alone",
  );

  // Closing every finding lands the run on approved with a packet.
  let settled = approved;
  while (settled.review_items.length > 0) {
    settled = await closeReviewItem(settled, settled.review_items[0].id, "approve", {
      ...agentDeps,
      production,
    });
  }
  assert.equal(settled.project.status, "approved");
  assert.equal(settled.packet_ready, true);
  assert.equal(settled.tasks.find((task) => task.id === "critic").state, "approved");

  await assert.rejects(
    () => closeReviewItem(run, "no-such-review", "approve", agentDeps),
    /Review item not found/,
  );

  // Without agent deps a revision still versions, but cannot regenerate.
  const noDeps = await closeReviewItem(run, heroFinding.id, "revise");
  assert.equal(noDeps.artifacts.find((a) => a.type === "shots").version, 2);
  assert.equal(
    noDeps.artifacts.find((a) => a.type === "shots").content_markdown,
    shotsBefore.content_markdown,
  );

  // --- view model over a real run ---------------------------------------------
  assert.equal(view.escapeHtml('<img src=x onerror="boom">'), "&lt;img src=x onerror=&quot;boom&quot;&gt;");
  assert.equal(view.escapeHtml("a & b"), "a &amp; b");
  assert.equal(view.escapeHtml(null), "");
  assert.equal(view.escapeHtml(0), "0");

  const normalized = view.normalizeApiRun(run, demo);
  assert.equal(normalized.traceId, run.trace_id);
  assert.equal(normalized.tasks.length, 6);
  assert.equal(normalized.artifacts.length, 6);
  assert.ok(normalized.artifacts.every((artifact) => artifact.content));
  assert.equal(normalized.packetMarkdown, run.packet_markdown);
  assert.equal(normalized.status, "needs_review");
  assert.ok(normalized.metrics.task_durations_ms);
  assert.ok(
    normalized.tasks.every((task) => typeof task.agent === "string" && task.agent.length > 0),
  );

  // The audit panel reads newest-first, matching the offline path's unshift.
  assert.equal(normalized.audit[0].message, run.audit_events.at(-1).message);
  assert.equal(normalized.audit.length, run.audit_events.length);

  // Normalizing an already-normalized run is the bug that silently drops the app
  // into its offline fallback. Keep it loud.
  assert.throws(() => view.normalizeApiRun(normalized, demo));

  console.log("workflow test passed");
})();
