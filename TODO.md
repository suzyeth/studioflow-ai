# TODO — work that needs a different machine or a human

Everything here is blocked on something the codebase cannot do for itself: an API
key, a cloud account, or software that is not installed. Written to be picked up
cold on another machine.

Current blocker summary: **items 1–2 are DONE (2026-08-26) — the service is live.**
URL and production notes in `docs/DEPLOYMENT.md`. What remains: evidence capture
(item 3, at demo time), Firestore (item 4), production-agent model calls (item 5).

---

## 1. ~~Gemini API key~~ — DONE 2026-08-19

Free tier, no billing account required. Separate from Google Cloud below.

- [x] Key obtained from Google AI Studio (free tier, no billing account)
- [x] `gemini-3.6-flash` confirmed present on the key — `npm run models` lists 37
      models that support `generateContent`
- [x] Real call succeeds, validates against the contract, and becomes the artifact —
      `npm run smoke` runs the Intake Agent on Gemini and again forced local, side by
      side, because degradation is silent by design

**The first real calls found two bugs the stub tests could not.** Both are fixed:

1. **Gemini invented an audience.** Given a brief about a brand *entering the Tokyo
   night market*, it filled `audience` with "Consumers in the Tokyo night market" —
   a market read as an audience. The keyless parser correctly said "Not stated in
   the brief" and asked. This is exactly the failure the product claims to prevent,
   so the prompt now separates EXTRACT from INFER in the system message and names
   this specific trap in the rules.
2. **Model questions had no `fills` field.** It is not in the old output schema, but
   `server.js` needs it to fold an answer back as `"<label>: <answer>"`. Without it
   the clarification loop silently breaks with a real model. `fills` is now in the
   schema as a closed enum.

Also normalised trailing punctuation on model-filled string fields, which the
keyless parser strips and a model does not — it rendered as `"…night market.. "` in
the summary line the UI shows.

**Note the latency.** Intake takes ~10s against `gemini-3.6-flash` (7.7 / 10.0 / 9.5
across three runs) versus under 3s for the entire graph keyless, and it runs twice in
the demo because answering a clarifying question reruns the workflow. `docs/DEMO_SCRIPT.md`
budgets both gaps as narration.

The provider is still selected from the environment. If health says `local`, the key
was not picked up and the run silently used the keyless parser — that is the designed
fallback, not a crash. `npm run smoke` is the way to tell the difference.

