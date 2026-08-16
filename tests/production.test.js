const assert = require("assert");
const path = require("path");
const { createLocalProvider } = require("../lib/llm");
const {
  createQueuedRun,
  createRunStore,
  executeRun,
  loadDemoData,
  loadIntakeHeuristics,
  loadProductionHeuristics,
} = require("../lib/workflow");

const rootDir = path.join(__dirname, "..");
const intakeHeuristics = loadIntakeHeuristics(rootDir);
const production = loadProductionHeuristics(rootDir);
const demo = loadDemoData(rootDir);
const deps = { provider: createLocalProvider(intakeHeuristics), intakeHeuristics, production };

// --- shot list ---------------------------------------------------------------
const brief = intakeHeuristics.parseBrief(demo.brief.text).structured_brief;
const shotList = production.buildShotList(brief);

assert.equal(shotList.duration_seconds, 30);
assert.equal(shotList.aspect_ratio, "9:16 vertical", "Instagram Reels is vertical");
assert.ok(shotList.shots.length >= 5);
assert.equal(shotList.shots[0].start_seconds, 0, "the first shot starts at zero");
assert.equal(
  shotList.shots.at(-1).end_seconds,
  30,
  "timings fill the runtime exactly",
);
shotList.shots.forEach((shot, index) => {
  if (index === 0) return;
  assert.equal(
    shot.start_seconds,
    shotList.shots[index - 1].end_seconds,
    "shots are contiguous with no gap or overlap",
  );
});
assert.deepEqual(production.validateShotList(shotList), []);

// Timings must fill the runtime exactly at every duration, including runtimes
// shorter than the beat template, where beats have to be dropped instead of
// squeezed below a second.
for (const duration of [1, 2, 3, 5, 6, 7, 8, 11, 15, 29, 45, 90, 120, 300, 601]) {
  const list = production.buildShotList({ ...brief, duration_seconds: duration });
  assert.equal(list.shots.at(-1).end_seconds, duration, `timings fill ${duration}s exactly`);
  assert.equal(list.shots[0].start_seconds, 0, `${duration}s starts at zero`);
  assert.ok(
    list.shots.every((shot) => shot.end_seconds > shot.start_seconds),
    `no zero-length shot at ${duration}s`,
  );
  assert.ok(
    list.shots.some((shot) => shot.is_hero),
    `the subject reveal survives at ${duration}s`,
  );
  assert.deepEqual(production.validateShotList(list), [], `${duration}s validates`);
}

// The subject comes from the brief, not from the bundled scenario.
const arcticBrief = intakeHeuristics.parseBrief(
  "Goal: A 90-second documentary about Arctic ice cores.\nAudience: research scientists\nPlatform: YouTube",
).structured_brief;
const arcticShots = production.buildShotList(arcticBrief);
assert.match(arcticShots.subject, /Arctic ice cores/i);
assert.equal(arcticShots.aspect_ratio, "16:9 horizontal", "YouTube is horizontal");
assert.ok(!JSON.stringify(arcticShots).includes("Tokyo"));

// --- critic findings are derived, not fixed ----------------------------------
const findings = production.reviewShotList(shotList, brief, []);
assert.ok(
  findings.some((finding) => finding.id === "hero-window"),
  'the bundled brief asks for the product in the first 5 seconds, and the default structure misses it',
);
assert.deepEqual(production.validateFindings(findings), []);
assert.ok(
  findings.every((finding) => finding.target_task_ids.length > 0),
  "every finding names the tasks that must rerun",
);

// Enforcing the constraint must clear the finding it came from.
const heroFinding = findings.find((finding) => finding.id === "hero-window");
const fixedShots = production.buildShotList(brief, heroFinding.enforce);
assert.equal(fixedShots.shots[0].is_hero, true, "the subject reveal moves to the front");
assert.ok(
  !production.reviewShotList(fixedShots, brief, []).some((f) => f.id === "hero-window"),
  "the finding does not survive its own fix",
);

// A brief with no constraints produces no constraint findings.
const looseBrief = intakeHeuristics.parseBrief(
  "Goal: A 20-second teaser for home baristas.\nAudience: home baristas\nPlatform: TikTok\nStyle: vibrant",
).structured_brief;
assert.deepEqual(
  production.reviewShotList(production.buildShotList(looseBrief), looseBrief, []),
  [],
  "nothing is invented when the brief states no constraints",
);

// Unstated duration and style are reported honestly.
const vagueBrief = intakeHeuristics.parseBrief("A film for home baristas.").structured_brief;
const vagueFindings = production.reviewShotList(
  production.buildShotList(vagueBrief),
  vagueBrief,
  [{ question: "How long?" }],
);
assert.ok(vagueFindings.some((f) => f.id === "assumed-duration"));
assert.ok(vagueFindings.some((f) => f.id === "undefined-style"));
assert.ok(vagueFindings.some((f) => f.id === "open-questions"));

// --- assets and prompts derive from the shots --------------------------------
const manifest = production.buildAssetManifest(shotList, brief);
assert.ok(manifest.assets.length >= 4);
assert.ok(manifest.assets.some((asset) => asset.name.includes(shotList.subject)));

