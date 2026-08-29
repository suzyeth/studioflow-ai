# Devpost submission text

Paste-ready. Track: **The Collaborative Partner**.

---

## What it does

A creative brief arrives as a paragraph of prose. Buried in it are constraints — *show
the product in the first five seconds, avoid health claims, include a call to action* —
and the failure that actually costs money is that one of them quietly does not survive
the process into the shot list, the asset plan, and the prompt pack. Nobody notices
until the edit.

**StudioFlow AI turns that brief into a production packet in which every stated
constraint has been checked, and every failed check is traceable to the agent that
caused it and the rerun that fixed it.**

It is not a video generator, and it is not a chatbot. It is a collaborator: it reads
the brief, asks for what is missing, does the work, shows you where its own output
failed your brief, and carries your correction forward.

### It asks before it assumes

Give it `A launch film for a canned coffee brand.` and it does not invent an audience.
It raises exactly the questions that block planning — never more — and each one carries
which field the answer fills and why it matters. Its own Critic separately flags that
the run proceeded on incomplete information.

Answer them and the answers are folded back into the brief as labelled lines, so intake
reads them exactly the way it read the original prose. The whole workflow reruns,
because everything downstream of intake depends on it.

| | Open questions | Findings | First shot |
| --- | --- | --- | --- |
| Before | 3 | `assumed-duration`, `undefined-style`, `open-questions` | 0:00–0:04 *(a 30s default nobody asked for)* |
| After answering | 0 | `undefined-style` | 0:00–0:02 *(re-timed for the real 15s)* |

Three things there are worth more than the feature list. The findings shrank. The one
that survived is the question that was **not** answered, still honestly reported. And
the shot list re-timed itself — the answers did not fill in a form, they changed the
artifact.

### It shows you where it failed you

Six agents run asynchronously — Intake, Planning, Shot, Asset, Prompt, Critic — and the
Critic checks the generated artifacts against the stated constraints. Fifteen checks,
each reading real generated output rather than restating the brief back to you, and
each staying silent when the brief gives it nothing to check. A brief that satisfies
its own constraints produces an empty review queue.

The design decision that makes this real: **the Shot Agent deliberately does not see
the constraints.** Gemini writes its shot descriptions over a fixed, deterministic
skeleton — it cannot move a timing or drop a shot, and it is not shown what the brief
forbids or requires. If it satisfied every constraint up front, the Critic would find
nothing and the review gate would be decorative. The first pass has to be able to be
wrong, and with a real model writing real prose, it genuinely is.

### And once you approve, it renders

After — and only after — every review item is closed, the packet's hero shot can be
rendered into an 8-second clip with **Veo on Vertex AI**. The prompt is the packet's
own hero-shot entry, and the negative prompt is the packet's shared negative prompt:
the render inherits the brief's prohibitions through the artifact a human just
reviewed. One capped clip per run, strictly downstream of the human gate — proof the
packet drives real production, without letting the product collapse into a video
generator.

And the finished clip is not taken on faith. A **Render Critic** — multimodal Gemini
— watches it and judges it against the brief's own constraints, one verdict per
check: pass, fail, or *cannot tell*, with the evidence it saw. The same discipline
that governs the plan-level Critic governs the clip: verdicts are three-state because
a confident wrong verdict is worse than an honest "not sure", the authoritative check
text is the brief's (a model paraphrase never reaches the human), and any failure
reports the audit as skipped rather than inventing results. The constraint chain now
runs unbroken: brief → plan → checked plan → human approval → render → checked
render.

### It carries your correction forward

Each finding names the agents responsible and, where the fix is mechanical, the
constraint that fixes it. Requesting a revision reruns *only* those agents with that
constraint enforced: the shot list advances to v2 **with different content** — the
product moves from 0:10 to 0:00 — records why it was rerun, and appends an audit event.

The correction is not applied once and forgotten. It accumulates in the run's `enforce`
state and every later rerun carries it, so the system never has to be told the same
thing twice. That is the adaptation, implemented as state rather than asserted in a
pitch.

Agent actions and human decisions are distinguished in one audit trail, so the packet
answers not just what was produced but why, and who decided.

---

## How we built it — technologies

- **Gemini 3.5 Flash-Lite** for the Intake and Shot Agents, called through the
  **Google GenAI SDK** (`@google/genai`), with structured JSON output and schema
  validation before any model output is allowed to become an artifact. The model was
  chosen by measuring three candidates against this key, not by picking the newest.
  Transient 5xx responses are retried with backoff — the free tier sheds load from
  cloud egress IPs, which only a deployed service ever sees.
