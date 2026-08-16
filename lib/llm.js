// Provider seam for agent model calls.
//
// Zero dependencies on purpose: both hosted providers are plain REST endpoints
// reached with global fetch, so adding one costs an adapter rather than an SDK.
// Selection order: STUDIOFLOW_LLM wins, otherwise the first available key, and
// "local" is the floor so the workflow always runs.

const DEFAULT_TIMEOUT_MS = 20_000;

// Overridable so the adapters can be pointed at a local stub in tests. Everything
// except authentication and real model behaviour is exercised that way.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const DEFAULT_MODELS = {
  // Overridable because model ids move. Verify against the provider's own model
  // listing before relying on either default: `node scripts/list-models.js`.
  //
  // Bumped 2026-08-14 from "gemini-2.5-flash". The GA Gemini 3 line is Flash and
  // Flash-Lite only — there is no GA Pro. Swap to "gemini-3.5-flash-lite" for a
  // cheaper call; the Intake Agent's job is structured extraction, not prose.
  gemini: "gemini-3.6-flash",
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

// NOTE: unverified against a live endpoint — no API key was available when this
// was written. Treat the first real call as the actual test.
function createGeminiProvider({ apiKey, model, timeoutMs, baseUrl = GEMINI_BASE_URL }) {
  return {
    name: "gemini",
    requiresKey: true,
    model,
    baseUrl,
    async generateJson({ system, user }) {
      const url =
        `${baseUrl}/models/` +
        `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const payload = await postJson(url, {
        timeoutMs,
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        },
      });

      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error("gemini returned no content");
      }
      return parseJsonPayload(text, "gemini");
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
