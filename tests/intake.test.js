const assert = require("assert");
const path = require("path");
const { createProvider, createLocalProvider, parseJsonPayload } = require("../lib/llm");
const { runIntakeAgent, buildUserPrompt } = require("../lib/agents/intake");
const {
  createQueuedRun,
  createRunStore,
  executeRun,
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
  loadViewModel,
} = require("../lib/workflow");

const rootDir = path.join(__dirname, "..");
const heuristics = loadIntakeHeuristics(rootDir);
const production = loadProductionHeuristics(rootDir);
const demo = loadDemoData(rootDir);
const view = loadViewModel(rootDir);

// --- brief parsing -----------------------------------------------------------
// The labelled form, which is how the bundled scenario is written.
const labelled = heuristics.parseBrief(demo.brief.text);
assert.equal(labelled.structured_brief.duration_seconds, 30);
assert.equal(labelled.structured_brief.platform, "Instagram Reels");
assert.equal(labelled.structured_brief.audience, "young urban professionals");
assert.ok(labelled.structured_brief.constraints.length >= 3);
assert.ok(labelled.structured_brief.style.length > 0);
assert.equal(
  labelled.clarifying_questions.length,
  0,
  "a complete brief raises no clarifying questions",
);

// A completely different brief must produce completely different output. This is
// the regression that matters: the scenario used to be returned verbatim no
// matter what the user typed.
const arctic = heuristics.parseBrief(
  [
    "Goal: A 90-second documentary short about Arctic ice cores.",
    "Audience: research scientists and policy makers",
    "Platform: YouTube",
    "Style: naturalistic, intimate",
    "Constraints: no music, avoid dramatised reenactments, show raw field footage",
  ].join("\n"),
);
assert.equal(arctic.structured_brief.duration_seconds, 90);
assert.equal(arctic.structured_brief.platform, "YouTube");
assert.equal(arctic.structured_brief.audience, "research scientists and policy makers");
assert.ok(arctic.structured_brief.constraints.some((c) => /no music/i.test(c)));
assert.ok(!JSON.stringify(arctic).includes("Tokyo"), "no scenario text leaks into the result");
assert.ok(!JSON.stringify(arctic).includes("Instagram"));

// Minutes are normalised to seconds.
assert.equal(heuristics.parseBrief("Make a 2 minute film.").structured_brief.duration_seconds, 120);

// Unlabelled prose still yields something usable, and asks about what is missing.
const sparse = heuristics.parseBrief("We need a teaser for the new running shoe.");
assert.equal(sparse.structured_brief.duration_seconds, null);
assert.ok(sparse.structured_brief.goal.length > 0);
assert.ok(
  sparse.clarifying_questions.some((q) => q.id === "question_duration"),
  "a missing duration is asked about",
);
assert.ok(sparse.clarifying_questions.every((q) => q.question && q.why_it_matters));

// Every question must name the brief label its answer belongs under, otherwise
// answering it produces a line the parser cannot read back.
assert.ok(sparse.clarifying_questions.every((q) => q.fills));

// Folding answers back in as labelled lines must actually resolve the questions.
const answeredBrief = [
  "We need a teaser for the new running shoe.",
  ...sparse.clarifying_questions.map((q) => `${q.fills}: ${
    { Audience: "urban runners", Platform: "Instagram Reels", Duration: "25 seconds" }[q.fills]
  }`),
].join("\n");
const resolved = heuristics.parseBrief(answeredBrief);
assert.equal(resolved.structured_brief.audience, "urban runners");
assert.equal(resolved.structured_brief.platform, "Instagram Reels");
assert.equal(resolved.structured_brief.duration_seconds, 25);
assert.deepEqual(resolved.clarifying_questions, [], "answering closes every question");

// "a teaser for the new running shoe" names the product, not the audience.
// Guessing here is worse than admitting the brief did not say, because a wrong
// guess also suppresses the clarifying question.
assert.equal(sparse.structured_brief.audience, "Not stated in the brief");
assert.ok(
  sparse.clarifying_questions.some((q) => q.id === "question_audience"),
  "an unstated audience is asked about rather than invented",
);

// But "for <people>" is a real audience signal.
assert.equal(
  heuristics.parseBrief("A 20-second spot for home baristas on TikTok.").structured_brief.audience,
  "home baristas on TikTok",
);
assert.equal(
  heuristics.parseBrief("A brand film aimed at enterprise buyers.").structured_brief.audience,
  "enterprise buyers",
);

// Inline imperatives count as guardrails even without a Constraints: label.
const inline = heuristics.parseBrief(
  "Launch film for a watch brand.\nAvoid price claims.\nMust include the logo.",
);
assert.equal(inline.structured_brief.constraints.length, 2);

// --- output validation -------------------------------------------------------
assert.deepEqual(heuristics.validateIntakeOutput(labelled), []);
assert.ok(heuristics.validateIntakeOutput(null).length > 0);
assert.ok(heuristics.validateIntakeOutput({}).length > 0);
assert.ok(
  heuristics.validateIntakeOutput({
    structured_brief: { goal: "x", audience: "y", platform: "z", duration_seconds: "30", style: [], constraints: [], success_criteria: [] },
    clarifying_questions: [],
  }).some((e) => /duration_seconds/.test(e)),
  "a string duration is rejected",
);
assert.ok(
  heuristics.validateIntakeOutput({
    structured_brief: { goal: "x", audience: "y", platform: "z", duration_seconds: null, style: "cinematic", constraints: [], success_criteria: [] },
    clarifying_questions: [],
  }).some((e) => /style/.test(e)),
  "a non-array style is rejected",
);

