// The specialist agents, one task at a time.
//
// `runTask` is the ONLY place an artifact is generated. The worker calls it to
// execute a run, and a revision calls it again through `rerunProduction`. Adding
// a second generation path is how the two drift apart.
//
// Intake and Shots talk to a model provider; the rest are deterministic
// generators over the structured brief. They share the same response envelope
// so swapping a provider in later stays a per-agent change.

const { runIntakeAgent } = require("./intake");
const { runShotAgent } = require("./shots");

// Execution order. Each entry is one queued unit of work, which is what lets the
// task graph move through running -> completed instead of appearing complete.
const TASK_SEQUENCE = ["intake", "planning", "shots", "assets", "prompts", "critic"];

function envelope({ agentId, taskId, summary, artifact, contentMarkdown, generatedBy, auditMessage }) {
  return {
    agent_id: agentId,
    task_id: taskId,
    status: "completed",
    summary,
    artifact,
    content_markdown: contentMarkdown,
    generated_by: generatedBy,
    audit_message: auditMessage,
  };
}

// Re-runs the production chain with a reviewer's constraint applied. Intake is
// skipped: the brief has not changed.
//
// The whole chain reruns even when only one artifact is targeted, because assets
// and prompts are derived from shots — regenerating shots alone would leave them
// describing a shot list that no longer exists.
async function rerunProduction({ structuredBrief, clarifyingQuestions, enforce }, deps) {
  const ctx = { structuredBrief, clarifyingQuestions, enforce };
  const agents = {};

  for (const taskId of TASK_SEQUENCE) {
    if (taskId === "intake") continue;
    agents[taskId] = await runTask(taskId, ctx, deps);
  }

  return { agents, ctx };
}

// Runs one task and returns its agent response. `ctx` accumulates what later
// tasks depend on, so the dependency chain is explicit rather than implied.
async function runTask(taskId, ctx, { provider, intakeHeuristics, production }) {
  if (taskId === "intake") {
    const intake = await runIntakeAgent(
      { briefText: ctx.briefText },
      { provider, heuristics: intakeHeuristics },
    );
    ctx.structuredBrief = intake.artifact.structured_brief;
    ctx.clarifyingQuestions = intake.clarifying_questions;
    ctx.provider = intake.provider;
    ctx.degraded = intake.degraded;
    return { ...intake, content_markdown: intake.summary, generated_by: intake.provider };
  }

  if (taskId === "planning") {
    ctx.plan = production.buildPlan(ctx.structuredBrief, ctx.enforce);
    return envelope({
      agentId: "planning_agent",
      taskId: "task_planning",
      summary: production.summarizePlan(ctx.plan),
      artifact: ctx.plan,
      contentMarkdown: production.planMarkdown(ctx.plan),
      generatedBy: "derived",
      auditMessage: `Planning Agent derived a ${ctx.plan.beats.length}-beat workflow plan from the structured brief.`,
    });
  }

  if (taskId === "shots") {
    // The model writes descriptions over the deterministic skeleton; timings,
    // order, and flags cannot move (see lib/agents/shots.js). A model failure
    // keeps the skeleton and says so in the audit trail.
    const shots = await runShotAgent(
      { structuredBrief: ctx.structuredBrief, enforce: ctx.enforce },
      { provider, production },
    );
    ctx.shotList = shots.shotList;
    const errors = production.validateShotList(ctx.shotList);
    if (errors.length > 0) {
      throw new Error(`Shot Agent produced an invalid shot list: ${errors.join("; ")}`);
    }
    return envelope({
      agentId: "shot_agent",
      taskId: "task_shots",
      summary: production.summarizeShotList(ctx.shotList),
      artifact: ctx.shotList,
      contentMarkdown: production.shotListMarkdown(ctx.shotList),
      generatedBy: shots.provider,
      auditMessage: shots.audit_message,
    });
  }

  if (taskId === "assets") {
    ctx.manifest = production.buildAssetManifest(ctx.shotList, ctx.structuredBrief);
    return envelope({
      agentId: "asset_agent",
      taskId: "task_assets",
      summary: production.summarizeAssets(ctx.manifest),
      artifact: ctx.manifest,
      contentMarkdown: ctx.manifest.assets.map((asset) => `- ${asset.name}`).join("\n"),
      generatedBy: "derived",
      auditMessage: `Asset Agent extracted ${ctx.manifest.assets.length} asset groups from the shot list.`,
    });
  }

  if (taskId === "prompts") {
    ctx.promptPack = production.buildPromptPack(ctx.shotList, ctx.structuredBrief);
    return envelope({
      agentId: "prompt_agent",
      taskId: "task_prompts",
      summary: production.summarizePrompts(ctx.promptPack),
      artifact: ctx.promptPack,
      contentMarkdown: ctx.promptPack.prompts.map((prompt) => `- ${prompt.prompt}`).join("\n"),
      generatedBy: "derived",
      auditMessage: `Prompt Agent wrote ${ctx.promptPack.prompts.length} per-shot prompts.`,
    });
  }

  if (taskId === "critic") {
    ctx.findings = production.reviewShotList(
      ctx.shotList,
      ctx.structuredBrief,
      ctx.clarifyingQuestions,
      ctx.promptPack,
      ctx.manifest,
    );
    const errors = production.validateFindings(ctx.findings);
    if (errors.length > 0) {
      throw new Error(`Critic Agent produced invalid findings: ${errors.join("; ")}`);
    }
    ctx.packetMarkdown = production.packetMarkdown(ctx.structuredBrief, {
      shotList: ctx.shotList,
      manifest: ctx.manifest,
      promptPack: ctx.promptPack,
      findings: ctx.findings,
    });
    return envelope({
      agentId: "critic_agent",
      taskId: "task_critic",
      summary: production.summarizeFindings(ctx.findings),
      artifact: { findings: ctx.findings },
      contentMarkdown: ctx.findings
        .map((finding) => `- ${finding.title}: ${finding.body}`)
        .join("\n"),
      generatedBy: "derived",
      auditMessage:
        ctx.findings.length === 0
          ? "Critic Agent found no risks against the stated constraints."
          : `Critic Agent routed ${ctx.findings.length} finding(s) to human review.`,
    });
  }

  throw new Error(`Unknown task: ${taskId}`);
}

module.exports = {
  TASK_SEQUENCE,
  rerunProduction,
  runTask,
};
