# StudioFlow AI Deployment Notes

The MVP is a zero-dependency Node.js service that can run locally or on Cloud
Run. It serves the web prototype and exposes the first API endpoints that will
later connect to Firestore, Pub/Sub, Cloud Storage, Gemini, and ADK.

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
