# StudioFlow AI Deployment Notes

The MVP is a zero-dependency Node.js service that can run locally or on Cloud
Run. It serves the web prototype and exposes the first API endpoints that will
later connect to Firestore, Pub/Sub, Cloud Storage, Gemini, and ADK.

## Live Deployment

**Service URL:** <https://studioflow-ai-334984245629.us-central1.run.app>

`GET /api/health` is the whole deployment claim in one response, which is why the
demo points a cursor at it instead of at a console tab:

```json
{
  "service":  "studioflow-ai",
  "revision": "studioflow-ai-00009-wm4",
  "runtime":  "cloud-run",
  "intake_provider": "gemini",
  "intake_model":    "gemini-3.5-flash-lite"
}
```

`service` / `revision` / `runtime` come from `K_SERVICE` and `K_REVISION`, which
only Cloud Run injects — absent locally, which is what makes their presence
evidence rather than a string someone typed.

- GCP project `studioflow-ai-2026`, region `us-central1`, service `studioflow-ai`
- Built by Cloud Build from the repository Dockerfile; no local Docker
- `GEMINI_API_KEY` from Secret Manager (`gemini-api-key:latest`), read by the
  default compute service account
- Billing is a hackathon credit grant (£112.82), not a card. A £20 budget alert at
  25 / 50 / 90 % is attached to the project

### The instance flags, and the one that is deliberately absent

**Since 2026-08-27 the store is mirrored to Firestore** (`FIRESTORE_PROJECT` env
var; see `lib/store-firestore.js`): every save/update is written through in the
background and a Map miss rehydrates from Firestore, so **a restart or
scale-to-zero no longer loses completed runs** — `/api/health` reports the mirror
under `store`, including the last write error if one is stuck.

`--max-instances=1` stays set anyway: the job queue is in-process and per-instance,
and two instances interleaving review actions on one run would race. The mirror
removes the *durability* reason for the flag, not the *concurrency* one.

`--min-instances=1` is **deliberately not set.** Scale-to-zero once wiped in-flight
runs; now it only costs a cold start plus a rehydration read. An always-allocated
container bills against a finite credit grant. Turn it on only for the window in
which you are recording or being judged:

```bash
gcloud run services update studioflow-ai --region us-central1 --min-instances=1
gcloud run services update studioflow-ai --region us-central1 --min-instances=0
```

### The Veo render (2026-08-28)

The approved packet's hero shot can be rendered into one 8-second clip with
**`veo-3.1-fast-generate-001`** on Vertex AI (`lib/veo.js` — REST via the
metadata token, zero new dependencies). Design constraints, all deliberate:

- **Downstream of the human gate**: `POST /api/workflow/:id/render` answers 409
  until every review item is closed. Nothing renders before a human approved.
- **One clip per run**, and a hard per-instance cap (`STUDIOFLOW_RENDER_CAP`,
  default 10) because the URL is public and every render is billed (~£1–2).
- The prompt is the packet's own hero-shot prompt and the **negative prompt is
  the packet's shared negative prompt** — the render inherits the brief's
  prohibitions through the artifact a human just reviewed.
- The operation name is saved on the run (Firestore-mirrored), so a finished
  render survives a restart; the video route re-fetches it on a cache miss.
- `STUDIOFLOW_VEO=off` disables the feature; `/api/health` reports `render`.

Requires `roles/aiplatform.user` on the runtime service account (granted).
Cost note: hitting the cap on demo day costs at most cap × ~£2.

### Model choice was measured, not assumed

`gemini-3.5-flash-lite`, and the code default rather than a Cloud Run env var, so
the repository is the single source of truth. Measured against this key:

| Model | Result |
| --- | --- |
| `gemini-3.6-flash` | `429 prepayment credits are depleted` — unusable |
| `gemini-3.5-flash` | intermittent `503`, model overloaded |
| **`gemini-3.5-flash-lite`** | **answers reliably, ~4.3s against ~10s** |

All three satisfy the "Gemini 3.5 or newer" rule; only one of them works.