- **Veo 3.1 Fast on Vertex AI** renders the approved hero shot — REST through the
  metadata-server token, one capped clip per run, downstream of the human gate.
- **Cloud Run** for the service, built by **Cloud Build** from the repository
  Dockerfile. **Secret Manager** holds the API key.
- **Firestore** mirrors every run: the in-memory store stays the synchronous source
  of truth, every write is mirrored in the background, and a poll that misses the map
  rehydrates from Firestore — runs survive restarts, verified live by killing the
  instance and polling the same trace.
- **Cloud Logging**, correlated by a `trace_id` carried on every task, artifact and
  audit event.
- **Node.js 24**, and deliberately little else. `@google/genai` is the only runtime
  dependency in the project — Firestore and Veo are hand-rolled REST over the built-in
  fetch. The frontend is plain HTML, CSS and JavaScript with no build step, which is
  what lets the same agent code run in the browser from `file://` and on the server —
  one implementation, two runtimes, no drift.
- Tests are six plain-`assert` suites, no framework — including one that drives the
  real HTTP routes against a stubbed Vertex AI.

**What is not built, stated plainly:** Planning, Asset, Prompt and Critic are
deterministic generators on purpose — the Critic's checks must be exact, not
plausible. The job queue is in-process rather than Pub/Sub (drawn dashed in the
architecture diagram for exactly this reason). Every artifact carries a
`generated_by` field so its provenance — model or derived — is visible rather than
implied.

## Data sources

**None external.** The only input is the brief the user submits, and every artifact in
a run is generated from it — there is no dataset, no corpus, and no scraped content.
`data.js` holds task and artifact *labels* plus one default brief, and deliberately
contains no generated sample output: if a shot list ever appeared in it, that would
mean the agent meant to produce it was missing.

## What we learned

**A wrong finding costs more than a missed one.** The review queue is the only thing
this product can defend, and it is worth nothing if anything in it might not be real.
That principle decided several implementation details — high-severity checks match on
whole words rather than substrings, because `ton` matching `tone` would put a fabricated
violation in front of a human. Two rules govern every check: read real generated output,
and stay silent when the brief says nothing about you.

**An auditor has to know what it is entitled to judge.** The first version of the
Render Critic asked the rendered hero shot every constraint in the brief, and it was
wrong in both directions at once. It failed the clip for "include a clear CTA" — true
of the clip, but the CTA lives at 0:26 and the clip covers 0:10-0:15, so the shot was
blamed for the film's job. And it *passed* "show the product in the first 5 seconds"
because the product appeared at 0:01 **of the clip**, while in the film that shot
starts at 0:10 — a clip does not carry the film's clock, so the verdict was
meaningless. Both are the same mistake: applying a whole-film standard to one shot.
The Critic now scopes its checks — prohibitions bind every frame, a CTA constraint is
answered only by the CTA shot, timing windows belong to the plan Critic that has the
timings — and reports what it did *not* judge, with the reason. A silently dropped
constraint reads exactly like a constraint that passed.

**Prove a check is guarded by breaking it.** Every Critic check was verified by
deliberately breaking it and confirming the suite went red. Six mutations, six failures.
A test that passes tells you nothing until you have seen it fail for the right reason.

**Probe a library, do not read about it.** Moving Gemini onto the GenAI SDK, we ran it
against a local stub server first and found two things no amount of documentation
reading would have surfaced in time: the SDK appends its own API version, so a base URL
carrying `/v1beta` silently becomes `/v1beta/v1beta`; and its `ApiError` has a status
code but no status line in its message, so an adapter that does not re-wrap it breaks
every downstream error string.

**Two failure rules that pull in opposite directions, on purpose.** A model failure must
never fail a run — network errors, malformed JSON and schema violations all degrade to
the keyless parser, and the audit trail says so, because a demo has to survive a dead
API key on stage. But a *misconfiguration* must fail loudly — naming a provider without
its key refuses to start, rather than serving heuristic output while the operator
believes Gemini is live. Silent success is the more dangerous failure.

**Documentation drifts faster than you expect.** Three separate changes we made in one
sitting turned parts of our own README into false statements — a "zero-dependency"
claim, a file that no longer held what it said, a test count. A README that is wrong
about the code is worse than no README, because a judge will find the discrepancy and
correctly stop trusting the rest.

**And the one that was worth more than any feature:** we very nearly submitted to the
wrong track. The original plan targeted Taskmaster, whose judging criterion asks whether
the agent completes a workflow *without human intervention* — while the human review
gate is this product's entire thesis. The single strongest thing about the system would
have been scored against it. Reading the criteria closely, late, was the highest-value
hour of the build.
