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
const { createGeminiProvider } = require("../lib/llm");
const { buildChecks, runRenderCritic } = require("../lib/agents/render-critic");

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
  // --- the stub: one server plays the metadata token endpoint, Vertex (Veo),
  // and the Gemini API (intake, shots, and the Render Critic's video call).
  let started = 0;
  let polls = 0;
  let lastStartBody = null;
  let lastVideoCall = null;
  const stub = await listen(async (req, res) => {
    if (req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "t0k3n", expires_in: 3600 }));
      return;
    }

    // The Gemini API side — authenticated by header, not by bearer token.
    if (req.url.includes(":generateContent")) {
      assert.equal(req.headers["x-goog-api-key"], "test-key");
      const body = JSON.parse(await readBody(req));
      const parts = body.contents[0].parts;
      const system = (body.systemInstruction?.parts || []).map((part) => part.text).join("");
      const userText = parts.filter((part) => part.text).map((part) => part.text).join("\n");
      const videoPart = parts.find((part) => part.inlineData);

      let payload;
      if (videoPart) {
        lastVideoCall = videoPart.inlineData;
        const count = Number((userText.match(/Exactly (\d+) verdict/) || [])[1] || 0);
        payload = {
          verdicts: Array.from({ length: count }, (_, index) => ({
            check: `paraphrased check ${index}`,
            verdict: index === 0 ? "pass" : "cannot_tell",
            evidence: `Saw item ${index} in the clip.`,
          })),
        };
      } else if (/Shot Agent/.test(system)) {
        const ids = [...userText.matchAll(/- (shot_\d+) \(/g)].map((m) => m[1]);
        payload = {
          descriptions: Object.fromEntries(ids.map((id, i) => [id, `Stub frame ${i + 1}`])),
        };
      } else if (/Tokyo night market/.test(userText)) {
        payload = {
          structured_brief: {
            goal: "A 30-second launch film for a premium canned coffee brand entering the Tokyo night market",
            audience: "young urban professionals",
            platform: "Instagram Reels",
            duration_seconds: 30,
            style: ["Neon realism"],
            constraints: [
              "Show the product in the first 5 seconds",
              "avoid health claims",
              "include a clear CTA",
              "deliver for Instagram Reels",
            ],
            success_criteria: [],
          },
          clarifying_questions: [],
        };
      } else {
        payload = {
          structured_brief: {
            goal: "A 20-second teaser for a coffee grinder",
            audience: "home baristas",
            platform: "TikTok",
            duration_seconds: 20,
            style: ["vibrant"],
            constraints: [],
            success_criteria: [],
          },
          clarifying_questions: [],
        };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
        }),
      );
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

  // --- the Render Critic unit behaviour --------------------------------------
  // The provider's video call carries the clip inline.
  const videoProvider = createGeminiProvider({
    apiKey: "test-key",
    model: "gemini-stub",
    timeoutMs: 5000,
    baseUrl: stub.baseUrl,
    retryDelayMs: 0,
  });
  const clip = Buffer.from("tiny-clip-bytes");
  const unitAudit = await runRenderCritic(
    { video: clip, mimeType: "video/mp4", constraints: ["no dogs"], subject: "a kettle" },
    { provider: videoProvider },
  );
  assert.equal(unitAudit.status, "done");
  assert.equal(unitAudit.verdicts.length, 2, "subject check plus one constraint");
  assert.equal(lastVideoCall.data, clip.toString("base64"), "the clip travelled inline");
  assert.equal(lastVideoCall.mimeType, "video/mp4");
  assert.match(
    unitAudit.verdicts[0].check,
    /a kettle/,
    "the authoritative check text is ours — the model's paraphrase never reaches a human",
  );
  assert.equal(unitAudit.verdicts[1].check, "no dogs");

  // --- scoping: a clip is only asked what a clip can answer -------------------
  // The bug this prevents, seen live before it was fixed: rendering the hero
  // shot of a 30s film and asking "does it include a clear CTA?" failed the
  // clip for the film's job, while "show the product in the first 5 seconds"
  // PASSED off the clip's own clock even though that shot starts at 0:10.
  const FILM = [
    "Show the product in the first 5 seconds",
    "avoid health claims",
    "include a clear CTA",
    "deliver for Instagram Reels",
  ];
  const heroShot = { id: "shot_3", is_hero: true, is_cta: false };
  const ctaShot = { id: "shot_6", is_hero: false, is_cta: true };

  const heroScope = buildChecks(FILM, "a coffee brand", { scope: "shot", shot: heroShot });
  assert.deepEqual(
    heroScope.checks,
    ["The subject — a coffee brand — appears clearly in the clip", "avoid health claims"],
    "a hero clip answers for the subject and for prohibitions, nothing else",
  );
  assert.deepEqual(
    heroScope.outOfScope.map((entry) => entry.check),
    ["Show the product in the first 5 seconds", "include a clear CTA", "deliver for Instagram Reels"],
    "timing, another shot's CTA, and delivery are reported as out of scope, not judged",
  );
  assert.ok(
    heroScope.outOfScope.every((entry) => entry.reason && entry.reason.length > 10),
    "every skipped constraint carries a reason — a silent drop reads as a pass",
  );

  // The CTA shot is the one that answers for the CTA, and it does not answer
  // for the subject reveal.
  const ctaScope = buildChecks(FILM, "a coffee brand", { scope: "shot", shot: ctaShot });
  assert.ok(ctaScope.checks.includes("include a clear CTA"));
  assert.ok(!ctaScope.checks.some((check) => check.startsWith("The subject")));

  // A delivered cut is the whole film: everything is fair game.
  const deliveryScope = buildChecks(FILM, "a coffee brand", { scope: "delivery" });
  assert.equal(deliveryScope.checks.length, FILM.length + 1);
  assert.deepEqual(deliveryScope.outOfScope, []);

  // Nothing in scope means no model call at all — being told "out of scope"
  // is not worth a paid multimodal request.
  let called = 0;
  const counting = {
    name: "gemini",
    async generateJsonFromVideo() {
      called += 1;
      return { verdicts: [] };
    },
  };
  const nothingToAsk = await runRenderCritic(
    {
      video: Buffer.from("x"),
      constraints: ["deliver for Instagram Reels"],
      subject: "x",
      shot: ctaShot,
      scope: "shot",
    },
    { provider: counting },
  );
  assert.equal(nothingToAsk.status, "done");
  assert.deepEqual(nothingToAsk.verdicts, []);
  assert.equal(nothingToAsk.out_of_scope.length, 2);
  assert.equal(called, 0, "no model call when there is nothing in scope to ask");

  // A provider that cannot watch video skips honestly instead of guessing.
  const blind = await runRenderCritic(
    { video: clip, constraints: [], subject: "x" },
    { provider: { name: "local", async generateJson() {} } },
  );
  assert.equal(blind.status, "skipped");
  assert.match(blind.reason, /cannot watch video/);

  // A verdict-count mismatch is a schema failure, and schema failures skip.
  const miscounting = {
    name: "gemini",
    async generateJsonFromVideo() {
      return { verdicts: [{ check: "only one", verdict: "pass", evidence: "e" }] };
    },
  };
  const mismatched = await runRenderCritic(
    // Prohibitions, so both stay in scope and three checks are expected —
    // the point here is the count mismatch, not the scoping.
    { video: clip, constraints: ["no dogs", "no cats"], subject: "x" },
    { provider: miscounting },
  );
  assert.equal(mismatched.status, "skipped");
  assert.match(mismatched.reason, /schema validation failed/);

  // --- the routes, end to end ------------------------------------------------
  polls = 0; // reset so the server's first poll sees "not done" again
  const server = await startServer({
    VERTEX_PROJECT: "test-project",
    VEO_BASE_URL: stub.baseUrl,
    VEO_TOKEN_URL: `${stub.baseUrl}/token`,
    STUDIOFLOW_RENDER_CAP: "2",
    GEMINI_API_KEY: "test-key",
    GEMINI_BASE_URL: stub.baseUrl,
    GEMINI_MODEL: "gemini-stub",
    STUDIOFLOW_LLM_RETRIES: "0",
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

    // The Render Critic watched the finished clip against the brief's checks.
    assert.equal(second.body.audit.status, "done");
    assert.equal(
      second.body.audit.verdicts.length,
      1,
      "a constraint-free brief still gets the subject-visibility check",
    );
    assert.match(second.body.audit.verdicts[0].check, /The subject/);
    assert.ok(
      !/paraphrased check/.test(second.body.audit.verdicts[0].check),
      "the model's paraphrase never replaces the authoritative check text",
    );

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
    assert.ok(
      withRender.body.audit_events.some((event) => event.event_type === "render_audited"),
      "the clip audit lands in the same trail as everything else",
    );
    assert.equal(
      withRender.body.artifacts.find((a) => a.type === "shots").generated_by,
      "gemini",
      "the stubbed model wrote the shot descriptions end to end",
    );

    // --- the delivered-cut audit ---------------------------------------------
    // Uploading a finished video gets the same verdicts against the same brief.
    const cut = Buffer.from("DELIVERED-CUT-BYTES");
    const uploaded = await fetch(`${BASE}/api/workflow/${approved.trace_id}/audit`, {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: cut,
    });
    assert.equal(uploaded.status, 200);
    const uploadedAudit = await uploaded.json();
    assert.equal(uploadedAudit.status, "done");
    assert.equal(uploadedAudit.source, "uploaded");
    assert.equal(uploadedAudit.size_bytes, cut.length);
    assert.equal(
      lastVideoCall.data,
      cut.toString("base64"),
      "the uploaded bytes are what the model watched",
    );

    // A non-video upload is refused before any model call.
    const notVideo = await fetch(`${BASE}/api/workflow/${approved.trace_id}/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(notVideo.status, 415);

    // The audit lands on the run and in the trail, like everything else.
    const audited = await api("GET", `/api/workflow/${approved.trace_id}`);
    assert.equal(audited.body.uploaded_audit.status, "done");
    assert.ok(
      audited.body.audit_events.some((event) => event.event_type === "delivery_audited"),
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