The default is `gemini-3.6-flash` (bumped 2026-08-14 in `lib/llm.js`; GA since
2026-07-21, satisfies the hackathon's "Gemini 3.5 or newer" rule). If it has
moved on again, override without touching code:

```bash
GEMINI_API_KEY=... GEMINI_MODEL=<current-model-id> npm start
```

Check the current list with the provider's own model-listing endpoint before
guessing.

---

## 2. ~~Cloud Run deployment~~ — DONE 2026-08-26

**Live at <https://studioflow-ai-334984245629.us-central1.run.app>** — project
`studioflow-ai-2026`, billing linked, health reports `gemini` / `gemini-3.6-flash`,
and a full run has completed with `parsed_by: gemini`.

- [x] `winget install Google.CloudSDK` — installed 2026-08-19, Cloud SDK 580.0.0
- [x] `gcloud auth login` — authenticated as the account's own Google login
- [x] Project `studioflow-ai-2026` created, billing account linked
- [x] APIs enabled (run, cloudbuild, secretmanager, artifactregistry)
- [x] Built and deployed with the instance flags below; key delivered via Secret
      Manager (`gemini-api-key:latest` — pulled from the AI Studio key that lives
      in the account's `gen-lang-client-0708711476` project, so nothing was pasted)
- [x] Public URL recorded in `docs/DEPLOYMENT.md`

**Two production caveats (learned live, 2026-08-26):**

- The free tier 503s intermittently from Cloud Run egress IPs while the same call
  succeeds from a laptop. `lib/llm.js` now retries 5xx (bounded, default 2); a run
  that still fails degrades honestly with the reason in the audit trail.
- Do NOT "fix" the 503s by linking billing to `gen-lang-client-0708711476`: tried,
  and the paid tier answered `429 prepayment credits depleted` (the billing account
  has no usable Gemini API funds) while also breaking the previously-working free
  tier — unlinked to recover. Revisit only after real credits are confirmed on the
  billing account.

```bash
gcloud run deploy studioflow-ai \
  --image gcr.io/PROJECT_ID/studioflow-ai \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances=1 \
  --min-instances=1 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

### Docker is NOT required

`gcloud builds submit` builds in the cloud. Installing Docker Desktop on Windows
pulls in WSL2/Hyper-V for a capability this project does not need. Skip it.

The image file set has already been verified without Docker: staging exactly the
files the `Dockerfile` copies and booting the server from that tree serves every
asset and completes a workflow run. See "Verifying the Image Without Docker" in
`docs/DEPLOYMENT.md`. `npm test` also fails if a source file is missing from the
`COPY` list.

### ⚠ The instance flags are not optional

The run store is an in-memory `Map` (`createRunStore` in `lib/workflow.js`) and the
client **polls** `GET /api/workflow/:traceId`. On Cloud Run's defaults:

- multiple instances → `POST /run` lands on instance A, the next poll hits
  instance B → **404, and the demo dies on stage**
- scale-to-zero → a cold start wipes every in-flight run

`--max-instances=1 --min-instances=1` avoids both. It is a demo workaround, not a
fix. The real fix is item 4.

---

## 3. Capture submission evidence

Once deployed:

- [ ] Cloud Run service URL
- [ ] Cloud Run revision / deployment screen
- [ ] `/api/health` response showing `intake_provider: gemini`
- [ ] A full run: brief → task graph advancing → critic findings → revision →
      approved packet
- [ ] Cloud Logging entries filtered by a run's `trace_id`

The app already emits `trace_id` on every task, artifact, and audit event, so the
Cloud Logging correlation story works without code changes.

---

## 4. Replace the in-memory store with Firestore

The item that makes the instance flags above unnecessary, and the last piece of the
"Google Cloud architecture" claim that is currently unbacked.

- [ ] Implement a Firestore-backed store behind the same interface as
      `createRunStore` (`save` / `get` / `update` / `size`)
- [ ] Swap it in `server.js` — nothing else should need to change
- [ ] Drop `--max-instances=1` and confirm polling still works across instances

The store interface was kept deliberately narrow for this. Collection layout is
sketched in `docs/DATA_MODEL.md`.

---

## 5. Wire a model into the production agents

Only the Intake Agent can call a model. Planning / Shot / Asset / Prompt / Critic
are deterministic generators, which is why the generated prose reads as structure
rather than writing.

- [ ] Give the Shot Agent a provider call in `runTask`, following the Intake Agent's
      pattern in `lib/agents/intake.js`: prompt → schema validation → degrade to the
      heuristic on any failure
- [ ] Keep the heuristic as the fallback — the offline `file://` path and the
      no-key path both depend on it

Do this **after** deployment is working. It improves how the output reads; it does
not change whether the project satisfies the track.

---

## Not blocked — can be done any time, no key or account needed

- [ ] Add more Critic checks. This is the highest-value work available: each one
      takes a constraint class a brief can express and verifies the artifacts honour
      it. Rules: read real generated output, and stay silent when the brief says
      nothing about it. See the table in `README.md`.
- [ ] `docs/ALL_THINGS_AGENTIC_PLAN.md` lists a Dashboard page that was never built
      (the fourth view is Cloud Proof instead). Either build it or correct the plan.
- [x] ~~`production-heuristics.js` is 475 lines and growing with each Critic check —
      splitting the checks out is the natural next seam.~~ Done: the checks live in
      `critic-checks.js` as a `CHECKS` array, and `production-heuristics.js` is back
      to 378 lines of generators. Proved behaviour-preserving by snapshotting 53
      cases / 66 findings before and after.
