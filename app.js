const { escapeHtml, normalizeApiRun } = STUDIOFLOW_VIEW;

const POLL_INTERVAL_MS = 250;

let demo = STUDIOFLOW_DEMO;

const state = {
  tasks: structuredClone(demo.tasks),
  artifacts: [],
  audit: [],
  reviews: [],
  packetReady: false,
  packetMarkdown: null,
  projectTitle: null,
  status: null,
  metrics: null,
  health: null,
  briefFields: null,
  clarifyingQuestions: [],
  // Offline pipeline output; null whenever the API path is driving.
  local: null,
  running: false,
  traceId: null,
  // Hero-shot render state from the server; stays null on the offline path,
  // which is what renderRenderPanel uses to explain instead of offering.
  render: null,
  rendering: false,
};

const nodes = {
  navItems: document.querySelectorAll(".nav-item"),
  views: document.querySelectorAll(".view"),
  taskList: document.getElementById("taskList"),
  artifactList: document.getElementById("artifactList"),
  auditLog: document.getElementById("auditLog"),
  runBtn: document.getElementById("runBtn"),
  resetBtn: document.getElementById("resetBtn"),
  runStatus: document.getElementById("runStatus"),
  completedCount: document.getElementById("completedCount"),
  briefInput: document.getElementById("briefInput"),
  briefFields: document.getElementById("briefFields"),
  reviewQueue: document.getElementById("reviewQueue"),
  reviewCount: document.getElementById("reviewCount"),
  projectTitle: document.getElementById("projectTitle"),
  clarifications: document.getElementById("clarifications"),
  proofRuntime: document.getElementById("proofRuntime"),
  proofSource: document.getElementById("proofSource"),
  packetOutput: document.getElementById("packetOutput"),
  copyPacketBtn: document.getElementById("copyPacketBtn"),
  renderBtn: document.getElementById("renderBtn"),
  renderStatus: document.getElementById("renderStatus"),
  renderVideo: document.getElementById("renderVideo"),
};

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function addAudit(message) {
  state.audit.unshift({
    time: nowLabel(),
    message,
  });
  renderAudit();
}

function updateTask(id, taskState) {
  state.tasks = state.tasks.map((task) =>
    task.id === id ? { ...task, state: taskState } : task,
  );
  renderTasks();
}

function addArtifact(taskId) {
  const title = demo.artifactTitles[taskId];
  if (!title || state.artifacts.some((item) => item.title === title)) {
    return;
  }
  // Every artifact starts at v1; the number only advances through a revision.
  state.artifacts.push({
    title,
    type: taskId,
    body: state.local?.summaryByTask?.[taskId] || "",
    content: state.local?.markdownByTask?.[taskId] || null,
    version: "v1",
  });
  renderArtifacts();
}

function applyApiRun(apiRun) {
  const normalized = normalizeApiRun(apiRun, demo);
  state.tasks = normalized.tasks;
  state.artifacts = normalized.artifacts;
  state.audit = normalized.audit;
  state.reviews = normalized.reviews;
  state.packetReady = normalized.packetReady;
  state.packetMarkdown = normalized.packetMarkdown;
  state.projectTitle = normalized.projectTitle;
  state.status = normalized.status;
  state.metrics = normalized.metrics;
  state.briefFields = normalized.briefFields;
  state.clarifyingQuestions = normalized.clarifyingQuestions;
  state.render = normalized.render;
  state.traceId = normalized.traceId;
  renderAll();
}

