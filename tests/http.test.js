// Drives the real HTTP routes against a real server process.
//
// This suite exists because of a bug the other four could not see. The reviews
// route handed an async closeReviewItem to the synchronous runStore.update,
// which tried to structuredClone a promise and returned
// `400 #<Promise> could not be cloned` — so the entire revision loop, the
// product's headline feature, was broken for every browser user while the whole
// suite stayed green. Every other test calls the workflow functions directly;
// none of them had ever been through a route.
//
// The rule this encodes: the live path for a user is the HTTP surface, so
// something has to exercise it as a user does.

const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.STUDIOFLOW_TEST_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const rootDir = path.join(__dirname, "..");

// The audience line is left out so intake has something to ask about.
const BRIEF = [
  "Create a 30-second launch film for a premium canned coffee brand entering the Tokyo night market.",
  "Style: Neon realism, cinematic, energetic.",
  "Constraints: Show the product in the first 5 seconds, avoid health claims, include a clear CTA, deliver for Instagram Reels.",
].join("\n");

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: rootDir,
      env: { ...process.env, PORT: String(PORT), STUDIOFLOW_STEP_DELAY_MS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const failed = setTimeout(() => {
      child.kill();
      reject(new Error("server did not start within 10s"));
    }, 10_000);

    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running at")) {
        clearTimeout(failed);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(failed);
      reject(new Error(`server exited with ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function api(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

async function settle(traceId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { payload } = await api("GET", `/api/workflow/${traceId}`);
    if (!["queued", "running"].includes(payload.project.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run never settled");
}

(async () => {
  const server = await startServer();

  try {
    // --- health ---------------------------------------------------------------
    const health = await api("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.payload.ok, true);
    assert.ok(
      ["local", "gemini", "anthropic"].includes(health.payload.intake_provider),
      "health names the provider that is actually live",
    );

    // --- a run starts queued and is executed in the background ----------------
    const started = await api("POST", "/api/workflow/run", { brief_text: BRIEF });
    assert.equal(started.status, 202, "POST /run returns 202, not a finished run");
    assert.equal(started.payload.project.status, "queued");
    assert.ok(
      started.payload.tasks.every((task) => task.state === "queued"),
      "no task has run by the time the response is sent",
    );

    let run = await settle(started.payload.trace_id);
    assert.equal(run.project.status, "needs_review");
    assert.equal(run.artifacts.length, 6);

    // --- intake asked, and said so in the review queue -------------------------
    assert.equal(run.brief.clarifying_questions.length, 1, "one question: the audience");
    const question = run.brief.clarifying_questions[0];
    assert.ok(question.fills, "a question names the field its answer fills");
    assert.ok(question.why_it_matters, "and why it blocks planning");
    assert.ok(
      run.review_items.some((item) => item.id === "open-questions"),
      "the run reports that it proceeded on incomplete information",
    );

    // --- answering reruns the workflow against an augmented brief -------------
    const answered = await api(
      "POST",
      `/api/workflow/${started.payload.trace_id}/clarifications`,
      { answers: { [question.id]: "Young urban professionals" } },
    );
    assert.equal(answered.status, 202);
    assert.notEqual(
      answered.payload.trace_id,
      started.payload.trace_id,
      "answering produces a new run rather than mutating the old one",
    );

    run = await settle(answered.payload.trace_id);
    assert.equal(run.brief.clarifying_questions.length, 0, "the question is resolved");
    assert.match(run.brief.structured_brief.audience, /Young urban professionals/);
    assert.ok(
      !run.review_items.some((item) => item.id === "open-questions"),
      "and the finding it caused is gone",
    );

    // --- the revision loop, over HTTP -----------------------------------------
    // The regression this suite was written for. It must change content, not
    // just a version number, and it must not 400.
    const before = run.artifacts.find((artifact) => artifact.type === "shots");
    assert.equal(before.version, 1);

    const revised = await api(
      "POST",
      `/api/workflow/${answered.payload.trace_id}/reviews/hero-window`,
      { action: "revise" },
    );
    assert.equal(
      revised.status,
      200,
      `revise must succeed over HTTP, got ${revised.status}: ${JSON.stringify(revised.payload).slice(0, 160)}`,
    );

    const after = revised.payload.artifacts.find((artifact) => artifact.type === "shots");
    assert.equal(after.version, 2, "the shot list is re-versioned");
    assert.notEqual(
      after.content_markdown,
      before.content_markdown,
      "the rerun changed the content, not only the version",
    );
    assert.ok(
      revised.payload.enforce && revised.payload.enforce.heroFirst,
      "the correction is kept as state so later reruns carry it",
    );
    assert.ok(
      !revised.payload.review_items.some((item) => item.id === "hero-window"),
      "the finding does not survive its own fix",
    );

    // --- approving the last finding closes the run ----------------------------
    const remaining = revised.payload.review_items[0];
    const approved = await api(
      "POST",
      `/api/workflow/${answered.payload.trace_id}/reviews/${remaining.id}`,
      { action: "approve" },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.project.status, "approved");
    assert.ok(approved.payload.packet_ready, "the packet is ready once the queue empties");
    assert.ok(
      approved.payload.audit_events.some((event) => event.event_type === "packet_generated"),
      "and the audit trail records it",
    );

    // --- bad input is rejected rather than swallowed --------------------------
    assert.equal((await api("GET", "/api/workflow/nope")).status, 404);
    assert.equal(
      (await api("POST", `/api/workflow/${answered.payload.trace_id}/reviews/nope`, { action: "approve" })).status,
      400,
      "an unknown review item is an error, not a silent no-op",
    );
    assert.equal(
      (await api("POST", `/api/workflow/${answered.payload.trace_id}/reviews/${remaining.id}`, { action: "shrug" })).status,
      400,
      "an unknown action is rejected",
    );
    assert.equal((await api("GET", "/api/nothing-here")).status, 404);

    console.log("http route test passed");
  } finally {
    server.kill();
  }
})();
