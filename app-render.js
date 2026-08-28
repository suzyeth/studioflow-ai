// Rendering. Every function here reads `state` and writes into `nodes`; none of
// them fetch, orchestrate, or mutate workflow state. Loaded before app.js so its
// boot() can call renderAll().
//
// All markup is built with innerHTML, so every interpolated value must pass
// through escapeHtml() — including values placed inside attributes.

function renderBriefFields() {
  // Only seed the textarea when no run is in flight. A queued run has no
  // structured fields yet, and resetting here would wipe the brief the user typed.
  if (!state.briefFields && !state.traceId && !state.local) {
    nodes.briefInput.value = demo.brief.text;
  }

  nodes.projectTitle.textContent = state.projectTitle || demo.project.title;

  // Before a run there is nothing from an agent yet, so preview the chips by
  // parsing whatever is in the textarea. Hand-written placeholder fields used to
  // live in data.js and could disagree with what parsing the same brief produces.
  const fields =
    state.briefFields ||
    STUDIOFLOW_INTAKE.toFields(
      STUDIOFLOW_INTAKE.parseBrief(nodes.briefInput.value || demo.brief.text).structured_brief,
    );

  nodes.briefFields.innerHTML = fields
    .map(
      ([label, value]) => `
        <div class="field-chip">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderTasks() {
  nodes.taskList.innerHTML = state.tasks
    .map(
      (task, index) => `
        <li class="task-item">
          <span class="task-number">${index + 1}</span>
          <div>
            <span class="task-title">${escapeHtml(task.title)}</span>
            <span class="task-agent">${escapeHtml(task.agent)}</span>
          </div>
          <span class="state ${escapeHtml(task.state)}">${escapeHtml(String(task.state).replace("_", " "))}</span>
        </li>
      `,
    )
    .join("");

  const completed = state.tasks.filter((task) =>
    ["completed", "approved"].includes(task.state),
  ).length;
  nodes.completedCount.textContent = `${completed}/${state.tasks.length} complete`;
}

function renderArtifacts() {
  if (state.artifacts.length === 0) {
    nodes.artifactList.innerHTML = `
      <div class="artifact">
        <strong>No artifacts yet</strong>
        <p>Run the workflow to create structured deliverables.</p>
      </div>
    `;
    return;
  }

  nodes.artifactList.innerHTML = state.artifacts
    .map(
      (artifact) => `
        <article class="artifact">
          <strong>${escapeHtml(artifact.title)} ${escapeHtml(artifact.version)}</strong>
          <p>${escapeHtml(artifact.body)}</p>
          ${artifact.content ? `<pre class="artifact-content">${escapeHtml(artifact.content)}</pre>` : ""}
        </article>
      `,
    )
    .join("");
}

function renderAudit() {
  if (state.audit.length === 0) {
    nodes.auditLog.innerHTML = `
      <div class="audit-event">
        <time>--:--</time>
        <span>Audit events will appear here as agents run.</span>
      </div>
    `;
    return;
  }

  nodes.auditLog.innerHTML = state.audit
    .map(
      (event) => `
        <div class="audit-event">
          <time>${escapeHtml(event.time)}</time>
          <span>${escapeHtml(event.message)}</span>
        </div>
      `,
    )
    .join("");
}

function renderReviews() {
  if (state.reviews.length === 0) {
    nodes.reviewQueue.innerHTML = `
      <article class="review-card">
        <strong>No open reviews</strong>
        <p>Critic Agent findings will be routed here for human approval.</p>
      </article>
    `;
  } else {
    nodes.reviewQueue.innerHTML = state.reviews
      .map(
        (item) => `
          <article class="review-card warning" data-review-id="${escapeHtml(item.id)}">
            <strong>${escapeHtml(item.title)}</strong>
            <p>${escapeHtml(item.body)}</p>
            <div class="review-actions">
              <button class="primary-button" data-action="revise" data-review-id="${escapeHtml(item.id)}">
                Request Revision
              </button>
              <button class="ghost-button" data-action="approve" data-review-id="${escapeHtml(item.id)}">
                Approve As-Is
              </button>
            </div>
          </article>
        `,
      )
      .join("");
  }

  nodes.reviewCount.textContent = `${state.reviews.length} open`;
}

function currentPacketMarkdown() {
  if (!state.packetReady) {
    return "Run the workflow to generate a production packet.";
  }

  return state.packetMarkdown || "No packet was generated for this run.";
}

function renderPacket() {
  nodes.packetOutput.textContent = currentPacketMarkdown();
}

// The hero-shot render lives strictly downstream of the human gate: the button
// only appears once the packet is approved, and only on the API path — the
// offline path explains why instead of pretending (rendering is a paid
// server-side Veo call the browser cannot make alone).
function renderRenderPanel() {
  const render = state.render;
  const apiPath = Boolean(state.traceId);

  nodes.renderVideo.hidden = true;
  nodes.renderBtn.hidden = true;
  nodes.renderBtn.disabled = false;

  if (!state.packetReady) {
    nodes.renderStatus.textContent =
      "Once the packet is approved, its hero shot can be rendered with Veo — the prompt and negative prompts are the packet's own.";
    return;
  }
  if (!apiPath) {
    nodes.renderStatus.textContent =
      "Rendering runs on the deployed service (a paid Veo call) — open the Cloud Run URL to use it.";
    return;
  }

  if (!render || render.status === "none") {
    nodes.renderBtn.hidden = false;
    nodes.renderStatus.textContent =
      "The packet is approved. Render its hero shot with Veo — one clip, from the packet's own prompt and negative prompts.";
    return;
  }
  if (render.status === "rendering" || state.rendering) {
    nodes.renderBtn.hidden = false;
    nodes.renderBtn.disabled = true;
    nodes.renderStatus.textContent = `Veo is rendering the hero shot (${escapeHtml(render.timecode || "")})… typically 1–3 minutes.`;
    return;
  }
  if (render.status === "done") {
    nodes.renderStatus.textContent = `Hero shot (${escapeHtml(render.timecode || "")}) rendered by ${escapeHtml(render.model || "Veo")}, inheriting the packet's negative prompts.`;
    nodes.renderVideo.src = `/api/workflow/${encodeURIComponent(state.traceId)}/render/video`;
    nodes.renderVideo.hidden = false;
    return;
  }
  if (render.status === "filtered") {
    nodes.renderStatus.textContent =
      "Veo's safety filter removed the clip. The packet stands on its own.";
    return;
  }
  nodes.renderBtn.hidden = false;
  nodes.renderStatus.textContent = `Rendering failed: ${escapeHtml(render.error || "unknown error")}. You can try again.`;
}