**Verified on the live service, 8 consecutive runs:** intake asks exactly one
question, answering it clears that question and the finding it caused, three
findings become two, revise produces shots v2 with different content, approve
closes the run with a packet. 8/8.

**Health reports the CONFIGURED provider, not a working one.** A call can fail and
degrade to the keyless parser while `/api/health` still says `gemini` — that
happened on the first deploy. `parsed_by` on a run, and `degraded_reason` in its
audit trail, are the honest answers. `npm run smoke` exists for the same reason.

**Production behaviour worth knowing:** the Gemini free tier sheds load with
intermittent 503s, and does so far more aggressively for requests from cloud
egress IPs — the same call that succeeds from a laptop can 503 from Cloud Run.
The adapter retries 5xx a bounded number of times (see `lib/llm.js`), and a run
that still fails degrades to the keyless parser with the reason in the audit
trail rather than dying.

## Local

```bash
npm start
```

Open:

```text
http://localhost:4173
```

Health check:

```bash
curl http://localhost:4173/api/health
```

## Verifying the Image Without Docker

Docker is not required to check that the image would boot. Stage exactly the files
the `Dockerfile` copies and run the server from that tree — if anything is missing
from the `COPY` list, the staged server fails the same way the container would:

```bash
STAGE=$(mktemp -d) && sed -n 's/^COPY \([^ ]*\) .*/\1/p' Dockerfile | while read -r f; do mkdir -p "$STAGE/$(dirname "$f")" && cp -r "$f" "$STAGE/$f"; done && (cd "$STAGE" && PORT=8080 node server.js)
```

Then check `http://localhost:8080/api/health` and load the page. `npm test` also
asserts that every top-level source file appears in the `COPY` list, the `check`
script, and `index.html`, so drift is caught before it reaches a build.

**Status:** verified this way — the staged tree boots on `PORT=8080`, serves every
asset, and completes a workflow run. It has never been built by Docker or deployed to
Cloud Run; neither `docker` nor `gcloud` was available.

## Cloud Run Target

The included `Dockerfile` uses Node 24 and listens on `PORT`, which Cloud Run
sets automatically.

Example deployment commands:

```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/studioflow-ai
gcloud run deploy studioflow-ai \
  --image gcr.io/PROJECT_ID/studioflow-ai \
  --region us-central1 \
  --allow-unauthenticated
```

Replace `PROJECT_ID` and region as needed.

## Wiring Gemini

Nothing in the code changes — the provider is chosen from the environment:

```bash
GEMINI_API_KEY=... npm start
```

`GET /api/health` reports which provider is actually live (`intake_provider`). If it
still says `local`, the key was not picked up and the run is using the keyless
parser. A misconfigured provider (`STUDIOFLOW_LLM=gemini` without a key) refuses to
start rather than silently downgrading.

On Cloud Run, supply the key as a secret rather than an env var in the manifest:

```bash
gcloud run deploy studioflow-ai \
  --image gcr.io/PROJECT_ID/studioflow-ai \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

The adapters have been exercised against a local stub server (`tests/async.test.js`)
but never against a live endpoint. Expect the first real call to be the actual test —
the most likely failure is a model id that no longer exists, which `GEMINI_MODEL`
overrides without a code change.

## Hackathon Proof To Capture

For the demo video and Devpost submission, capture:

- Cloud Run service URL.
- Cloud Run revision or deployment screen.
- `/api/health` response.
- `/api/workflow/run` response or logs.
- `/api/workflow/:traceId/reviews/:reviewId` response after a human review
  action.
- Cloud Logging entries for a workflow run.

## Next Cloud Integrations

Preserve the current API shape while swapping implementation details:

- `GET /api/demo`: read project seed data from Firestore.
- `POST /api/workflow/run`: create tasks in Firestore and dispatch them to
  Pub/Sub or Cloud Tasks.
- Worker route: execute specialist agents with Google ADK or GenAI SDK.
- Artifact write: store markdown packets and generated files in Cloud Storage.
- Audit events: include Cloud Logging trace IDs for review and demo proof.
