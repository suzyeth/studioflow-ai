// Firestore mirror for the run store — durability without breaking the
// synchronous store contract.
//
// createRunStore is synchronous on purpose (see the guard inside it that
// rejects async updaters), and executeRun writes through it after every task
// state change. Making that chain async would touch every call site days
// before a deadline. So Firestore is wired as a WRITE-THROUGH MIRROR instead:
// the in-memory Map stays the synchronous source of truth for the request
// path, every save/update is mirrored to Firestore in the background, and a
// GET that misses the Map (cold start, second instance) rehydrates from
// Firestore before answering 404. The mirror lags a write by milliseconds,
// which a 2-second poller cannot observe.
//
// Zero new dependencies. This talks to Firestore's REST API with the fetch
// built into Node, authenticated by the metadata-server token that Cloud Run
// provides to its service account. The @google/genai budget (the project's
// one allowed dependency) stays spent on the rules requirement it satisfies.
//
// Each run is one document: runs/{trace_id} with the whole run JSON in a
// single string field. A run is tens of kilobytes against Firestore's 1MB
// document limit, and storing it as one string sidesteps the entire
// JSON-to-Firestore-value mapping problem.
//
// The two agent rules apply here unchanged:
//   - A mirror failure must never fail a run: save() swallows errors into
//     `lastError` (surfaced by /api/health) and the in-memory path continues.
//   - A misconfiguration must fail loudly: probe() is called at startup when
//     FIRESTORE_PROJECT is set, and a server that cannot reach Firestore
//     refuses to start rather than silently serving without durability.

const { METADATA_TOKEN_URL, createTokenSource } = require("./gcp-token");

const FIRESTORE_BASE_URL = "https://firestore.googleapis.com";

function createFirestoreMirror({
  projectId,
  baseUrl = FIRESTORE_BASE_URL,
  tokenUrl = METADATA_TOKEN_URL,
  collection = "runs",
}) {
  if (!projectId) {
    throw new Error("createFirestoreMirror requires a projectId");
  }

  const documentsRoot = `${baseUrl}/v1/projects/${projectId}/databases/(default)/documents/${collection}`;

  const tokens = createTokenSource({ tokenUrl });
  const getToken = () => tokens.getToken();
  let lastError = null;

  async function writeRun(run) {
    const token = await getToken();
    const response = await fetch(`${documentsRoot}/${encodeURIComponent(run.trace_id)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          data: { stringValue: JSON.stringify(run) },
          updated_at: { timestampValue: new Date().toISOString() },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`firestore write answered HTTP ${response.status}`);
    }
  }

  return {
    name: "firestore",
    projectId,

    get lastError() {
      return lastError;
    },

    // Fire-and-forget. The caller is synchronous and must stay so; a failed
    // mirror write is recorded, surfaced on /api/health, and never thrown.
    save(run) {
      writeRun(run)
        .then(() => {
          lastError = null;
        })
        .catch((error) => {
          lastError = { message: error.message, at: new Date().toISOString() };
        });
    },

    // Rehydration read for a Map miss. Null means "genuinely not found" AND
    // "could not ask" — the caller answers 404 either way, and the failure is
    // on lastError rather than in the poller's face.
    async fetch(traceId) {
      try {
        const token = await getToken();
        const response = await fetch(`${documentsRoot}/${encodeURIComponent(traceId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`firestore read answered HTTP ${response.status}`);
        }
        const doc = await response.json();
        const raw = doc?.fields?.data?.stringValue;
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        lastError = { message: error.message, at: new Date().toISOString() };
        return null;
      }
    },

    // Startup probe: prove we can authenticate and reach the database. A miss
    // on a sentinel document is success — only transport and auth failures
    // throw. Misconfiguration must fail loudly, and at boot, not mid-demo.
    //
    // The sentinel must not match `__.*__` — Firestore reserves those document
    // ids and answers 400 INVALID_ARGUMENT. The first name here was `__probe__`
    // and it took the first real deployment to find out; the stub now enforces
    // the same rule so the name cannot regress.
    async probe() {
      const token = await getToken();
      const response = await fetch(`${documentsRoot}/startup-probe`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`firestore probe answered HTTP ${response.status}`);
      }
    },
  };
}

// Wraps the synchronous in-memory store so every write is mirrored and the
// interface stays exactly createRunStore's. executeRun and the routes cannot
// tell the difference, which is the point.
function withMirror(store, mirror) {
  if (!mirror) return store;

  return {
    save(run) {
      const saved = store.save(run);
      mirror.save(saved);
      return saved;
    },
    get(traceId) {
      return store.get(traceId);
    },
    update(traceId, updater) {
      const updated = store.update(traceId, updater);
      if (updated) mirror.save(updated);
      return updated;
    },
    get size() {
      return store.size;
    },
  };
}

module.exports = {
  FIRESTORE_BASE_URL,
  METADATA_TOKEN_URL,
  createFirestoreMirror,
  withMirror,
};
