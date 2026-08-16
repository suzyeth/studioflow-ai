const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { TASK_SEQUENCE, rerunProduction, runTask } = require("./agents/pipeline");

// Keyed by file path, holding the source text the cached value was built from.
//
// The cache deliberately still reads the file on every call. mtime looks like the
// cheaper check, but this filesystem reports mtime at whole-second resolution, so
// two edits inside the same second are indistinguishable and the stale value wins.
// Reading a few KB is not the expensive part — creating the sandbox and evaluating
// the script is, and comparing the source skips that without ever going stale.
const browserGlobalCache = new Map();

// data.js and view-model.js are plain browser scripts loaded via <script> tags.
// Node reads them as text and evaluates them in a sandbox to pull the global out,
// which is what lets a single file serve both runtimes.
//
// Data globals are handed out as fresh copies, because the cache must not let one
// caller mutate the object every later caller receives. Set clone:false for globals
// that are stateless function bags — structuredClone cannot copy functions.
function loadBrowserGlobal(filePath, globalName, { clone = true } = {}) {
  const source = fs.readFileSync(filePath, "utf8");
  const cached = browserGlobalCache.get(filePath);

  if (cached && cached.source === source) {
    return clone ? structuredClone(cached.value) : cached.value;
  }

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.${globalName} = ${globalName};`, sandbox);

  const value = sandbox[globalName];
  browserGlobalCache.set(filePath, { source, value });
  return clone ? structuredClone(value) : value;
}

function loadDemoData(rootDir) {
  return loadBrowserGlobal(path.join(rootDir, "data.js"), "STUDIOFLOW_DEMO");
}

function loadViewModel(rootDir) {
  return loadBrowserGlobal(path.join(rootDir, "view-model.js"), "STUDIOFLOW_VIEW", {
    clone: false,
  });
}

function loadIntakeHeuristics(rootDir) {
  return loadBrowserGlobal(path.join(rootDir, "intake-heuristics.js"), "STUDIOFLOW_INTAKE", {
    clone: false,
  });
}

function loadProductionHeuristics(rootDir) {
  return loadBrowserGlobal(
    path.join(rootDir, "production-heuristics.js"),
    "STUDIOFLOW_PRODUCTION",
    { clone: false },
  );
}


// A run that has been accepted but not executed. The API returns this
// immediately; the worker fills it in task by task, which is what makes the task
// graph observable through polling.
function createQueuedRun(demo, briefText) {
  const now = new Date().toISOString();
  const traceId = `local-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;

  return {
    project: { ...demo.project, status: "queued", updated_at: now },
    brief: {
      raw_text: briefText,
      structured_fields: null,
      structured_brief: null,
      clarifying_questions: [],
      parsed_by: null,
    },
    enforce: {},
    tasks: demo.tasks.map((task) => ({
      ...task,
      state: "queued",
      trace_id: traceId,
      updated_at: now,
    })),
    artifacts: [],
    review_items: [],
    audit_events: [
      {
        id: "audit_1",
        actor_type: "system",
        event_type: "run_accepted",
        message: "Root Orchestrator accepted the brief and queued the workflow run.",
        trace_id: traceId,
        created_at: now,
      },
    ],
    packet_markdown: null,
    metrics: { queued_at: now, task_durations_ms: {} },
    trace_id: traceId,
  };
}

function setTaskState(run, taskId, state) {
  const now = new Date().toISOString();
  return {
    ...run,
    tasks: run.tasks.map((task) =>
      task.id === taskId ? { ...task, state, updated_at: now } : task,
    ),
  };
}

function appendAudit(run, event) {
  return {
    ...run,
    audit_events: [
      ...run.audit_events,
      {
        id: `audit_${run.audit_events.length + 1}`,
        trace_id: run.trace_id,
        created_at: new Date().toISOString(),
        ...event,
      },
    ],
  };
}

