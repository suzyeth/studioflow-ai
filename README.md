# Agentic Cinema

Agentic Cinema is a workspace for building hackathon-grade agentic systems for
creative production.

The current All Things Agentic direction is **StudioFlow AI**: a constraint-compliance
workflow for video briefs. It turns an ambiguous brief into a production packet where
**every stated constraint has been checked, and every failed check is traceable to the
agent that caused it and the rerun that fixed it.**

The distinction matters. A single prompt can write a shot list. What it cannot do is
notice that the brief demanded the product inside five seconds, find that the reveal
landed at 0:13, route that to the two agents responsible, rerun them with the
constraint enforced, and leave an audit trail proving it happened. That loop is the
product.

**Implementation status:** every artifact in a run is generated from the submitted
brief. The Intake Agent structures the brief, the Planning, Shot, Asset, and Prompt
Agents derive the plan, shot list, asset manifest, and prompt pack from it, and the
Critic Agent checks the result against the stated constraints. Findings are derived,
so their number varies by brief and a brief that satisfies its own constraints
produces none. Requesting a revision reruns the affected agents with the reviewer's
constraint enforced, so the artifact content changes rather than only its version
number.

**Be clear-eyed about the creative quality.** The generated prose is templated — the
shot list reads as structure, not as writing, and it will until a model is wired into
the production agents. The constraint checking, routing, rerun, and audit trail are
the parts that work today and the parts worth judging.

Execution is asynchronous: `POST /api/workflow/run` returns `202` with a queued run,
a worker executes the agents one task at a time, and the client polls to watch the
task graph advance.

What is still missing: only the Intake Agent can call a model — the rest are
deterministic generators. The queue is in-process rather than Pub/Sub, and nothing
persists across a restart. The Google Cloud services described below are the target
architecture, not yet wired up; the API surface is frozen so they can be swapped in
behind the same routes. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Every artifact carries `generated_by` so its provenance is visible rather than
implied.

## Intake Agent

The Intake Agent converts a rough brief into the structured brief defined in
[docs/AGENT_CONTRACTS.md](docs/AGENT_CONTRACTS.md), and raises clarifying questions
only for missing information that would block planning. Model output is validated
against the contract before it is allowed to become an artifact.

The model is chosen by environment, and the workflow runs with no configuration at
all:

| `STUDIOFLOW_LLM` | Requires | Notes |
| --- | --- | --- |
| `local` (default) | nothing | Keyless parser in `intake-heuristics.js`. Also the offline path when the page is opened as a file. |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` overrides the default model. The hackathon target. |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` overrides the default model. For comparison only — the Google track expects Gemini. |

With no variables set, the first available key wins, and `local` is the floor.

```bash
GEMINI_API_KEY=... npm start
```

`GET /api/health` reports which provider is actually live:

```json
{ "ok": true, "intake_provider": "local", "intake_model": null }
```

Two failure rules matter:

- **A model failure never fails a run.** Network errors, malformed JSON, and schema
  violations all degrade to the keyless parser. The run still completes and the
  audit trail records the fallback and its reason.
- **A misconfiguration fails loudly.** Asking for a provider whose key is missing
  (`STUDIOFLOW_LLM=gemini` with no `GEMINI_API_KEY`) refuses to start rather than
  silently downgrading.

The hosted adapters were written without an API key available, so they have never
reached a live endpoint. They *are* exercised against a local stub server in
`tests/async.test.js`, which covers request construction, response parsing, fenced
JSON, HTTP errors, non-JSON replies, and timeout aborts. What remains unverified is
authentication and real model behaviour — point `GEMINI_BASE_URL` /
`ANTHROPIC_BASE_URL` elsewhere to test against your own stub.

**Not yet done:** no Gemini key and no Cloud Run deployment — the two things the
track actually requires. Both are blocked on account access rather than code. See
[TODO.md](TODO.md).

## Current Docs

- [All Things Agentic Plan](docs/ALL_THINGS_AGENTIC_PLAN.md) - product,
  workflow, architecture, demo, and submission plan for StudioFlow AI.
