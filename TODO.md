# TODO — work that needs a different machine or a human

Everything here is blocked on something the codebase cannot do for itself: an API
key, a cloud account, or software that is not installed. Written to be picked up
cold on another machine.

Current blocker summary: **no Gemini key, no `gcloud`, no `docker`** on the machine
this was built on (Windows 11, winget available).

---

## 1. Gemini API key — makes the "uses Gemini" claim true

Free tier, no billing account required. Separate from Google Cloud below.

- [ ] Get a key from Google AI Studio
- [ ] Run with it: `GEMINI_API_KEY=... npm start`
- [ ] Confirm it took effect: `curl localhost:4173/api/health` → `intake_provider`
      must say `gemini`, not `local`
- [ ] Run a workflow and confirm the structured brief still looks sane

**Nothing in the code changes.** The provider is selected from the environment.
If health still says `local`, the key was not picked up and the run silently used
the keyless parser — that is the designed fallback, not a crash.

**Expect the first real call to fail.** The Gemini and Anthropic adapters in
`lib/llm.js` have only ever been exercised against a local stub server
(`tests/async.test.js` covers request shape, response parsing, fenced JSON, HTTP
errors, timeouts). Authentication and real model behaviour are unverified.

Most likely failure: the default model id `gemini-2.5-flash` no longer exists.
Override without touching code:

```bash
GEMINI_API_KEY=... GEMINI_MODEL=<current-model-id> npm start
```

Check the current list with the provider's own model-listing endpoint before
guessing.

---

## 2. Cloud Run deployment — produces the submission URL

Needs a Google Cloud project **with billing enabled**. Cloud Run has a free tier
but will not turn on without a billing account. This is separate from the Gemini
key above.

- [ ] `winget install Google.CloudSDK`
- [ ] `gcloud auth login` (opens a browser — must be done by a human)
- [ ] Create/select a GCP project, enable billing
- [ ] `gcloud config set project PROJECT_ID`
- [ ] Enable the APIs: `gcloud services enable run.googleapis.com cloudbuild.googleapis.com`
- [ ] Build: `gcloud builds submit --tag gcr.io/PROJECT_ID/studioflow-ai`
- [ ] Deploy (note the instance flags — see the warning below)
- [ ] Record the public URL in `docs/DEPLOYMENT.md`

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
- [ ] `production-heuristics.js` is 475 lines and growing with each Critic check —
      splitting the checks out is the natural next seam.
