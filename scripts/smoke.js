// First-real-call smoke test: proves the model is genuinely in the path.
//
// The keyless parser is the floor, and a run that silently falls back to it
// looks identical from the outside. This runs the Intake Agent twice — once on
// the configured provider, once forced local — and prints both, so "powered by
// Gemini" is something you can see rather than assume.
//
//   PowerShell:  $env:GEMINI_API_KEY="..."; node scripts/smoke.js
//   Git Bash:    GEMINI_API_KEY=... node scripts/smoke.js

const path = require("path");
const { createProvider, createLocalProvider } = require("../lib/llm");
const { runIntakeAgent } = require("../lib/agents/intake");
const {
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
} = require("../lib/workflow");

const rootDir = path.join(__dirname, "..");
const intakeHeuristics = loadIntakeHeuristics(rootDir);
const production = loadProductionHeuristics(rootDir);
const demo = loadDemoData(rootDir);

const BRIEF = [
  "Create a 30-second launch film for a premium canned coffee brand entering the Tokyo night market.",
  "Style: Neon realism, cinematic, energetic.",
  "Constraints: Show the product in the first 5 seconds, avoid health claims, include a clear CTA, deliver for Instagram Reels.",
].join("\n");

function show(label, result) {
  const brief = result.artifact.structured_brief;
  console.log(`\n=== ${label} ===`);
  console.log(`  provider   : ${result.provider}${result.degraded ? "  ** DEGRADED **" : ""}`);
  if (result.degraded) console.log(`  reason     : ${result.degraded_reason}`);
  console.log(`  goal       : ${brief.goal}`);
  console.log(`  audience   : ${brief.audience}`);
  console.log(`  platform   : ${brief.platform}   duration: ${brief.duration_seconds}`);
  console.log(`  style      : ${(brief.style || []).join(", ")}`);
  console.log(`  constraints:`);
  for (const c of brief.constraints || []) console.log(`     - ${c}`);
  console.log(`  questions  : ${(result.clarifying_questions || []).length}`);
  console.log(`  summary    : ${result.summary}`);

  const built = production.buildAll(brief, result.clarifying_questions || []);
  console.log(`  findings   : ${built.findings.map((f) => f.id).join(", ") || "(none)"}`);
}

(async () => {
  const provider = createProvider(intakeHeuristics);
  console.log(`configured provider : ${provider.name}`);
  console.log(`model               : ${provider.model || "(n/a)"}`);

  if (provider.name === "local") {
    console.log("\nNo key is set, so this is the keyless path. Set GEMINI_API_KEY and rerun.");
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const live = await runIntakeAgent(
    { briefText: BRIEF },
    { provider, heuristics: intakeHeuristics },
  );
  const ms = Date.now() - started;

  show(`${provider.name} · ${provider.model} · ${ms}ms`, live);
  show("local (keyless parser, for comparison)", await runIntakeAgent(
    { briefText: BRIEF },
    { provider: createLocalProvider(intakeHeuristics), heuristics: intakeHeuristics },
  ));

  console.log("\n---");
  if (live.degraded) {
    console.log("RESULT: the model call FAILED and the run degraded to the parser.");
    console.log("The 'powered by Gemini' claim is not yet demonstrable. Reason above.");
    process.exitCode = 1;
  } else {
    console.log(`RESULT: ${provider.name} answered, validated against the contract, and became the artifact.`);
  }
})();
