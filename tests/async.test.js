const assert = require("assert");
const http = require("http");
const path = require("path");
const { createJobQueue } = require("../lib/queue");
const {
  createAnthropicProvider,
  createGeminiProvider,
  createLocalProvider,
} = require("../lib/llm");
const { runIntakeAgent } = require("../lib/agents/intake");
const {
  createQueuedRun,
  createRunStore,
  executeRun,
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
} = require("../lib/workflow");

const rootDir = path.join(__dirname, "..");
const intakeHeuristics = loadIntakeHeuristics(rootDir);
const production = loadProductionHeuristics(rootDir);
const demo = loadDemoData(rootDir);
const agentDeps = {
  provider: createLocalProvider(intakeHeuristics),
  intakeHeuristics,
  production,
};

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
  // --- the queue -------------------------------------------------------------
  const order = [];
  const queue = createJobQueue({ onError: (error) => order.push(`err:${error.message}`) });

  queue.push(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a-end");
  });
  queue.push(async () => order.push("b"));
  queue.push(async () => {
    throw new Error("boom");
  });
  queue.push(async () => order.push("c"));

  // Work must not have started before the caller yields.
  assert.deepEqual(order, [], "push returns before the job runs");

  await queue.idle();
  assert.deepEqual(
    order,
    ["a-start", "a-end", "b", "err:boom", "c"],
    "jobs run one at a time and a failure does not stop the queue",
  );
  assert.equal(queue.processed, 4);

  // --- a run advances through states -----------------------------------------
  const store = createRunStore();
  const queued = store.save(createQueuedRun(demo, demo.brief.text));

  assert.equal(queued.project.status, "queued");
  assert.ok(
    queued.tasks.every((task) => task.state === "queued"),
    "every task starts queued, not completed",
  );
  assert.deepEqual(queued.artifacts, [], "a queued run has no artifacts yet");
  assert.equal(queued.packet_markdown, null);

  // Snapshot the run each time a task starts, which is what a poller would see.
  const seen = [];
  await executeRun(queued.trace_id, {
    store,
    demo,
    agentDeps,
    stepDelayMs: 0,
    onStep: async (taskId) => {
      const snapshot = store.get(queued.trace_id);
      seen.push({
        taskId,
        running: snapshot.tasks.find((task) => task.id === taskId).state,
        artifacts: snapshot.artifacts.length,
        status: snapshot.project.status,
      });
    },
  });

  assert.deepEqual(
    seen.map((entry) => entry.taskId),
    ["intake", "planning", "shots", "assets", "prompts", "critic"],
    "tasks execute in dependency order",
  );
  assert.ok(
    seen.every((entry) => entry.running === "running"),
    "each task is observably running before it completes",
  );
  assert.deepEqual(
    seen.map((entry) => entry.artifacts),
    [0, 1, 2, 3, 4, 5],
    "artifacts accumulate one per completed task",
  );
  assert.equal(seen[1].status, "running", "the run reports running while work is in flight");

  const finished = store.get(queued.trace_id);
  assert.equal(finished.project.status, "needs_review");
  assert.equal(finished.artifacts.length, 6);
  assert.ok(finished.review_items.length > 0);
  assert.ok(finished.packet_markdown.includes("## Shot List"));
  assert.ok(
    Object.keys(finished.metrics.task_durations_ms).length === 6,
    "every task records a duration for the proof view",
  );
  assert.ok(finished.metrics.finished_at);
  assert.ok(
    !finished.project.title.includes("Tokyo Night Market"),
    "the project is renamed from the brief",
  );

  // --- a failing task fails the run instead of hanging it ---------------------
  const failStore = createRunStore();
  const failing = failStore.save(createQueuedRun(demo, demo.brief.text));
  await assert.rejects(() =>
    executeRun(failing.trace_id, {
      store: failStore,
      demo,
      agentDeps: {
        ...agentDeps,
        production: {
          ...production,
          buildPlan() {
            throw new Error("planner exploded");
          },
        },
      },
      stepDelayMs: 0,
    }),
  );

  const failed = failStore.get(failing.trace_id);
  assert.equal(failed.project.status, "failed");
  assert.equal(failed.tasks.find((task) => task.id === "planning").state, "failed");
  assert.equal(
    failed.tasks.find((task) => task.id === "intake").state,
    "completed",
    "work completed before the failure is kept",
  );
  assert.ok(failed.audit_events.some((event) => event.event_type === "task_failed"));

  // --- hosted adapters against a stub endpoint -------------------------------
  // Everything except authentication and real model behaviour.
  const geminiCalls = [];
  const gemini = await listen(async (req, res) => {
    geminiCalls.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await readBody(req)),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: '```json\n{"structured_brief":{"goal":"g"}}\n```' }] } },
        ],
      }),
    );
  });

  const geminiProvider = createGeminiProvider({
    apiKey: "test-key",
    model: "gemini-test",
    timeoutMs: 5000,
    baseUrl: gemini.baseUrl,
  });
  const geminiResult = await geminiProvider.generateJson({ system: "sys", user: "usr" });

  assert.deepEqual(geminiResult, { structured_brief: { goal: "g" } }, "fenced JSON is unwrapped");
  // The GenAI SDK owns the path and appends the API version itself, and it
  // authenticates with a header rather than a query parameter. Asserting both
  // is what catches a baseUrl that already carries /v1beta (which would produce
  // /v1beta/v1beta/...) and a key that never left the client.
  assert.match(geminiCalls[0].url, /^\/v1beta\/models\/gemini-test:generateContent/);
  assert.equal(geminiCalls[0].headers["x-goog-api-key"], "test-key");
  assert.equal(geminiCalls[0].body.systemInstruction.parts[0].text, "sys");
  assert.equal(geminiCalls[0].body.contents[0].parts[0].text, "usr");
  assert.equal(geminiCalls[0].body.generationConfig.responseMimeType, "application/json");
  gemini.server.close();

  const anthropicCalls = [];
  const anthropic = await listen(async (req, res) => {
    anthropicCalls.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await readBody(req)),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }));
  });

  const anthropicProvider = createAnthropicProvider({
    apiKey: "test-key",
    model: "claude-test",
    timeoutMs: 5000,
    baseUrl: anthropic.baseUrl,
  });
  assert.deepEqual(await anthropicProvider.generateJson({ system: "sys", user: "usr" }), {
    ok: true,
  });
  assert.equal(anthropicCalls[0].url, "/v1/messages");
  assert.equal(anthropicCalls[0].headers["x-api-key"], "test-key");
  assert.equal(anthropicCalls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(anthropicCalls[0].body.system, "sys");
  anthropic.server.close();

  // A transient 5xx is retried and the run never notices; the free tier sheds
  // load this way in production, especially from cloud egress IPs.
  let flakyCalls = 0;
  const flaky = await listen((req, res) => {
    flakyCalls += 1;
    if (flakyCalls <= 2) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"high demand"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
    );
  });
  const persistent = createGeminiProvider({
    apiKey: "k",
    model: "m",
    timeoutMs: 5000,
    baseUrl: flaky.baseUrl,
    retries: 2,
    retryDelayMs: 0,
  });
  assert.deepEqual(await persistent.generateJson({ system: "s", user: "u" }), { ok: true });
  assert.equal(flakyCalls, 3, "two 503s are absorbed by retries");
  flaky.server.close();

  // ...and a 5xx that outlives the retry budget still degrades, saying so.
  let dyingCalls = 0;
  const dying = await listen((req, res) => {
    dyingCalls += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":"high demand"}');
  });
  const spent = createGeminiProvider({
    apiKey: "k",
    model: "m",
    timeoutMs: 5000,
    baseUrl: dying.baseUrl,
    retries: 2,
    retryDelayMs: 0,
  });
  await assert.rejects(
    () => spent.generateJson({ system: "s", user: "u" }),
    /HTTP 503: .*after 3 attempts/,
  );
  assert.equal(dyingCalls, 3, "the retry budget is bounded");
  dying.server.close();

  // An HTTP error surfaces with its status — and a 429 is NOT retried, because
  // Gemini uses it for exhausted quota and depleted credits, which waiting
  // cannot fix.
  let brokenCalls = 0;
  const broken = await listen((req, res) => {
    brokenCalls += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end('{"error":"rate limited"}');
  });
  const throttled = createGeminiProvider({
    apiKey: "k",
    model: "m",
    timeoutMs: 5000,
    baseUrl: broken.baseUrl,
    retryDelayMs: 0,
  });
  await assert.rejects(() => throttled.generateJson({ system: "s", user: "u" }), /HTTP 429/);
  assert.equal(brokenCalls, 1, "a 429 fails fast without retries");

  // ...and the agent degrades rather than failing the run.
  const degraded = await runIntakeAgent(
    { briefText: demo.brief.text },
    { provider: throttled, heuristics: intakeHeuristics },
  );
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.provider, "local");
  assert.match(degraded.degraded_reason, /HTTP 429/);
  broken.server.close();

  // Non-JSON content is rejected before it can become an artifact.
  const garbage = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "sorry, I cannot" }] }));
  });
  const garbageProvider = createAnthropicProvider({
    apiKey: "k",
    model: "m",
    timeoutMs: 5000,
    baseUrl: garbage.baseUrl,
  });
  await assert.rejects(
    () => garbageProvider.generateJson({ system: "s", user: "u" }),
    /did not return valid JSON/,
  );
  garbage.server.close();

  // A hanging endpoint is aborted by the timeout rather than blocking forever.
  const slow = await listen(() => {});
  const impatient = createGeminiProvider({
    apiKey: "k",
    model: "m",
    timeoutMs: 150,
    baseUrl: slow.baseUrl,
  });
  await assert.rejects(() => impatient.generateJson({ system: "s", user: "u" }));
  slow.server.close();

  console.log("async + adapter test passed");
})();
