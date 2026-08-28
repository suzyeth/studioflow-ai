// Veo renderer — one hero shot, after the human said yes.
//
// The product is a workflow system, not a video generator, and the scope
// guardrails say it must stay one. This module renders exactly ONE clip per
// run — the hero shot — and only once the packet is approved, so the render is
// downstream of the human gate rather than a bypass of it. The prompt is the
// prompt pack's own entry for the hero shot, and the negative prompt is the
// pack's shared negative prompt — the render inherits the brief's prohibitions
// through the same artifact a human just reviewed.
//
// Vertex AI REST through the metadata-server token, zero new dependencies,
// same posture as the Firestore mirror. Video generation is a long-running
// operation: start() returns an operation name, poll() fetches it, and the
// operation name is saved on the run — which the Firestore mirror persists, so
// a finished render survives an instance restart and can be fetched again.
//
// Cost control is part of the design, not an afterthought: the service URL is
// public and the API is metered, so the renderer carries a hard per-instance
// cap. When it is spent, rendering answers 429 until the instance recycles.

const { METADATA_TOKEN_URL, createTokenSource } = require("./gcp-token");

const DEFAULT_VEO_MODEL = "veo-3.1-fast-generate-001";
const DEFAULT_REGION = "us-central1";

function createVeoRenderer({
  projectId,
  model = DEFAULT_VEO_MODEL,
  region = DEFAULT_REGION,
  baseUrl,
  tokenUrl = METADATA_TOKEN_URL,
  cap = 10,
}) {
  if (!projectId) {
    throw new Error("createVeoRenderer requires a projectId");
  }

  const root = baseUrl || `https://${region}-aiplatform.googleapis.com`;
  const modelUrl = `${root}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}`;
  const tokens = createTokenSource({ tokenUrl });

  let used = 0;

  async function post(action, body) {
    const token = await tokens.getToken();
    const response = await fetch(`${modelUrl}:${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(text);
  }

  return {
    name: "veo",
    model,

    get used() {
      return used;
    },
    get cap() {
      return cap;
    },
    get spent() {
      return used >= cap;
    },

    // Starts one generation and returns the operation name. Counts against the
    // cap on acceptance, not on completion — a started render is a billed one.
    async start({ prompt, negativePrompt, aspectRatio }) {
      if (used >= cap) {
        throw new Error(`render cap reached (${cap} per instance)`);
      }

      const parameters = { durationSeconds: 8, sampleCount: 1 };
      if (negativePrompt) parameters.negativePrompt = negativePrompt;
      if (aspectRatio) parameters.aspectRatio = aspectRatio;

      let operation;
      try {
        operation = await post("predictLongRunning", {
          instances: [{ prompt }],
          parameters,
        });
      } catch (error) {
        // Not every Veo model accepts every aspect ratio. A 400 with the ratio
        // set is retried without it — a landscape hero shot beats no render.
        if (error.status === 400 && aspectRatio) {
          operation = await post("predictLongRunning", {
            instances: [{ prompt }],
            parameters: { ...parameters, aspectRatio: undefined },
          });
        } else {
          throw error;
        }
      }

      if (!operation.name) {
        throw new Error("veo returned no operation name");
      }
      used += 1;
      return operation.name;
    },

    // Fetches the operation. Not done → { done: false }. Done → the video as a
    // Buffer, or { filtered: true } when safety filtering removed every sample
    // (raiMediaFilteredCount), which is an outcome to report, not an error.
    async poll(operationName) {
      const op = await post("fetchPredictOperation", { operationName });

      if (!op.done) {
        return { done: false };
      }
      if (op.error) {
        throw new Error(
          `veo operation failed: ${JSON.stringify(op.error).slice(0, 200)}`,
        );
      }

      const videos = op.response?.videos || [];
      if (videos.length === 0) {
        const filteredCount = op.response?.raiMediaFilteredCount || 0;
        if (filteredCount > 0) {
          return { done: true, filtered: true };
        }
        throw new Error("veo operation finished with no video and no filter reason");
      }

      const video = videos[0];
      if (!video.bytesBase64Encoded) {
        throw new Error("veo returned a video without bytesBase64Encoded");
      }
      return {
        done: true,
        video: Buffer.from(video.bytesBase64Encoded, "base64"),
        mimeType: video.mimeType || "video/mp4",
      };
    },
  };
}

module.exports = { DEFAULT_VEO_MODEL, createVeoRenderer };