// Records one finished agent into the run: its artifact, its audit line, and, for
// the critic, whether the run needs a human.
function applyTaskResult(run, taskId, result, ctx, demo, durationMs) {
  const now = new Date().toISOString();
  const title = demo.artifactTitles[taskId] || taskId;

  let next = {
    ...run,
    artifacts: [
      ...run.artifacts,
      {
        id: `artifact_${taskId}_v1`,
        task_id: `task_${taskId}`,
        type: taskId,
        version: 1,
        title,
        summary: result.summary,
        content_markdown: result.content_markdown,
        generated_by: result.generated_by,
        created_at: now,
        sequence: run.artifacts.length + 1,
      },
    ],
    metrics: {
      ...run.metrics,
      task_durations_ms: { ...run.metrics.task_durations_ms, [taskId]: durationMs },
    },
  };

  next = setTaskState(next, taskId, "completed");
  next = appendAudit(next, {
    actor_type: "agent",
    actor_id: result.agent_id,
    event_type: "task_completed",
    message: result.audit_message,
  });

  if (taskId === "intake") {
    next.brief = {
      ...next.brief,
      structured_brief: ctx.structuredBrief,
      structured_fields: result.artifact.fields,
      clarifying_questions: ctx.clarifyingQuestions,
      parsed_by: result.provider,
    };
    next.project = { ...next.project, title: ctx.structuredBrief.goal };

    if (ctx.clarifyingQuestions.length > 0) {
      next = appendAudit(next, {
        actor_type: "agent",
        actor_id: "intake_agent",
        event_type: "clarification_requested",
        message: `Intake Agent raised ${ctx.clarifyingQuestions.length} clarifying question(s): ${ctx.clarifyingQuestions
          .map((question) => question.question)
          .join(" ")}`,
      });
    }
  }

  if (taskId === "planning") {
    next.project = { ...next.project, title: ctx.plan.subject };
  }

  if (taskId === "critic") {
    const needsReview = ctx.findings.length > 0;
    next.review_items = ctx.findings;
    next.packet_markdown = ctx.packetMarkdown;
    next.project = {
      ...next.project,
      status: needsReview ? "needs_review" : "approved",
      updated_at: now,
    };
    next = setTaskState(next, "critic", needsReview ? "needs_review" : "approved");
    next.metrics = { ...next.metrics, finished_at: now };

    if (needsReview) {
      next = appendAudit(next, {
        actor_type: "agent",
        actor_id: "critic_agent",
        event_type: "review_opened",
        message: `${ctx.findings.length} finding(s) awaiting human approval.`,
      });
    } else {
      next.packet_ready = true;
      next = appendAudit(next, {
        actor_type: "agent",
        actor_id: "critic_agent",
        event_type: "packet_generated",
        message: "No findings. Production packet generated without a review gate.",
      });
    }
  }

  return next;
}

// Executes the whole task sequence against the store, one task at a time, saving
// after every state change so a poller sees the graph advance.
async function executeRun(traceId, { store, demo, agentDeps, stepDelayMs = 0, onStep }) {
  const ctx = {
    briefText: store.get(traceId).brief.raw_text,
    enforce: store.get(traceId).enforce || {},
  };

  store.update(traceId, (run) => ({
    ...run,
    project: { ...run.project, status: "running" },
  }));

  for (const taskId of TASK_SEQUENCE) {
    store.update(traceId, (run) => setTaskState(run, taskId, "running"));
    if (onStep) await onStep(taskId);
    if (stepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }

    const startedAt = Date.now();
    try {
      const result = await runTask(taskId, ctx, agentDeps);
      const durationMs = Date.now() - startedAt;
      store.update(traceId, (run) =>
        applyTaskResult(run, taskId, result, ctx, demo, durationMs),
      );
    } catch (error) {
      store.update(traceId, (run) => {
        const failed = setTaskState(run, taskId, "failed");
        return {
          ...appendAudit(failed, {
            actor_type: "system",
            event_type: "task_failed",
            message: `${taskId} failed: ${error.message}`,
          }),
          project: { ...failed.project, status: "failed" },
        };
      });
      throw error;
    }
  }

  return store.get(traceId);
}

const DEFAULT_MAX_RUNS = 50;

function createRunStore(maxRuns = DEFAULT_MAX_RUNS) {
  const runs = new Map();

  // Deleting before setting moves the entry to the end of the Map's insertion
  // order, so eviction drops the least recently *used* run rather than the
  // oldest created one. A run being walked through a demo keeps itself alive.
  function touch(traceId, run) {
    runs.delete(traceId);
    runs.set(traceId, run);

    while (runs.size > maxRuns) {
      runs.delete(runs.keys().next().value);
    }
  }

  return {
    save(run) {
      touch(run.trace_id, structuredClone(run));
      return structuredClone(run);
    },
    get(traceId) {
      const run = runs.get(traceId);
      if (!run) return null;

      touch(traceId, run);
      return structuredClone(run);
    },
    update(traceId, updater) {
      const current = runs.get(traceId);
      if (!current) return null;

      const next = updater(structuredClone(current));
      touch(traceId, structuredClone(next));
      return structuredClone(next);
    },
    get size() {
      return runs.size;
    },
  };
}