// --- provider selection ------------------------------------------------------
assert.equal(createProvider(heuristics, {}).name, "local");
assert.equal(createProvider(heuristics, { GEMINI_API_KEY: "k" }).name, "gemini");
assert.equal(createProvider(heuristics, { ANTHROPIC_API_KEY: "k" }).name, "anthropic");
assert.equal(createProvider(heuristics, { STUDIOFLOW_LLM: "local", GEMINI_API_KEY: "k" }).name, "local");
assert.equal(
  createProvider(heuristics, { GEMINI_API_KEY: "k", GEMINI_MODEL: "custom-model" }).model,
  "custom-model",
);
assert.throws(() => createProvider(heuristics, { STUDIOFLOW_LLM: "gemini" }), /requires GEMINI_API_KEY/);

assert.deepEqual(parseJsonPayload('```json\n{"a":1}\n```', "test"), { a: 1 });
assert.deepEqual(parseJsonPayload('{"a":1}', "test"), { a: 1 });
assert.throws(() => parseJsonPayload("not json", "test"), /did not return valid JSON/);

// --- the agent ---------------------------------------------------------------
assert.ok(buildUserPrompt("hello").includes("hello"));
assert.ok(buildUserPrompt("hello").includes("structured_brief"));

const runAgent = (briefText, provider) =>
  runIntakeAgent({ briefText, traceId: "t1" }, { provider: provider || createLocalProvider(heuristics), heuristics });

(async () => {
  const result = await runAgent(demo.brief.text);
  assert.equal(result.agent_id, "intake_agent");
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "local");
  assert.equal(result.degraded, false);
  assert.ok(result.summary.includes("Instagram Reels"));
  assert.ok(Array.isArray(result.artifact.fields));
  // The validator checks the agent's full contract shape; the artifact holds the
  // structured brief while the questions stay at the top level of the response.
  assert.deepEqual(
    heuristics.validateIntakeOutput({
      structured_brief: result.artifact.structured_brief,
      clarifying_questions: result.clarifying_questions,
    }),
    [],
  );

  await assert.rejects(() => runAgent("   "), /requires a brief/);

  // A provider that throws must degrade rather than fail the run.
  const brokenProvider = {
    name: "gemini",
    async generateJson() {
      throw new Error("network down");
    },
  };
  const degraded = await runAgent(demo.brief.text, brokenProvider);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.provider, "local");
  assert.match(degraded.degraded_reason, /network down/);
  assert.match(degraded.audit_message, /fell back to the keyless parser/);
  assert.equal(degraded.status, "completed", "a degraded intake still completes");

  // A provider returning well-formed JSON that violates the contract must also
  // degrade rather than let bad data become an artifact.
  const schemaViolator = {
    name: "gemini",
    async generateJson() {
      return { structured_brief: { goal: 42 }, clarifying_questions: "nope" };
    },
  };
  const rejected = await runAgent(demo.brief.text, schemaViolator);
  assert.equal(rejected.degraded, true);
  assert.match(rejected.degraded_reason, /schema validation failed/);

  // --- the run carries the agent's output --------------------------------------
  const briefText =
    "Goal: A 15-second teaser for a coffee grinder.\nAudience: home baristas\nPlatform: TikTok";
  const store = createRunStore();
  const queued = store.save(createQueuedRun(demo, briefText));
  await executeRun(queued.trace_id, {
    store,
    demo,
    agentDeps: {
      provider: createLocalProvider(heuristics),
      intakeHeuristics: heuristics,
      production,
    },
    stepDelayMs: 0,
  });
  const run = store.get(queued.trace_id);

  assert.equal(run.brief.parsed_by, "local");
  assert.equal(run.brief.structured_brief.platform, "TikTok");
  assert.ok(
    run.brief.structured_fields.some(([label, value]) => label === "Platform" && value === "TikTok"),
    "the run's brief chips come from the agent",
  );
  assert.ok(
    !JSON.stringify(run.brief.structured_fields).includes("Instagram"),
    "the scripted brief no longer overrides the agent",
  );
  assert.equal(
    run.artifacts.find((artifact) => artifact.type === "intake").generated_by,
    "local",
  );
  assert.ok(
    run.artifacts.find((artifact) => artifact.type === "intake").summary.includes("TikTok"),
  );
  assert.equal(
    run.artifacts.find((artifact) => artifact.type === "shots").generated_by,
    "derived",
    "downstream artifacts are generated too, and say how",
  );
  assert.ok(run.audit_events.some((event) => /Intake Agent \(local\)/.test(event.message)));

  // A queued run has no brief fields yet; they appear only once intake completes.
  const pending = createQueuedRun(demo, "anything");
  assert.equal(pending.brief.parsed_by, null);
  assert.equal(pending.brief.structured_fields, null);
  assert.deepEqual(view.normalizeApiRun(pending, demo).briefFields, null);

  // The view model must surface the run's fields.
  const normalized = view.normalizeApiRun(run, demo);
  assert.ok(
    normalized.briefFields.some(([label, value]) => label === "Platform" && value === "TikTok"),
  );
  assert.equal(normalized.parsedBy, "local");

  console.log("intake agent test passed");
})();
