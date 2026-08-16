// Lists the Gemini models the current API key can actually call.
//
// TODO.md warns that the first real call is most likely to fail on a stale model
// id. Run this before that first call so the default is verified rather than
// guessed:
//
//   GEMINI_API_KEY=... node scripts/list-models.js
//
// Dev tool only — deliberately not in the Dockerfile COPY list and not required
// by the server. Zero dependencies, same as the rest of the project.

const { GEMINI_BASE_URL } = require("../lib/llm.js");

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("Set GEMINI_API_KEY (or GOOGLE_API_KEY) first.");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.GEMINI_BASE_URL || GEMINI_BASE_URL;
  const url = `${baseUrl}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;

  let payload;
  try {
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    payload = JSON.parse(text);
  } catch (error) {
    console.error(`Model listing failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const usable = (payload.models || []).filter((model) =>
    (model.supportedGenerationMethods || []).includes("generateContent"),
  );

  if (usable.length === 0) {
    console.error("Key works, but no model on it supports generateContent.");
    process.exitCode = 1;
    return;
  }

  console.log(`${usable.length} model(s) support generateContent:\n`);
  for (const model of usable) {
    // API returns "models/gemini-x"; GEMINI_MODEL wants the bare id.
    console.log(`  ${String(model.name).replace(/^models\//, "")}`);
  }
  console.log("\nUse one as: GEMINI_API_KEY=... GEMINI_MODEL=<id> npm start");
}

main();