const promptPack = production.buildPromptPack(shotList, brief);
assert.equal(promptPack.prompts.length, shotList.shots.length, "one prompt per shot");
assert.ok(
  promptPack.shared_negative_prompt.length > 0,
  '"avoid health claims" becomes a negative prompt',
);
assert.ok(promptPack.prompts.every((prompt) => prompt.prompt.includes(shotList.aspect_ratio)));

// --- constraint checks the Critic performs -----------------------------------
const findingIds = (briefText, withPrompts = true) => {
  const b = intakeHeuristics.parseBrief(briefText).structured_brief;
  const s = production.buildShotList(b);
  return production
    .reviewShotList(s, b, [], withPrompts ? production.buildPromptPack(s, b) : null)
    .map((f) => f.id);
};

// A prohibition the prompt pack failed to encode reaches the generator as nothing
// at all, so the Critic has to catch it. "no music" is picked up by buildPromptPack;
// "without music" is phrased differently and is not.
const covered = findingIds(
  "Goal: A 30-second film about a kettle.\nAudience: home cooks\nPlatform: YouTube\nStyle: warm\nConstraints: no music",
);
assert.ok(
  !covered.some((id) => id.startsWith("uncovered-prohibition")),
  '"no music" is encoded as a negative prompt, so nothing is flagged',
);

const uncovered = findingIds(
  "Goal: A 30-second film about a kettle.\nAudience: home cooks\nPlatform: YouTube\nStyle: warm\nConstraints: must not include music",
);
assert.ok(
  uncovered.some((id) => id.startsWith("uncovered-prohibition")),
  '"must not include music" is a prohibition the prompt pack silently dropped',
);

// Something the brief requires that no shot depicts.
const missingElement = findingIds(
  "Goal: A 30-second film about a kettle.\nAudience: home cooks\nPlatform: YouTube\nStyle: warm\nConstraints: must include the safety certification badge",
);
assert.ok(
  missingElement.some((id) => id.startsWith("unmet-requirement")),
  "a required element absent from every shot is reported",
);

// Pacing, in both directions.
assert.ok(
  findingIds(
    "Goal: A 5-minute film about a kettle.\nAudience: home cooks\nPlatform: YouTube\nStyle: warm",
  ).includes("slow-pacing"),
);
assert.ok(
  findingIds(
    "Goal: A 6-second film about a kettle.\nAudience: home cooks\nPlatform: YouTube\nStyle: warm",
  ).includes("fast-pacing"),
);

// An aspect ratio the brief asks for that the platform contradicts.
assert.ok(
  findingIds(
    "Goal: A 30-second film about a kettle.\nAudience: home cooks\nPlatform: YouTube\nStyle: warm\nConstraints: deliver in a vertical 9:16 frame",
  ).includes("aspect-conflict"),
  "YouTube planned as 16:9 conflicts with a vertical requirement",
);
assert.ok(
  !findingIds(
    "Goal: A 30-second film about a kettle.\nAudience: home cooks\nPlatform: TikTok\nStyle: warm\nConstraints: deliver in a vertical 9:16 frame",
  ).includes("aspect-conflict"),
  "TikTok is already vertical, so there is no conflict",
);

(async () => {
  // --- a full run through the live path --------------------------------------
  const store = createRunStore();
  const queued = store.save(createQueuedRun(demo, demo.brief.text));
  await executeRun(queued.trace_id, { store, demo, agentDeps: deps, stepDelayMs: 0 });
  const run = store.get(queued.trace_id);

  assert.equal(run.brief.parsed_by, "local");
  assert.equal(run.artifacts.length, 6);
  assert.ok(
    run.artifacts.every((artifact) => artifact.content_markdown),
    "every artifact carries generated content",
  );
  assert.equal(
    run.artifacts.find((a) => a.type === "shots").content_markdown.split("\n").length,
    shotList.shots.length,
  );
  assert.equal(run.artifacts.find((a) => a.type === "intake").generated_by, "local");
  assert.equal(run.artifacts.find((a) => a.type === "shots").generated_by, "derived");
  assert.match(run.packet_markdown, /## Shot List/);
  assert.ok(
    !JSON.stringify(run.artifacts).includes("Tokyo Night Market"),
    "no scripted copy survives in the artifacts",
  );

  // --- a clean brief needs no human review -----------------------------------
  const cleanStore = createRunStore();
  const clean = cleanStore.save(
    createQueuedRun(
      demo,
      "Goal: A 20-second teaser for a coffee grinder.\nAudience: home baristas\nPlatform: TikTok\nStyle: vibrant",
    ),
  );
  await executeRun(clean.trace_id, {
    store: cleanStore,
    demo,
    agentDeps: deps,
    stepDelayMs: 0,
  });
  const cleanRun = cleanStore.get(clean.trace_id);

  assert.deepEqual(cleanRun.review_items, [], "nothing is invented for a compliant brief");
  assert.equal(cleanRun.project.status, "approved", "no findings means no review gate");
  assert.equal(cleanRun.packet_ready, true);
  assert.equal(cleanRun.tasks.find((task) => task.id === "critic").state, "approved");

  console.log("production agents test passed");
})();
