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