- [Data Model](docs/DATA_MODEL.md) - MVP object shapes for the prototype,
  API, and Firestore implementation.
- [Agent Contracts](docs/AGENT_CONTRACTS.md) - JSON boundaries and prompt
  intent for each specialist agent.
- [Deployment Notes](docs/DEPLOYMENT.md) - local service and Cloud Run
  deployment path.
- ~~[Second Pass Design](docs/DESIGN.md)~~ - **superseded, kept for history only.**
  An abandoned concept (attention-driven editing timeline, ClickHouse) that does not
  describe this codebase. Do not read it as documentation.

## Current Prototype

Open [index.html](index.html) in a browser to try the static StudioFlow AI MVP.

For the API-backed local prototype, run:

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

Demo flow:

1. Click `Run Workflow`.
2. Watch the task graph move through the agent workflow. Served through the API the
   run comes back complete and lands straight on the review queue; opened as a
   static file it animates task by task.
3. Open review findings when the Critic Agent pauses the run.
4. Request revisions or approve findings.
5. Review the generated production packet and cloud proof view.

Each review finding declares which tasks it affects and, where it can, the constraint
that fixes it. Requesting a revision reruns exactly those agents with that constraint
enforced: their artifacts advance to the next version (`Shot List v1` → `Shot List
v2`) **with different content**, record why they were rerun, and add an
`artifact_created` entry to the audit trail. Approving closes the finding without
touching artifacts. When the last finding closes, the run flips to `approved` and the
production packet is regenerated.

The clearest thing to demo: give the brief a constraint like `show the product in the
first 5 seconds`. The Shot Agent lays out a standard narrative structure that opens
on atmosphere, the Critic Agent notices the subject only appears at 0:13, and the
revision moves the reveal to 0:00. The first pass is genuinely able to be wrong,
which is what makes the review gate worth having.

## What the Critic Actually Checks

Each check reads the generated artifacts against the structured brief. None of them
fire unless the brief gives them something to check, and a compliant brief produces
an empty review queue.

| Finding | Fires when |
| --- | --- |
| Subject appears too late | The brief names a window (`first 5 seconds`) and the subject reveal starts after it |
| No explicit call to action | The brief asks for a CTA and the closing beat is a generic close |
| Prohibition missing from the prompt pack | The brief forbids something the prompt pack failed to encode as a negative prompt, so nothing would stop a generator producing it |
| Required element missing from the shot list | The brief requires something no shot depicts |
| Aspect ratio conflicts with the platform | The brief asks for a frame the platform contradicts |
| Shots run long / Cuts are very fast | Runtime divided by shot count falls outside a readable range |
| Runtime was assumed | The brief states no duration, so a default was used |
| Visual direction undefined | No style was stated, so prompts fell back to neutral |
| Intake questions still open | Intake raised questions nobody answered |

Findings that can be fixed mechanically carry an `enforce` flag; requesting a revision
replays it through the agents. The rest are reported for a human to judge.

Useful local endpoints:

```text
GET  /api/health
GET  /api/demo
POST /api/workflow/run                         -> 202, run is queued
GET  /api/workflow/:traceId                    -> poll while the worker runs
POST /api/workflow/:traceId/clarifications     -> 202, reruns with answers
POST /api/workflow/:traceId/reviews/:reviewId
```

`POST /run` returns immediately with every task `queued`. The worker moves each task
`queued` → `running` → `completed`, appending its artifact and audit line as it goes,
so polling shows the graph advancing. A run settles on `needs_review`, `approved`, or
`failed`.

`STUDIOFLOW_STEP_DELAY_MS` (default `450`) paces the worker. The agents finish in
single-digit milliseconds, so without it a poller would only ever see the final
state. It is display pacing, not simulated work — set it to `0` and the run still
completes correctly, just too fast to watch.

Answering the Intake Agent's clarifying questions folds them back into the brief as
labelled lines (`Audience: urban gardeners`) and reruns the whole workflow, because
everything downstream of intake depends on it.

