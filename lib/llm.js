// Provider seam for agent model calls.
//
// Gemini goes through the official Google GenAI SDK. That is a hackathon rule,
// not a preference: All Things Agentic requires at least one Google agent
// framework (ADK / GenAI SDK / Antigravity SDK / Genkit), and a hand-rolled
// fetch against the REST endpoint does not satisfy it. It is the project's only
// runtime dependency, and the reason the "zero dependencies" rule no longer holds.
//
// Anthropic and local stay dependency-free. Selection order: STUDIOFLOW_LLM wins,
// otherwise the first available key, and "local" is the floor so the workflow
// always runs.

const { GoogleGenAI } = require("@google/genai");

const DEFAULT_TIMEOUT_MS = 20_000;

// Overridable so the adapters can be pointed at a local stub in tests. Everything
// except authentication and real model behaviour is exercised that way.
//
// NOTE: no `/v1beta` suffix — the GenAI SDK appends the API version itself, so
// including it here produces `/v1beta/v1beta/...`. Callers that build REST paths
// by hand (scripts/list-models.js) must add the version themselves.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const DEFAULT_MODELS = {
  // Overridable because model ids move. Verify against the provider's own model
  // listing before relying on either default: `node scripts/list-models.js`.
  //
  // gemini-3.5-flash-lite, chosen on measurements rather than on being newest.
  // Against this key gemini-3.6-flash returns 429 "prepayment credits are
  // depleted" and gemini-3.5-flash returns intermittent 503s; flash-lite answers
  // reliably, is ~4.3s against ~10s, and still satisfies the hackathon's
  // "Gemini 3.5 or newer" rule. The Intake Agent's job is structured extraction,
  // not prose, so the lite model costs nothing in quality here.
  gemini: "gemini-3.5-flash-lite",
  anthropic: "claude-haiku-4-5-20251001",
};

function stripCodeFence(text) {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text.trim();
}

function parseJsonPayload(text, providerName) {
  const cleaned = stripCodeFence(String(text || ""));
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`${providerName} did not return valid JSON: ${error.message}`);
  }
}

async function postJson(url, { headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Runs the keyless parser. Always available, never fails, no network.
function createLocalProvider(heuristics) {
  return {
    name: "local",
    requiresKey: false,
    async generateJson({ briefText }) {
      return heuristics.parseBrief(briefText);
    },
  };
}

// Verified against the live endpoint on 2026-08-26 (first real call). One
// production behaviour matters here: the free tier sheds load with intermittent
// 503s, and it does so far more aggressively for requests arriving from cloud
// egress IPs — the same call that succeeds from a laptop can 503 repeatedly
// from Cloud Run. A single attempt would degrade the run on what is usually a
// seconds-long spike, so 5xx responses are retried a bounded number of times.
//
// Only 5xx. A 429 is not retried on purpose: Gemini uses it for exhausted
// quota and depleted credits, which no amount of waiting fixes — retrying it
// just delays the honest degradation. 4xx are misconfiguration and fail fast.
function createGeminiProvider({
  apiKey,
  model,
  timeoutMs,
  baseUrl = GEMINI_BASE_URL,
  retries = 2,
  retryDelayMs = 1200,
}) {
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { baseUrl, timeout: timeoutMs },
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The retry loop, shared by the text and video calls. 5xx only (see above);
  // errors are normalised to the `HTTP <code>` shape the audit trail expects,
  // with the attempt count when retries were spent.
  async function generate(parts) {
    const attempts = retries + 1;
    let response;

    for (let attempt = 1; ; attempt += 1) {
      try {
        response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: parts.contents }],
          config: {
            systemInstruction: parts.system,
            temperature: 0,
            responseMimeType: "application/json",
          },
        });
        break;
      } catch (error) {
        const status = error && typeof error.status === "number" ? error.status : null;

        if (status !== null && status >= 500 && status < 600 && attempt < attempts) {
          // Doubling backoff: 1.2s, 2.4s on the defaults. Worst case adds a
          // few seconds to a call the demo already budgets ~8s for.
          await sleep(retryDelayMs * attempt);
          continue;
        }

        if (status !== null) {
          const suffix = attempt > 1 ? ` (after ${attempt} attempts)` : "";
          throw new Error(`HTTP ${status}: ${String(error.message).slice(0, 200)}${suffix}`);
        }
        throw error;
      }
    }

    // `.text` is undefined rather than throwing when a response carries no
    // candidates, so the guard has to stay.
    const text = response?.text;
    if (!text) {
      throw new Error("gemini returned no content");
    }
    // Still fenced sometimes, even with responseMimeType set.
    return parseJsonPayload(text, "gemini");
  }

  return {
    name: "gemini",
    requiresKey: true,
    model,
    baseUrl,
    retries,
    async generateJson({ system, user }) {
      return generate({ system, contents: [{ text: user }] });
    },
    // Multimodal: the same call with a video attached inline. Only the Gemini
    // provider has this — callers must treat its absence as "audit unavailable",
    // not as an error (the Render Critic does exactly that).
    async generateJsonFromVideo({ system, user, video, mimeType }) {
      return generate({
        system,
        contents: [
          { inlineData: { mimeType: mimeType || "video/mp4", data: video.toString("base64") } },
          { text: user },
        ],
      });
    },
  };
}

// NOTE: unverified against a live endpoint, same as the Gemini adapter above.
function createAnthropicProvider({ apiKey, model, timeoutMs, baseUrl = ANTHROPIC_BASE_URL }) {
  return {
    name: "anthropic",
    requiresKey: true,
    model,
    baseUrl,
    async generateJson({ system, user }) {
      const payload = await postJson(`${baseUrl}/v1/messages`, {
        timeoutMs,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: 2048,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
        },
      });

      const text = payload?.content?.find((block) => block.type === "text")?.text;
      if (!text) {
        throw new Error("anthropic returned no content");
      }
      return parseJsonPayload(text, "anthropic");
    },
  };
}

function createProvider(heuristics, env = process.env) {
  const timeoutMs = Number(env.STUDIOFLOW_LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const requested = (env.STUDIOFLOW_LLM || "").toLowerCase();

  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  const wants = requested || (geminiKey ? "gemini" : anthropicKey ? "anthropic" : "local");

  if (wants === "gemini") {
    if (!geminiKey) throw new Error("STUDIOFLOW_LLM=gemini requires GEMINI_API_KEY");
    return createGeminiProvider({
      apiKey: geminiKey,
      model: env.GEMINI_MODEL || DEFAULT_MODELS.gemini,
      baseUrl: env.GEMINI_BASE_URL || GEMINI_BASE_URL,
      timeoutMs,
      retries: env.STUDIOFLOW_LLM_RETRIES === undefined ? 2 : Number(env.STUDIOFLOW_LLM_RETRIES),
    });
  }

  if (wants === "anthropic") {
    if (!anthropicKey) throw new Error("STUDIOFLOW_LLM=anthropic requires ANTHROPIC_API_KEY");
    return createAnthropicProvider({
      apiKey: anthropicKey,
      model: env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic,
      baseUrl: env.ANTHROPIC_BASE_URL || ANTHROPIC_BASE_URL,
      timeoutMs,
    });
  }

  return createLocalProvider(heuristics);
}

module.exports = {
  ANTHROPIC_BASE_URL,
  DEFAULT_MODELS,
  GEMINI_BASE_URL,
  createAnthropicProvider,
  createGeminiProvider,
  createLocalProvider,
  createProvider,
  parseJsonPayload,
};
