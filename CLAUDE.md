# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**StudioFlow AI** — an "All Things Agentic" hackathon MVP (Taskmaster track). The
product is **constraint compliance for video briefs**, not creative generation: a
brief becomes a production packet in which every stated constraint has been checked,
and every failed check is traceable to the agent that caused it and the rerun that
fixed it.

Keep that framing when making changes. The creative prose is templated and known to
be weak; the checking, routing, rerun, and audit trail are the product. Work that
makes the templates flowerier is not progress. Work that makes the Critic catch a
constraint class it currently misses is.

**Every artifact is generated from the brief**, by real logic rather than scripted
copy. Intake structures the brief; Planning, Shot, Asset, and Prompt derive from it;
Critic checks the result against the stated constraints. `data.js` is now only a
fallback scenario plus the task and artifact *labels*.

**Execution is genuinely asynchronous**: `POST /run` returns `202` with a queued run
and an in-process worker (`lib/queue.js`) executes the tasks one at a time, saving
after every state change so a poller sees the graph advance.

**But only the Intake Agent can call a model.** The production agents are
deterministic generators, the queue is in-process rather than Pub/Sub, and nothing
persists across a restart. There is still no Firestore. Artifacts
carry `generated_by` (`"local"` / a provider name / `"derived"` / `"scripted"`) so
provenance is visible rather than implied. The docs in `docs/` describe the intended
cloud implementation; treat them as the spec, not as a description of current
behavior.

**One runtime dependency: `@google/genai`.** The project was built with zero, and
that rule held until the hackathon rules forced it — All Things Agentic requires at
least one Google agent framework (ADK / GenAI SDK / Antigravity SDK / Genkit), and a
hand-rolled `fetch` against the REST endpoint does not qualify. Only the Gemini
adapter uses it; `local` and `anthropic` remain stdlib-only. Do not add a second
dependency without asking — the constraint is what keeps the prototype runnable
anywhere, and it has now been spent.

Outstanding work that needs a key, a cloud account, or software that is not
installed lives in [TODO.md](TODO.md) — check it before assuming something is
missing by accident. The big two: **no Gemini key has ever been used, and the app
has never been deployed.**

## Commands

```bash
npm start        # local server on http://localhost:4173 (PORT env overrides)
npm run check    # syntax-only: node --check on each source file
npm test         # node tests/workflow.test.js
```

Tests are plain-`assert` scripts, not a framework — there is no way to run "one test"
and no coverage tooling. Run one file directly (`node tests/production.test.js`) to
iterate.

**Every suite drives the live path** (`createQueuedRun` → `executeRun` → `runTask` →
`closeReviewItem`). There is deliberately no second run-building code path to test
against; an earlier refactor left one behind and the suite went on passing while
testing code the server no longer called. If you add a convenience function that
builds a run a different way, you have recreated that hazard.

Sanity check for whether a suite is really guarding anything: break the live code on
purpose and confirm the tests go red.

A new top-level source file has to be registered in **three** hardcoded lists —
the `check` script, the [Dockerfile](Dockerfile) `COPY` block, and (for browser
scripts) the `<script>` tags in [index.html](index.html). Miss one and the file
silently escapes validation, the container image, or the page.

## Architecture

Five files carry the whole system; the split matters:

- **[data.js](data.js)** — labels and the default brief only: the project record, the
  six task titles/agent names, and the artifact titles. It deliberately contains **no
  generated content** — no shot lists, no review items, no packet. If you find
  yourself adding sample output here, the agent that should produce it is missing.
- **[intake-heuristics.js](intake-heuristics.js)** — keyless brief parsing, the
  contract validator, and `toFields`/`summarize`. Both the server agent and the
  browser's offline path go through it, which is what keeps the two paths identical.
- **[view-model.js](view-model.js)** — pure view helpers (`escapeHtml`,
  `normalizeApiRun`) shared by the browser and the tests. No DOM access belongs here;
  that is what keeps it testable.
- **[lib/llm.js](lib/llm.js)** — provider seam (`local` / `gemini` / `anthropic`).
  Gemini goes through the `@google/genai` SDK (a rules requirement, see above);
  Anthropic is still plain `fetch`. Two traps the SDK introduces: `GEMINI_BASE_URL`
  must **not** carry `/v1beta` because the SDK appends the version itself, and the
  SDK's `ApiError` has a `.status` but no status line in its message — the adapter
  re-wraps it as `HTTP <code>: …` so `degraded_reason` and the audit trail keep the
  shape the rest of the app expects. The hosted adapters are unverified against live
  endpoints.