The app still works as a direct static file. When served through `npm start`,
it prefers the local API and falls back to in-browser simulation if the API is
unavailable. The fallback is announced in the audit trail along with the reason,
so a broken API path shows up as a message rather than as silently different
behavior.

## Repository Layout

```text
index.html                app shell and the four views
styles.css                styling
data.js                   labels and the default brief — no generated content
intake-heuristics.js      keyless brief parser, output validation, formatting
production-heuristics.js  shot list, assets, prompts, critic checks, packet
view-model.js             pure view helpers shared by the browser and the tests
app-render.js             rendering only: reads state, writes into the DOM
app.js                    state, API calls, orchestration, events
server.js                 zero-dependency HTTP server: static files and JSON API
lib/workflow.js           run lifecycle, task execution, review handling, store
lib/queue.js              in-process job queue (the Pub/Sub seam)
lib/llm.js                model provider seam: local, Gemini, Anthropic adapters
lib/agents/intake.js      Intake Agent: prompt, schema validation, degradation
lib/agents/pipeline.js    runTask: the single place an artifact is generated
tests/                    workflow, intake, production, and async suites
docs/                     plan, data model, agent contracts, deployment notes
```

`runTask` in `lib/agents/pipeline.js` is the only place an artifact is generated. The
worker calls it to execute a run and a revision calls it again to rerun affected
agents. Adding a second generation path is how the two silently drift apart.

`data.js`, `intake-heuristics.js`, `production-heuristics.js`, and `view-model.js`
are plain browser scripts loaded through `<script>` tags, and Node evaluates the same
files in a sandbox to reuse them server-side and in tests. They must stay free of
`require`, `module.exports`, `import`, and `export`. This is what lets the offline
path run the same agents as the server rather than a second implementation of them.

Adding a top-level source file means registering it in three places: the `check`
script in `package.json`, the `COPY` list in the `Dockerfile`, and, for browser
scripts, the `<script>` tags in `index.html`.

## Local Server Behavior

- Workflow runs are kept in memory keyed by `trace_id`, capped at 50 runs with
  least-recently-used eviction. Restarting the server drops all runs.
- `data.js` is cached against its own contents rather than its timestamp, so
  editing the demo scenario takes effect without restarting the server.
- `PORT` overrides the default `4173`. The `Dockerfile` sets `8080` for Cloud Run.

Validation:

```bash
npm run check
npm test
```

`npm run check` is a syntax pass over every source file. `npm test` is a single
plain-`assert` script covering run creation, the revision loop and artifact
versioning, run-store eviction, the script cache, HTML escaping, and API response
normalization.

## StudioFlow AI Summary

StudioFlow AI is designed for advertising agencies, brand studios, AI video
studios, and pre-production teams. It demonstrates an agentic workflow rather
than a single-turn generator:

- intake and clarification of a creative brief
- task graph planning
- asynchronous specialist agents
- structured artifacts
- critic review
- human approval
- audit logging
- Google Cloud deployment proof

## Hackathon Strategy

Primary track: **Taskmaster**

Technical posture:

- Gemini 3.5 or later
- Google ADK or GenAI SDK
- Cloud Run
- Firestore
- Pub/Sub or Cloud Tasks
- Cloud Storage
- Cloud Logging

The project should be judged as a workflow execution system: the agent takes
responsibility for moving creative production forward, while keeping humans in
control at important review points.

## Near-Term Backend Path

The current server is intentionally zero-dependency Node.js so the prototype can
run anywhere. The Cloud Run version should preserve the same API shape while
swapping local seed data for Google Cloud services:

- `/api/demo` reads project seed data from Firestore.
- `/api/workflow/run` creates a workflow run, stores tasks, and dispatches jobs
  through Pub/Sub or Cloud Tasks.
- Worker endpoints call Gemini through Google ADK or the GenAI SDK.
- Generated artifacts are written to Cloud Storage.
- Audit events include Cloud Logging trace IDs.