// Kicks off the hero-shot render and polls until Veo settles. API path only:
// rendering is a paid server-side call, so the offline path explains rather
// than pretends (renderRenderPanel handles the message).
async function startHeroRender() {
  if (!state.traceId || state.rendering) return;
  state.rendering = true;
  renderRenderPanel();

  try {
    const started = await fetch(`/api/workflow/${encodeURIComponent(state.traceId)}/render`, {
      method: "POST",
    });
    const payload = await started.json();
    if (!started.ok) {
      throw new Error(payload.error || "Render request failed");
    }
    state.render = payload;
    renderRenderPanel();

    while (state.render && state.render.status === "rendering") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const poll = await fetch(`/api/workflow/${encodeURIComponent(state.traceId)}/render`, {
        cache: "no-store",
      });
      if (!poll.ok) throw new Error("Render polling failed");
      state.render = await poll.json();
      renderRenderPanel();
    }
    addAudit(
      state.render?.status === "done"
        ? "Render Agent delivered the hero shot clip."
        : `Render finished with status: ${state.render?.status}.`,
    );
  } catch (error) {
    addAudit(`Rendering failed: ${error.message}`);
    state.render = { ...(state.render || {}), status: "failed", error: error.message };
  } finally {
    state.rendering = false;
    renderRenderPanel();
    renderAudit();
  }
}

async function fetchDemoData() {
  try {
    const response = await fetch("/api/demo", { cache: "no-store" });
    if (!response.ok) return;
    demo = await response.json();
    state.tasks = structuredClone(demo.tasks);
  } catch {
    // Direct file usage has no local API. The bundled data keeps the prototype usable.
  }

  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (response.ok) state.health = await response.json();
  } catch {
    // No server: the proof view reports the in-browser execution path instead.
  }
}

// Starts a run and polls until the workflow settles, applying every snapshot so
// the task graph advances on screen as the worker moves through it.
async function fetchWorkflowRun() {
  const response = await fetch("/api/workflow/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief_text: nodes.briefInput.value }),
  });

  if (!response.ok) {
    throw new Error("Workflow API failed");
  }

  const queued = await response.json();
  applyApiRun(queued);
  return pollUntilSettled(queued.trace_id);
}

// Applies every snapshot on the way, so the task graph advances on screen while
// the worker moves through it.
async function pollUntilSettled(traceId) {
  const settled = ["needs_review", "approved", "failed"];
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    await wait(POLL_INTERVAL_MS);

    const poll = await fetch(`/api/workflow/${encodeURIComponent(traceId)}`, {
      cache: "no-store",
    });
    if (!poll.ok) {
      throw new Error("Workflow polling failed");
    }

    const run = await poll.json();
    applyApiRun(run);

    if (run.project.status === "failed") {
      throw new Error("Workflow run failed");
    }
    if (settled.includes(run.project.status)) {
      return run;
    }
  }

  throw new Error("Workflow run timed out");
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkflow() {
  if (state.running) return;
  state.running = true;
  nodes.runBtn.disabled = true;
  setStatus("Running");

  try {
    const run = await fetchWorkflowRun();

    if (run.review_items.length > 0) {
      switchView("review");
      setStatus("Needs review");
    } else {
      switchView("packet");
      setStatus("Approved");
    }

    state.running = false;
    nodes.runBtn.disabled = false;
    return;
  } catch (error) {
    // Reset anything a partial run left on screen before the offline path starts.
    state.tasks = structuredClone(demo.tasks);
    state.artifacts = [];
    state.audit = [];
    state.traceId = null;
    addAudit(
      `Local API unavailable (${error.message}). Falling back to in-browser workflow simulation.`,
    );
  }

  // Offline path: the same agents the server runs, minus the model provider.
  runLocalPipeline();

  for (const task of state.tasks) {
    updateTask(task.id, "running");
    addAudit(`${task.agent} started: ${task.title}.`);
    await wait(650);

    if (task.id === "critic") {
      addArtifact(task.id);
      state.reviews = structuredClone(state.local.findings);

      if (state.reviews.length === 0) {
        updateTask(task.id, "approved");
        state.packetReady = true;
        addAudit("Critic Agent found no risks against the stated constraints.");
        renderPacket();
        switchView("packet");
        setStatus("Approved");
      } else {
        updateTask(task.id, "needs_review");
        addAudit(`Critic Agent routed ${state.reviews.length} finding(s) to human review.`);
        renderReviews();
        switchView("review");
        setStatus("Needs review");
      }

      state.running = false;
      nodes.runBtn.disabled = false;
      return;
    }

    updateTask(task.id, "completed");
    addArtifact(task.id);
    addAudit(state.local.auditByTask[task.id] || `${task.agent} completed and saved an artifact.`);
    if (task.id === "intake" && state.clarifyingQuestions.length > 0) {
      addAudit(
        `Intake Agent raised ${state.clarifyingQuestions.length} clarifying question(s): ` +
          state.clarifyingQuestions.map((question) => question.question).join(" "),
      );
    }
    await wait(220);
  }
}