- **[lib/agents/intake.js](lib/agents/intake.js)** — the Intake Agent. Validates
  model output against `docs/AGENT_CONTRACTS.md` before it can become an artifact,
  and degrades to the keyless parser on any failure.
- **[lib/workflow.js](lib/workflow.js)** — pure workflow logic. `createWorkflowRun`
  and `closeReviewItem` take state and return **new** state (spread, never mutate);
  `createRunStore` `structuredClone`s on every save/get/update so callers can never
  hold a live reference into the store.
- **[server.js](server.js)** — thin HTTP transport: route match → call `lib/workflow`
  → `sendJson`. Runs live in an in-memory `Map` keyed by `trace_id`, so **restarting
  the server drops all runs**, and the store is LRU-capped at 50 runs. No business
  logic belongs here.
- **[app-render.js](app-render.js)** — rendering only. Reads `state`, writes into
  `nodes`. Loaded before `app.js` so its `boot()` can call `renderAll()`. Nothing
  here fetches or mutates workflow state.
- **[app.js](app.js)** — state, API calls, polling, orchestration, events, plus the
  offline path (see below).

### The dual-runtime constraint on `data.js` and `view-model.js`

Both files are loaded two ways and must satisfy both:

1. Browser: a `<script>` tag in [index.html](index.html), exposing a global
   (`STUDIOFLOW_DEMO`, `STUDIOFLOW_VIEW`).
2. Node: `loadBrowserGlobal()` in `lib/workflow.js` reads the file as **text** and
   evaluates it in a `vm` sandbox, then reads the global off the context. It caches
   the parsed value against the **source text**, not the mtime — this filesystem
   reports mtime at whole-second resolution, so an mtime-keyed cache serves stale
   data for edits made inside the same second. Data globals are handed back as
   `structuredClone` copies; `loadViewModel` passes `clone: false` because
   `structuredClone` cannot copy functions.

So each must stay a bare `const NAME = {...}` script — adding `module.exports`,
`require`, `import`, or `export` breaks one runtime or the other. This is also the
only route by which browser-side code becomes unit-testable: `app.js` touches
`document` at module scope and cannot be required from Node, so any logic worth
testing belongs in `view-model.js`.

### Async execution

`executeRun` walks `TASK_SEQUENCE` (intake → planning → shots → assets → prompts →
critic), and `runTask` builds each task's output from a `ctx` that later tasks read.
The dependency chain is explicit: planning produces the beat plan, shots lays timings
over it, assets and prompts derive from shots, critic checks shots against the brief.

**Every state change is written back to the store before the next one starts.** That
is the whole point — a poller has to be able to observe `running`. If you batch the
saves or compute everything before saving, the task graph goes back to appearing
instantly complete.

`STUDIOFLOW_STEP_DELAY_MS` (default 450 in `server.js`, 0 in tests) is display
pacing, not simulated work. The agents finish in single-digit milliseconds; without a
delay the run settles before the client's first poll. Do not mistake it for fake
latency and do not add work to justify it.

A task that throws marks itself `failed`, sets the run `failed`, appends a
`task_failed` audit event, and rethrows to the queue's error handler. Completed work
is kept.

### Agent rules

Two rules govern anything that calls a model, and they pull in opposite directions
on purpose:

- **A model failure must never fail a run.** Network errors, malformed JSON, and
  schema violations all degrade to the keyless parser; the response carries
  `degraded` / `degraded_reason` and the audit trail says so. The demo has to survive
  a dead API key on stage.
- **A misconfiguration must fail loudly.** `createProvider` throws when a provider is
  named without its key, so the server refuses to start rather than silently serving
  heuristic output while the operator believes Gemini is live.

Model output is validated against the contract in `docs/AGENT_CONTRACTS.md` *before*
it becomes an artifact — a well-formed JSON response that violates the schema is
treated as a failure, not saved.

### The revision loop

Findings come from `production.reviewShotList`, which checks the generated shot list
against the brief's constraints. Each finding carries `target_task_ids` (bare task
ids) and, where a fix is mechanical, an `enforce` object.

On revise, `closeReviewItem` merges that `enforce` into `run.enforce`, reruns the
production agents with it, and writes the new content into the target artifacts along
with a version bump, `revision_reason`, and one `artifact_created` audit event each.
The packet is rebuilt. Approving closes the item without touching artifacts.