// `context` carries the agent dependencies so a revision can rerun the agents.
// Without them the revision still versions artifacts, but their content stays as
// it was.
async function closeReviewItem(run, reviewId, action, context = {}) {
  const review = run.review_items.find((item) => item.id === reviewId);
  if (!review) {
    throw new Error("Review item not found");
  }

  const now = new Date().toISOString();
  const remainingReviews = run.review_items.filter((item) => item.id !== reviewId);
  const actionLabel = action === "revise" ? "requested revision for" : "approved";

  const nextRun = {
    ...run,
    review_items: remainingReviews,
    audit_events: [
      ...run.audit_events,
      {
        id: `audit_${run.audit_events.length + 1}`,
        actor_type: "user",
        actor_id: "human_reviewer",
        event_type: action === "revise" ? "revision_requested" : "review_approved",
        message: `Human reviewer ${actionLabel} "${review.title}".`,
        trace_id: run.trace_id,
        created_at: now,
      },
    ],
  };

  if (action === "revise") {
    const targetTaskIds = review.target_task_ids || [];

    // Replay the reviewer's constraint through the production agents so the
    // rerun changes the artifact content, not just its version number.
    const enforce = { ...(nextRun.enforce || {}), ...(review.enforce || {}) };
    nextRun.enforce = enforce;

    let regenerated = null;
    if (context.production && nextRun.brief?.structured_brief) {
      regenerated = await rerunProduction(
        {
          structuredBrief: nextRun.brief.structured_brief,
          clarifyingQuestions: nextRun.brief.clarifying_questions || [],
          enforce,
        },
        context,
      );

      nextRun.packet_markdown = context.production.packetMarkdown(
        nextRun.brief.structured_brief,
        {
          shotList: regenerated.ctx.shotList,
          manifest: regenerated.ctx.manifest,
          promptPack: regenerated.ctx.promptPack,
          findings: regenerated.ctx.findings,
        },
      );
    }

    // Reruns produce a new artifact version rather than overwriting v1, so the
    // packet keeps an inspectable revision history.
    nextRun.artifacts = nextRun.artifacts.map((artifact) => {
      if (!targetTaskIds.includes(artifact.type)) {
        return artifact;
      }

      const version = artifact.version + 1;
      const agent = regenerated?.agents?.[artifact.type];

      return {
        ...artifact,
        id: `artifact_${artifact.type}_v${version}`,
        version,
        summary: agent ? agent.summary : artifact.summary,
        content_markdown: agent ? agent.content_markdown : artifact.content_markdown,
        revision_reason: review.title,
        created_at: now,
      };
    });

    nextRun.tasks = nextRun.tasks.map((task) =>
      targetTaskIds.includes(task.id)
        ? { ...task, state: "completed", updated_at: now }
        : task,
    );

    for (const taskId of targetTaskIds) {
      const revised = nextRun.artifacts.find((artifact) => artifact.type === taskId);
      nextRun.audit_events.push({
        id: `audit_${nextRun.audit_events.length + 1}`,
        actor_type: "agent",
        actor_id: `${taskId}_agent`,
        event_type: "artifact_created",
        message: `Rerun after revision request produced ${revised.title} v${revised.version}.`,
        trace_id: run.trace_id,
        created_at: now,
      });
    }
  }

  if (remainingReviews.length === 0) {
    nextRun.project = {
      ...nextRun.project,
      status: "approved",
      updated_at: now,
    };
    nextRun.tasks = nextRun.tasks.map((task) =>
      task.id === "critic" ? { ...task, state: "approved", updated_at: now } : task,
    );
    nextRun.packet_ready = true;
    nextRun.audit_events.push({
      id: `audit_${nextRun.audit_events.length + 1}`,
      actor_type: "agent",
      actor_id: "critic_agent",
      event_type: "packet_generated",
      message: "All review items closed. Production packet generated.",
      trace_id: run.trace_id,
      created_at: now,
    });
  }

  return nextRun;
}

module.exports = {
  appendAudit,
  applyTaskResult,
  closeReviewItem,
  createQueuedRun,
  createRunStore,
  executeRun,
  setTaskState,
  loadBrowserGlobal,
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
  loadViewModel,
};