function setStatus(label) {
  nodes.runStatus.textContent = label;
}

function switchView(viewId) {
  nodes.views.forEach((view) => view.classList.toggle("active", view.id === viewId));
  nodes.navItems.forEach((item) =>
    item.classList.toggle("active", item.dataset.view === viewId),
  );
}

// Intake's questions are answerable. Answering them re-runs the workflow against
// the brief plus the answers, because everything downstream depends on intake.
function renderClarifications() {
  if (state.clarifyingQuestions.length === 0 || !state.traceId) {
    nodes.clarifications.innerHTML = "";
    return;
  }

  nodes.clarifications.innerHTML = `
    <p>The Intake Agent could not find this in the brief. Answering re-runs the workflow.</p>
    ${state.clarifyingQuestions
      .map(
        (question) => `
          <div class="clarification-row">
            <label for="clarify_${escapeHtml(question.id)}">${escapeHtml(question.question)}</label>
            <input id="clarify_${escapeHtml(question.id)}" data-question-id="${escapeHtml(question.id)}"
                   placeholder="${escapeHtml(question.why_it_matters || "")}" />
          </div>
        `,
      )
      .join("")}
    <button class="primary-button" id="answerClarificationsBtn">Answer and rerun</button>
  `;
}

// The proof view shows what this run actually did, rather than describing what a
// deployment would look like.
function renderProof() {
  const durations = state.metrics?.task_durations_ms || {};
  const items = [];

  items.push(["Trace ID", state.traceId || "not started"]);
  items.push(["Run status", state.status || "idle"]);
  items.push(["Intake provider", state.health ? `${state.health.intake_provider}${state.health.intake_model ? ` (${state.health.intake_model})` : ""}` : "unknown"]);
  items.push(["Execution", state.traceId ? "queued worker, polled by the client" : "in-browser, no server"]);
  items.push(["Audit events", String(state.audit.length)]);
  items.push(["Artifacts", String(state.artifacts.length)]);

  const timed = Object.entries(durations);
  if (timed.length > 0) {
    const total = timed.reduce((sum, [, ms]) => sum + ms, 0);
    items.push(["Agent time", `${total}ms total`]);
    for (const [taskId, ms] of timed) {
      items.push([`— ${taskId}`, `${ms}ms`]);
    }
  }

  nodes.proofSource.textContent = state.traceId ? "Live run" : "No run yet";
  nodes.proofRuntime.innerHTML = items
    .map(
      ([label, value]) => `
        <div class="proof-item">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(value)}</span>
        </div>
      `,
    )
    .join("");
}

function renderAll() {
  renderBriefFields();
  renderClarifications();
  renderProof();
  renderTasks();
  renderArtifacts();
  renderAudit();
  renderReviews();
  renderPacket();
  renderRenderPanel();
}