// Runs intake + the production agents in the browser and stashes the result on
// `state.local`, which the offline artifact/packet rendering reads from.
function runLocalPipeline(enforce = {}) {
  const intake = STUDIOFLOW_INTAKE.parseBrief(nodes.briefInput.value);
  const structuredBrief = intake.structured_brief;
  const built = STUDIOFLOW_PRODUCTION.buildAll(
    structuredBrief,
    intake.clarifying_questions,
    enforce,
  );

  state.projectTitle = built.shotList.subject;
  state.briefFields = STUDIOFLOW_INTAKE.toFields(structuredBrief);
  state.clarifyingQuestions = intake.clarifying_questions;
  state.packetMarkdown = STUDIOFLOW_PRODUCTION.packetMarkdown(structuredBrief, built);
  state.local = {
    structuredBrief,
    enforce,
    findings: built.findings,
    summaryByTask: {
      intake: STUDIOFLOW_INTAKE.summarize(structuredBrief, intake.clarifying_questions.length),
      planning: built.summaries.planning,
      shots: built.summaries.shots,
      assets: built.summaries.assets,
      prompts: built.summaries.prompts,
      critic: built.summaries.critic,
    },
    markdownByTask: {
      intake: null,
      planning: built.markdown.planning,
      shots: built.markdown.shots,
      assets: built.markdown.assets,
      prompts: built.markdown.prompts,
      critic: built.markdown.critic,
    },
    auditByTask: {
      intake: "Intake Agent (local parser) converted the raw brief into a structured brief.",
      planning: `Planning Agent derived a ${built.shotList.shots.length}-beat workflow plan.`,
      shots: `Shot Agent generated ${built.shotList.shots.length} timed shots for ${built.shotList.duration_seconds}s.`,
      assets: `Asset Agent extracted ${built.manifest.assets.length} asset groups from the shot list.`,
      prompts: `Prompt Agent wrote ${built.promptPack.prompts.length} per-shot prompts.`,
    },
  };

  renderBriefFields();
  return built;
}

