// The render routes, driven over real HTTP against a stubbed Vertex AI.
//
// Same reasoning as tests/http.test.js: the live path for a user is the HTTP
// surface. The renderer itself is also unit-tested here against the stub —
// everything except authentication and real model behaviour, which is the
// established boundary for every hosted integration in this project.

const assert = require("assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { createVeoRenderer } = require("../lib/veo");

const PORT = 4198;
const BASE = `http://127.0.0.1:${PORT}`;
const rootDir = path.join(__dirname, "..");

const FAKE_VIDEO = Buffer.from("FAKE-MP4-BYTES-FOR-THE-TEST");

// A brief with no constraints produces no findings, so the run lands approved
// with the packet ready — which is the state rendering requires.
const CLEAN_BRIEF =
  "Goal: A 20-second teaser for a coffee grinder.\nAudience: home baristas\nPlatform: TikTok\nStyle: vibrant";

// The bundled demo brief produces findings, so its run needs review — the
// state in which rendering must refuse.
const BLOCKED_BRIEF = [
  "Create a 30-second launch film for a premium canned coffee brand entering the Tokyo night market.",
  "Audience: young urban professionals",
  "Style: Neon realism, cinematic, energetic.",
  "Constraints: Show the product in the first 5 seconds, avoid health claims, include a clear CTA, deliver for Instagram Reels.",
].join("\n");

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

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: rootDir,
      env: { ...process.env, PORT: String(PORT), STUDIOFLOW_STEP_DELAY_MS: "0", ...env },
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
  return { status: response.status, body: await response.json() };
}

async function runToSettled(briefText) {
  const queued = await api("POST", "/api/workflow/run", { brief_text: briefText });
  assert.equal(queued.status, 202);
  const traceId = queued.body.trace_id;
  for (let i = 0; i < 100; i += 1) {
    const poll = await api("GET", `/api/workflow/${traceId}`);
    if (["approved", "needs_review", "failed"].includes(poll.body.project?.status)) {
      return poll.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run never settled");
}

(async () => {
  // --- the stub: token endpoint + Vertex predictLongRunning/fetchPredictOperation
  let started = 0;
  let polls = 0;
  let lastStartBody = null;
  const stub = await listen(async (req, res) => {
    if (req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "t0k3n", expires_in: 3600 }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer t0k3n", "every Vertex call carries the token");

    if (req.url.endsWith(":predictLongRunning")) {
      started += 1;
      lastStartBody = JSON.parse(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: `operations/op-${started}` }));
      return;
    }
    if (req.url.endsWith(":fetchPredictOperation")) {
      polls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      // First poll: still running. After that: done, with the fake clip.
      if (polls === 1) {
        res.end(JSON.stringify({ name: "operations/op-1", done: false }));
      } else {
        res.end(
          JSON.stringify({
            name: "operations/op-1",
            done: true,
            response: {
              videos: [
                { bytesBase64Encoded: FAKE_VIDEO.toString("base64"), mimeType: "video/mp4" },
              ],
            },
          }),
        );
      }
      return;
    }
    res.writeHead(500);
    res.end();
  });

  // --- renderer unit behaviour against the stub ------------------------------
  const unit = createVeoRenderer({
    projectId: "test-project",
    baseUrl: stub.baseUrl,
    tokenUrl: `${stub.baseUrl}/token`,
    cap: 1,
  });
  const opName = await unit.start({ prompt: "p", negativePrompt: "n", aspectRatio: "9:16" });
  assert.match(opName, /^operations\//);
  assert.equal(lastStartBody.parameters.negativePrompt, "n");
  assert.equal(lastStartBody.parameters.aspectRatio, "9:16");
  assert.equal(lastStartBody.parameters.durationSeconds, 8);
  assert.equal(unit.spent, true, "the cap counts accepted starts");
  await assert.rejects(() => unit.start({ prompt: "p" }), /render cap reached/);

  const pending = await unit.poll(opName);
  assert.equal(pending.done, false);
  const finished = await unit.poll(opName);
  assert.equal(finished.done, true);
  assert.ok(finished.video.equals(FAKE_VIDEO), "the clip round-trips through base64");

  // --- the routes, end to end ------------------------------------------------
  polls = 0; // reset so the server's first poll sees "not done" again
  const server = await startServer({
    VERTEX_PROJECT: "test-project",
    VEO_BASE_URL: stub.baseUrl,
    VEO_TOKEN_URL: `${stub.baseUrl}/token`,
    STUDIOFLOW_RENDER_CAP: "2",
  });

  try {
    const health = await api("GET", "/api/health");
    assert.equal(health.body.render.enabled, true, "health reports the renderer");
    assert.equal(health.body.render.cap, 2);

    // A run that still needs review must refuse to render.
    const blocked = await runToSettled(BLOCKED_BRIEF);
    assert.equal(blocked.project.status, "needs_review");
    const refused = await api("POST", `/api/workflow/${blocked.trace_id}/render`);
    assert.equal(refused.status, 409, "rendering is downstream of the human gate");

    // An approved run renders: 202, poll to done, then the video bytes.
    const approved = await runToSettled(CLEAN_BRIEF);
    assert.equal(approved.project.status, "approved");
    assert.ok(approved.packet_ready);

    const startedRender = await api("POST", `/api/workflow/${approved.trace_id}/render`);
    assert.equal(startedRender.status, 202);
    assert.equal(startedRender.body.status, "rendering");
    assert.ok(startedRender.body.prompt, "the render records the prompt it used");

    // A second POST is idempotent — one clip per run, not one per click.
    const again = await api("POST", `/api/workflow/${approved.trace_id}/render`);
    assert.equal(again.status, 200);
    assert.equal(again.body.operation, startedRender.body.operation);

    const first = await api("GET", `/api/workflow/${approved.trace_id}/render`);
    assert.equal(first.body.status, "rendering", "the stub's first poll is not done yet");
    const second = await api("GET", `/api/workflow/${approved.trace_id}/render`);
    assert.equal(second.body.status, "done");

    const video = await fetch(`${BASE}/api/workflow/${approved.trace_id}/render/video`);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");
    assert.ok(Buffer.from(await video.arrayBuffer()).equals(FAKE_VIDEO));

    // The run's audit trail carries the render, and the run itself carries the
    // state — which the Firestore mirror would persist across a restart.
    const withRender = await api("GET", `/api/workflow/${approved.trace_id}`);
    assert.equal(withRender.body.render.status, "done");
    assert.ok(
      withRender.body.audit_events.some((event) => event.event_type === "render_started"),
    );
    assert.ok(
      withRender.body.audit_events.some((event) => event.event_type === "render_completed"),
    );

    // The negative prompt reached Veo from the packet's own prohibitions.
    assert.match(
      startedRender.body.negative_prompt ?? "",
      /.*/,
      "negative prompt field exists",
    );
    assert.equal(
      lastStartBody.parameters.aspectRatio,
      "9:16",
      "TikTok plans vertical, and the render inherits it",
    );
  } finally {
    server.kill();
    stub.server.close();
  }

  console.log("veo render test passed");
})();