**The Shot Agent deliberately does not read constraints on its first pass** — it lays
out a standard narrative structure, the Critic catches what that misses, and the
revision enforces the fix. If you "improve" the Shot Agent to satisfy every constraint
up front, the Critic finds nothing and the review gate becomes decorative. The first
pass has to be able to be wrong.

Adding a Critic check is the highest-value work available. Each one takes a
constraint class the brief can express and verifies the artifacts honour it. Two
rules: the check must read real generated output (not restate the brief), and it must
stay silent when the brief says nothing about it — inventing findings to make the
queue look busy destroys the only claim this project can defend.

Findings count varies by brief, and zero findings is a valid outcome: `createWorkflowRun`
lands such a run directly on `approved` with `packet_ready` set, and the critic task
approved. Do not assume a run always pauses for review.

### The dual-path constraint on the UI

The app is designed to work as a plain `file://` open of `index.html` *and* as an
API-backed app. Every user action in `app.js` therefore has two implementations:

- try the API (`fetchWorkflowRun`, the review `fetch` calls),
- on any failure, `catch` → log an audit line → fall back to the in-browser
  simulation (the `await wait(650)` task loop, `approveReviewLocally`, the local
  revision path).

**A feature added to only one path is a bug.** The fallback also means API errors are
invisible in the UI — they surface only as an audit line. When a run "works" but
behaves differently than expected, first check whether it took the API path
(`state.traceId` is set) or the simulated one.

`normalizeApiRun` (in `view-model.js`) is the seam that flattens the API's
`snake_case` run object into the client's flat `state`. Adding a field to the API run
shape means adding it there too. It is called **only** by `applyApiRun` — every fetch
helper returns the raw server object, because normalizing an already-normalized run
throws and silently drops the app into the fallback path.

All render functions build markup with `innerHTML`. Every interpolated value must go
through `escapeHtml()`, including values placed inside attributes (`class`,
`data-review-id`). Run data comes from the API and is not trusted markup.

The audit panel reads newest-first. The offline path `unshift`s, so `normalizeApiRun`
reverses the server's oldest-first `audit_events` to match.

### API contract

```text
GET  /api/health
GET  /api/demo
POST /api/workflow/run                        { brief_text }
GET  /api/workflow/:traceId
POST /api/workflow/:traceId/reviews/:reviewId { action: "approve" | "revise" }
```

This shape is deliberately frozen: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) plans to
swap the implementation to Firestore / Pub/Sub / Gemini **behind these same routes**.
Changing route or payload shapes invalidates the docs, the UI, and the demo script —
extend rather than reshape.

Run lifecycle: `POST /run` returns every task already `completed` except `critic`,
which is `needs_review`, with three open review items. Closing review items one at a
time via the reviews route drives it forward; when the last one closes,
`closeReviewItem` flips `project.status` to `approved`, sets `packet_ready`, and
appends the `packet_generated` audit event. There is no intermediate "running" state
server-side — only the browser simulation animates task-by-task progress.

### Known ID inconsistency

[docs/DATA_MODEL.md](docs/DATA_MODEL.md) specifies task IDs like `task_intake`, but
runtime tasks keep the bare `data.js` IDs (`intake`, `critic`, …). Artifacts *do* get
`task_id: "task_<id>"`. `app.js` strips a `task_` prefix defensively, which is
currently a no-op. Match the runtime convention (bare IDs) when touching task code,
and don't trust the doc's IDs literally.

## Docs

[docs/ALL_THINGS_AGENTIC_PLAN.md](docs/ALL_THINGS_AGENTIC_PLAN.md) is the product
spine (agent network, cloud architecture, demo script, phased build plan).
[docs/AGENT_CONTRACTS.md](docs/AGENT_CONTRACTS.md) defines the JSON in/out envelope
every specialist agent must honor once real models are wired in — implement against
it rather than inventing new shapes.
[docs/DESIGN.md](docs/DESIGN.md) is an **earlier, abandoned** concept (attention-driven
editing timeline, ClickHouse). It is kept for reference and does not describe this code.

## Scope guardrails (from the plan)

Never cut: working demo, README, architecture diagram, Google Cloud evidence, human
approval loop. Cut first if pressed: real video generation, PDF export, permissions,
multiple project templates. The project must stay a *workflow execution system* —
do not let it collapse into a video generator.