async function requestRevision(reviewId) {
  if (state.traceId) {
    try {
      const response = await fetch(`/api/workflow/${encodeURIComponent(state.traceId)}/reviews/${encodeURIComponent(reviewId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revise" }),
      });
      if (!response.ok) throw new Error("Review API failed");
      applyApiRun(await response.json());
      if (state.reviews.length === 0) {
        setStatus("Approved");
        switchView("packet");
      } else {
        setStatus("Needs review");
      }
      return;
    } catch {
      addAudit("Review API unavailable. Falling back to in-browser revision.");
    }
  }

  const review = state.reviews.find((item) => item.id === reviewId);
  if (!review) return;

  state.reviews = state.reviews.filter((item) => item.id !== reviewId);
  renderReviews();
  updateTask("critic", "revision_requested");
  setStatus("Revising");
  addAudit(`Human reviewer requested revision for "${review.title}".`);
  await wait(500);

  // Replay the reviewer's constraint through the agents so the rerun changes the
  // artifact content, matching what the API path does.
  const targets = review.target_task_ids || [];
  runLocalPipeline({ ...(state.local?.enforce || {}), ...(review.enforce || {}) });

  state.artifacts = state.artifacts.map((artifact) => {
    if (!targets.includes(artifact.type)) return artifact;

    const version = Number(String(artifact.version).replace(/^v/, "")) + 1;
    return {
      ...artifact,
      body: state.local.summaryByTask[artifact.type] || artifact.body,
      content: state.local.markdownByTask[artifact.type] || artifact.content,
      version: `v${version}`,
    };
  });
  renderArtifacts();

  for (const taskId of targets) {
    updateTask(taskId, "completed");
    addAudit(`Rerun after revision request updated ${demo.artifactTitles[taskId]}.`);
  }
  await wait(500);

  if (state.reviews.length === 0) {
    updateTask("critic", "approved");
    state.packetReady = true;
    setStatus("Approved");
    addAudit("Critic Agent passed revised artifacts and generated production packet.");
    renderPacket();
    switchView("packet");
  } else {
    updateTask("critic", "needs_review");
    setStatus("Needs review");
  }
}

function approveReview(reviewId) {
  if (state.traceId) {
    fetch(`/api/workflow/${encodeURIComponent(state.traceId)}/reviews/${encodeURIComponent(reviewId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("Review API failed");
        return response.json();
      })
      .then((apiRun) => {
        applyApiRun(apiRun);
        if (state.reviews.length === 0) {
          setStatus("Approved");
          switchView("packet");
        }
      })
      .catch(() => {
        addAudit("Review API unavailable. Falling back to in-browser approval.");
        approveReviewLocally(reviewId);
      });
    return;
  }

  approveReviewLocally(reviewId);
}

function approveReviewLocally(reviewId) {
  const review = state.reviews.find((item) => item.id === reviewId);
  if (!review) return;

  state.reviews = state.reviews.filter((item) => item.id !== reviewId);
  addAudit(`Human reviewer approved "${review.title}" as-is.`);
  renderReviews();

  if (state.reviews.length === 0) {
    updateTask("critic", "approved");
    state.packetReady = true;
    setStatus("Approved");
    addAudit("All review items closed. Production packet generated.");
    renderPacket();
    switchView("packet");
  }
}

function resetWorkflow() {
  state.tasks = structuredClone(demo.tasks);
  state.artifacts = [];
  state.audit = [];
  state.reviews = [];
  state.packetReady = false;
  state.packetMarkdown = null;
  state.projectTitle = null;
  state.status = null;
  state.metrics = null;
  state.briefFields = null;
  state.clarifyingQuestions = [];
  state.local = null;
  state.running = false;
  state.traceId = null;
  nodes.runBtn.disabled = false;
  setStatus("Ready");
  renderAll();
  switchView("workspace");
}

async function submitClarifications() {
  const answers = {};
  for (const input of nodes.clarifications.querySelectorAll("input[data-question-id]")) {
    if (input.value.trim()) answers[input.dataset.questionId] = input.value.trim();
  }

  if (Object.keys(answers).length === 0) return;

  addAudit("Human reviewer answered the Intake Agent's clarifying questions.");
  setStatus("Running");
  nodes.runBtn.disabled = true;

  try {
    const response = await fetch(
      `/api/workflow/${encodeURIComponent(state.traceId)}/clarifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      },
    );
    if (!response.ok) throw new Error("Clarification API failed");

    const queued = await response.json();
    applyApiRun(queued);
    await pollUntilSettled(queued.trace_id);

    if (state.reviews.length > 0) {
      switchView("review");
      setStatus("Needs review");
    } else {
      switchView("packet");
      setStatus("Approved");
    }
  } catch (error) {
    addAudit(`Could not rerun with answers (${error.message}).`);
    setStatus("Needs review");
  } finally {
    nodes.runBtn.disabled = false;
  }
}

nodes.navItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

nodes.clarifications.addEventListener("click", (event) => {
  if (event.target.id === "answerClarificationsBtn") submitClarifications();
});

nodes.runBtn.addEventListener("click", runWorkflow);
nodes.resetBtn.addEventListener("click", resetWorkflow);

nodes.reviewQueue.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const reviewId = button.dataset.reviewId;
  if (button.dataset.action === "revise") {
    requestRevision(reviewId);
  }
  if (button.dataset.action === "approve") {
    approveReview(reviewId);
  }
});

nodes.renderBtn.addEventListener("click", startHeroRender);

nodes.copyPacketBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentPacketMarkdown());
  addAudit("Production packet markdown copied to clipboard.");
});

async function boot() {
  await fetchDemoData();
  renderAll();
}

boot();
