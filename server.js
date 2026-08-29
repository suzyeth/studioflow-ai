const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  closeReviewItem,
  createQueuedRun,
  createRunStore,
  executeRun,
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
} = require("./lib/workflow");
const { createProvider } = require("./lib/llm");
const { createJobQueue } = require("./lib/queue");
const { createFirestoreMirror, withMirror } = require("./lib/store-firestore");
const { createVeoRenderer } = require("./lib/veo");
const { runRenderCritic } = require("./lib/agents/render-critic");
const { runConformanceAudit } = require("./lib/agents/conformance");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
// Pacing only. Agent work here is fast enough to finish before a poller ever sees
// a task running, which would hide the very thing the task graph exists to show.
const STEP_DELAY_MS = Number(process.env.STUDIOFLOW_STEP_DELAY_MS || 450);

// FIRESTORE_PROJECT turns on the Firestore mirror: the in-memory store stays
// the synchronous source of truth, every write is mirrored in the background,
// and a Map miss rehydrates from Firestore — so runs survive a restart and a
// second instance. Unset, the store is exactly what it always was.
const mirror = process.env.FIRESTORE_PROJECT
  ? createFirestoreMirror({
      projectId: process.env.FIRESTORE_PROJECT,
      baseUrl: process.env.FIRESTORE_BASE_URL || undefined,
      tokenUrl: process.env.FIRESTORE_TOKEN_URL || undefined,
    })
  : null;

const memoryStore = createRunStore();
const runStore = withMirror(memoryStore, mirror);

// The Veo renderer turns the approved packet's hero shot into one 8-second
// clip. It needs a GCP project (Vertex AI billing) and is off without one;
// STUDIOFLOW_VEO=off disables it explicitly. The cap is a hard cost ceiling —
// the URL is public and every render is billed.
const veoProject = process.env.VERTEX_PROJECT || process.env.FIRESTORE_PROJECT;
const veo =
  veoProject && process.env.STUDIOFLOW_VEO !== "off"
    ? createVeoRenderer({
        projectId: veoProject,
        model: process.env.VEO_MODEL || undefined,
        baseUrl: process.env.VEO_BASE_URL || undefined,
        tokenUrl: process.env.VEO_TOKEN_URL || process.env.FIRESTORE_TOKEN_URL || undefined,
        cap: Number(process.env.STUDIOFLOW_RENDER_CAP || 10),
      })
    : null;

// Delivered-cut audits are metered like renders: the URL is public and every
// audit is a billed multimodal call.
let auditsUsed = 0;
const AUDIT_CAP = Number(process.env.STUDIOFLOW_AUDIT_CAP || 20);
const AUDIT_MAX_BYTES = 15_000_000;

// Decoded clips, keyed by trace id. A restart loses this cache but not the
// render: the operation name lives on the run (mirrored to Firestore), so the
// video route re-fetches the finished operation and refills the cache.
const videoCache = new Map();
const VIDEO_CACHE_MAX = 5;

function cacheVideo(traceId, entry) {
  videoCache.delete(traceId);
  videoCache.set(traceId, entry);
  while (videoCache.size > VIDEO_CACHE_MAX) {
    videoCache.delete(videoCache.keys().next().value);
  }
}

function latestArtifact(run, type) {
  const matching = run.artifacts.filter((artifact) => artifact.type === type);
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

// A run that fell out of the Map (restart, LRU eviction, another instance)
// comes back from the mirror. Rehydration writes through memoryStore, not
// runStore, so it does not echo the same document straight back to Firestore.
async function loadRun(traceId) {
  const run = runStore.get(traceId);
  if (run || !mirror) return run;

  const persisted = await mirror.fetch(traceId);
  if (!persisted) return null;

  memoryStore.save(persisted);
  return runStore.get(traceId);
}
const intakeHeuristics = loadIntakeHeuristics(ROOT);
const production = loadProductionHeuristics(ROOT);
const provider = createProvider(intakeHeuristics);
const queue = createJobQueue({
  onError: (error) => console.error(`[worker] ${error.message}`),
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // docs/architecture.svg is a submission deliverable; serving it from the
  // deployed URL means the diagram in the demo video is the deployed one.
  ".svg": "image/svg+xml; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Binary body reader for the delivered-cut audit. The limit tracks what a
// single inline Gemini request can carry — an over-limit upload is refused
// with the reason, not truncated.
function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Video too large — the audit accepts up to ${Math.round(maxBytes / 1_000_000)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      // Cloud Run injects K_SERVICE and K_REVISION; their absence is what makes
      // this a local process. Reporting them means this one response is the
      // deployment evidence — the demo points a cursor at it rather than at a
      // console tab, and it can no longer say "local" while serving from Cloud Run.
      service: process.env.K_SERVICE || "studioflow-local",
      revision: process.env.K_REVISION || null,
      runtime: process.env.K_SERVICE ? "cloud-run" : "local",
      // Which model is CONFIGURED for the Intake Agent. Note the word: a call can
      // still fail and degrade to the keyless parser, and this field will not say
      // so. `parsed_by` on a run is the only honest answer to "did the model
      // actually run"; see the degraded_reason in that run's audit trail.
      intake_provider: provider.name,
      intake_model: provider.model || null,
      queue: { depth: queue.depth, busy: queue.busy, processed: queue.processed },
      // Whether runs survive a restart, and whether the last mirror write
      // landed. A stuck mirror shows up here rather than failing a run.
      store: mirror
        ? { mirror: "firestore", project: mirror.projectId, last_error: mirror.lastError }
        : { mirror: "none" },
      render: veo
        ? { enabled: true, model: veo.model, used: veo.used, cap: veo.cap }
        : { enabled: false },
      step_delay_ms: STEP_DELAY_MS,
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/demo") {
    sendJson(res, 200, loadDemoData(ROOT));
    return;
  }

  if (req.method === "POST" && pathname === "/api/workflow/run") {
    try {
      const body = await readRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const demo = loadDemoData(ROOT);
      const briefText = payload.brief_text || demo.brief.text;

      // Accept the work and return immediately; the queue runs the agents. The
      // client polls GET /api/workflow/:traceId to watch the graph advance.
      const queued = runStore.save(createQueuedRun(demo, briefText));

      queue.push(() =>
        executeRun(queued.trace_id, {
          store: runStore,
          demo,
          agentDeps: { provider, intakeHeuristics, production },
          stepDelayMs: STEP_DELAY_MS,
        }),
      );

      sendJson(res, 202, queued);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  const workflowMatch = pathname.match(/^\/api\/workflow\/([^/]+)$/);
  if (req.method === "GET" && workflowMatch) {
    const run = await loadRun(workflowMatch[1]);
    if (!run) {
      sendJson(res, 404, { error: "Workflow run not found" });
      return;
    }
    sendJson(res, 200, run);
    return;
  }

  // Answering intake's questions re-runs the whole workflow against an augmented
  // brief, which is the honest way to fold new information in: everything
  // downstream of intake depends on it.
  const clarifyMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/clarifications$/);
  if (req.method === "POST" && clarifyMatch) {
    try {
      const body = await readRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const existing = await loadRun(clarifyMatch[1]);

      if (!existing) {
        sendJson(res, 404, { error: "Workflow run not found" });
        return;
      }

      const answers = payload.answers || {};
      const questions = existing.brief.clarifying_questions || [];
      // Fold answers back as labelled brief lines so intake reads them exactly
      // the way it reads the original brief.
      const answered = questions
        .filter((question) => String(answers[question.id] || "").trim())
        .map((question) => {
          const value = String(answers[question.id]).trim();
          return question.fills ? `${question.fills}: ${value}` : `${question.question} ${value}`;
        });

      if (answered.length === 0) {
        sendJson(res, 400, { error: "No answers supplied" });
        return;
      }

      const demo = loadDemoData(ROOT);
      const augmented = `${existing.brief.raw_text}\n${answered.join("\n")}`;
      const queued = runStore.save(createQueuedRun(demo, augmented));

      queue.push(() =>
        executeRun(queued.trace_id, {
          store: runStore,
          demo,
          agentDeps: { provider, intakeHeuristics, production },
          stepDelayMs: STEP_DELAY_MS,
        }),
      );

      sendJson(res, 202, queued);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Render the approved packet's hero shot with Veo. Deliberately downstream
  // of the human gate: nothing renders until every review item is closed and
  // the packet is ready. One render per run; the operation name is saved on
  // the run (and mirrored), so the result survives a restart.
  const renderMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/render$/);
  if (req.method === "POST" && renderMatch) {
    try {
      if (!veo) {
        sendJson(res, 503, { error: "Rendering is not configured on this deployment" });
        return;
      }
      const run = await loadRun(renderMatch[1]);
      if (!run) {
        sendJson(res, 404, { error: "Workflow run not found" });
        return;
      }
      if (!run.packet_ready) {
        sendJson(res, 409, {
          error: "Rendering follows approval — close the review items first",
        });
        return;
      }
      if (run.render && run.render.status !== "failed") {
        sendJson(res, 200, run.render);
        return;
      }
      if (veo.spent) {
        sendJson(res, 429, { error: `Render budget spent (${veo.cap} per instance)` });
        return;
      }

      const shots = latestArtifact(run, "shots");
      const prompts = latestArtifact(run, "prompts");
      const hero = shots?.data?.shots?.find((shot) => shot.is_hero);
      const heroPrompt = prompts?.data?.prompts?.find(
        (prompt) => prompt.shot_id === hero?.id,
      );
      if (!hero || !heroPrompt) {
        sendJson(res, 422, {
          error: "This run predates render support — run the workflow again",
        });
        return;
      }

      const negativePrompt = (prompts.data.shared_negative_prompt || []).join(", ");
      const aspectRatio = shots.data.aspect_ratio?.includes("9:16") ? "9:16" : "16:9";

      const operation = await veo.start({
        prompt: heroPrompt.prompt,
        negativePrompt: negativePrompt || undefined,
        aspectRatio,
      });

      const render = {
        status: "rendering",
        model: veo.model,
        shot_id: hero.id,
        timecode: hero.timecode,
        prompt: heroPrompt.prompt,
        negative_prompt: negativePrompt || null,
        operation,
        started_at: new Date().toISOString(),
      };
      const updated = runStore.update(run.trace_id, (current) => ({
        ...current,
        render,
        audit_events: [
          ...current.audit_events,
          {
            id: `audit_${current.audit_events.length + 1}`,
            trace_id: current.trace_id,
            created_at: new Date().toISOString(),
            actor_type: "agent",
            actor_id: "render_agent",
            event_type: "render_started",
            message: `Render Agent sent the approved hero shot (${hero.timecode}) to ${veo.model}, inheriting ${prompts.data.shared_negative_prompt?.length || 0} negative prompt(s) from the brief.`,
          },
        ],
      }));

      sendJson(res, 202, updated ? updated.render : render);
    } catch (error) {
      sendJson(res, 502, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && renderMatch) {
    try {
      const run = await loadRun(renderMatch[1]);
      if (!run) {
        sendJson(res, 404, { error: "Workflow run not found" });
        return;
      }
      if (!run.render) {
        sendJson(res, 200, { status: "none", available: Boolean(veo && !veo.spent) });
        return;
      }
      if (run.render.status !== "rendering" || !veo) {
        sendJson(res, 200, run.render);
        return;
      }

      const result = await veo.poll(run.render.operation);
      if (!result.done) {
        sendJson(res, 200, run.render);
        return;
      }

      const status = result.filtered ? "filtered" : "done";
      if (result.video) {
        cacheVideo(run.trace_id, { video: result.video, mimeType: result.mimeType });
      }

      // The Render Critic closes the loop: the finished clip is judged against
      // the brief's own constraints by a model that can watch it. Advisory —
      // it annotates the clip for the human, never blocks it — and any failure
      // reports the audit as skipped rather than inventing verdicts.
      let audit = null;
      if (status === "done" && result.video) {
        const shotsData = latestArtifact(run, "shots")?.data;
        audit = await runRenderCritic(
          {
            video: result.video,
            mimeType: result.mimeType,
            constraints: run.brief?.structured_brief?.constraints || [],
            subject: shotsData?.subject,
            // Scoped to the single shot that was rendered: most of the film's
            // constraints are not this clip's to answer, and judging them here
            // produced false verdicts in both directions. See the note at the
            // top of lib/agents/render-critic.js.
            shot: shotsData?.shots?.find((entry) => entry.id === run.render?.shot_id) || null,
            scope: "shot",
          },
          { provider },
        );
      }

      const updated = runStore.update(run.trace_id, (current) => {
        const events = [
          {
            actor_type: "agent",
            actor_id: "render_agent",
            event_type: status === "done" ? "render_completed" : "render_filtered",
            message:
              status === "done"
                ? "Render Agent delivered the hero shot clip."
                : "Veo's safety filter removed the clip; the packet stands on its own.",
          },
        ];
        if (audit) {
          events.push({
            actor_type: "agent",
            actor_id: "render_critic",
            event_type: audit.status === "done" ? "render_audited" : "render_audit_skipped",
            message:
              audit.status === "done"
                ? `Render Critic watched the clip against ${audit.verdicts.length} check(s): ${audit.verdicts.filter((v) => v.verdict === "pass").length} pass, ${audit.verdicts.filter((v) => v.verdict === "fail").length} fail, ${audit.verdicts.filter((v) => v.verdict === "cannot_tell").length} cannot tell.`
                : `Render Critic could not audit the clip (${audit.reason}).`,
          });
        }
        return {
          ...current,
          render: {
            ...current.render,
            status,
            audit,
            finished_at: new Date().toISOString(),
          },
          audit_events: [
            ...current.audit_events,
            ...events.map((event, index) => ({
              id: `audit_${current.audit_events.length + 1 + index}`,
              trace_id: current.trace_id,
              created_at: new Date().toISOString(),
              ...event,
            })),
          ],
        };
      });

      sendJson(res, 200, updated ? updated.render : { ...run.render, status, audit });
    } catch (error) {
      sendJson(res, 502, { error: error.message });
    }
    return;
  }

  // Audit a delivered cut: the user uploads the finished video and the Render
  // Critic judges it against the brief's own constraints — the same check
  // list that governed the plan now judges the delivery. This is the answer
  // to "the editor sent the final cut; did it survive the brief?"
  const auditMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/audit$/);
  if (req.method === "POST" && auditMatch) {
    try {
      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.startsWith("video/")) {
        sendJson(res, 415, { error: "Send the video itself, with a video/* content type" });
        return;
      }
      const video = await readBinaryBody(req, AUDIT_MAX_BYTES);
      if (video.length === 0) {
        sendJson(res, 400, { error: "The uploaded video is empty" });
        return;
      }

      const run = await loadRun(auditMatch[1]);
      if (!run) {
        sendJson(res, 404, { error: "Workflow run not found" });
        return;
      }
      if (!run.brief?.structured_brief) {
        sendJson(res, 409, { error: "Run the workflow first — the audit needs the brief's constraints" });
        return;
      }
      if (auditsUsed >= AUDIT_CAP) {
        sendJson(res, 429, { error: `Audit budget spent (${AUDIT_CAP} per instance)` });
        return;
      }

      auditsUsed += 1;
      const deliveredShotList = latestArtifact(run, "shots")?.data;

      // Two questions, asked separately because they fail separately: does the
      // cut honour the brief, and is it the film that was approved. The second
      // is the one with the strongest evidence — its standard is the shot list
      // a human signed off on, not the model's opinion.
      const conformance = await runConformanceAudit(
        { video, mimeType: contentType.split(";")[0], shotList: deliveredShotList },
        { provider },
      );

      const audit = await runRenderCritic(
        {
          video,
          mimeType: contentType.split(";")[0],
          constraints: run.brief.structured_brief.constraints || [],
          subject: latestArtifact(run, "shots")?.data?.subject,
          // A delivered cut is the whole film, so every constraint is fair
          // game — unlike a single rendered shot.
          scope: "delivery",
        },
        { provider },
      );

      const record = {
        ...audit,
        conformance,
        source: "uploaded",
        size_bytes: video.length,
        at: new Date().toISOString(),
      };
      runStore.update(run.trace_id, (current) => ({
        ...current,
        uploaded_audit: record,
        audit_events: [
          ...current.audit_events,
          {
            id: `audit_${current.audit_events.length + 1}`,
            trace_id: current.trace_id,
            created_at: new Date().toISOString(),
            actor_type: "agent",
            actor_id: "render_critic",
            event_type: audit.status === "done" ? "delivery_audited" : "delivery_audit_skipped",
            message:
              audit.status === "done"
                ? `Render Critic watched a delivered cut (${Math.round(video.length / 1_000_000)}MB) against ${audit.verdicts.length} check(s): ${audit.verdicts.filter((v) => v.verdict === "pass").length} pass, ${audit.verdicts.filter((v) => v.verdict === "fail").length} fail, ${audit.verdicts.filter((v) => v.verdict === "cannot_tell").length} cannot tell.${conformance.status === "done" ? ` Against the approved shot list: ${conformance.summary.present} present, ${conformance.summary.missing} missing, ${conformance.summary.uncertain} uncertain, ${conformance.summary.unplanned} unplanned.` : ""}`
                : `Render Critic could not audit the delivered cut (${audit.reason}).`,
          },
        ],
      }));

      sendJson(res, audit.status === "done" ? 200 : 502, record);
    } catch (error) {
      const status = /too large/i.test(error.message) ? 413 : 400;
      sendJson(res, status, { error: error.message });
    }
    return;
  }

  const videoMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/render\/video$/);
  if (req.method === "GET" && videoMatch) {
    try {
      const traceId = videoMatch[1];
      let entry = videoCache.get(traceId);

      // Cache miss after a restart: the operation name on the (rehydrated) run
      // still points at the finished render.
      if (!entry && veo) {
        const run = await loadRun(traceId);
        if (run?.render?.operation && run.render.status === "done") {
          const result = await veo.poll(run.render.operation);
          if (result.done && result.video) {
            entry = { video: result.video, mimeType: result.mimeType };
            cacheVideo(traceId, entry);
          }
        }
      }

      if (!entry) {
        sendJson(res, 404, { error: "No rendered video for this run" });
        return;
      }
      res.writeHead(200, {
        "content-type": entry.mimeType,
        "content-length": entry.video.length,
        "cache-control": "no-store",
      });
      res.end(entry.video);
    } catch (error) {
      sendJson(res, 502, { error: error.message });
    }
    return;
  }

  const reviewMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/reviews\/([^/]+)$/);
  if (req.method === "POST" && reviewMatch) {
    try {
      const body = await readRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const action = payload.action;

      if (!["approve", "revise"].includes(action)) {
        sendJson(res, 400, { error: "Review action must be approve or revise" });
        return;
      }

      const existing = await loadRun(reviewMatch[1]);
      if (!existing) {
        sendJson(res, 404, { error: "Workflow run not found" });
        return;
      }

      // closeReviewItem is async, because a revision reruns the production
      // agents. runStore.update is deliberately synchronous and clones what the
      // updater returns, so handing it this call produced a promise it could not
      // clone — a 400 that silently broke the entire revision loop over HTTP
      // while every test, which calls closeReviewItem directly, stayed green.
      // The await has to happen here, before the result reaches the store.
      const updatedRun = runStore.save(
        await closeReviewItem(existing, reviewMatch[2], action, {
          provider,
          intakeHeuristics,
          production,
        }),
      );

      sendJson(res, 200, updatedRun);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

function safeStaticPath(pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;

  let decoded;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    // Malformed percent-encoding such as "/%" throws URIError.
    return null;
  }

  const filePath = path.normalize(path.join(ROOT, decoded));
  // A bare startsWith(ROOT) also accepts sibling directories like
  // "<ROOT>-backup", so the separator has to be part of the comparison.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return null;
  }
  return filePath;
}

function handleStatic(req, res, pathname) {
  const filePath = safeStaticPath(pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // A throw or rejection here would take the whole process down, so every
  // request path has to fail into a response instead.
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url.pathname).catch((error) => {
        sendJson(res, 500, { error: error.message });
      });
      return;
    }

    handleStatic(req, res, url.pathname);
  } catch (error) {
    sendText(res, 400, "Bad request");
  }
});

// A configured mirror that cannot reach Firestore is a misconfiguration, and
// misconfiguration fails loudly at boot — not silently mid-demo, with the
// operator believing runs are durable.
const ready = mirror ? mirror.probe() : Promise.resolve();

ready
  .then(() => {
    server.listen(PORT, () => {
      console.log(`StudioFlow AI local server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(`FIRESTORE_PROJECT is set but Firestore is unreachable: ${error.message}`);
    process.exit(1);
  });
