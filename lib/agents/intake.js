// Intake Agent — docs/AGENT_CONTRACTS.md
//
// Converts a rough creative brief into a structured brief and asks clarifying
// questions only when the missing information would block planning.
//
// Two rules shape this file:
//   1. Model output is validated against the contract before it is allowed to
//      become an artifact.
//   2. The workflow must always produce a run. Any model failure — network,
//      malformed JSON, schema violation — degrades to the keyless parser and is
//      reported in the response rather than thrown at the user.

const SYSTEM_PROMPT = `You are the Intake Agent for an enterprise creative production workflow.
Extract concrete requirements from the raw brief. Ask clarifying questions only
when missing information would block planning. Return only valid JSON matching
the requested schema.`;

const OUTPUT_SCHEMA = `{
  "structured_brief": {
    "goal": "string",
    "audience": "string",
    "platform": "string",
    "duration_seconds": 30,
    "style": ["string"],
    "constraints": ["string"],
    "success_criteria": ["string"]
  },
  "clarifying_questions": [
    { "id": "question_budget", "question": "string", "why_it_matters": "string" }
  ]
}`;

function buildUserPrompt(briefText) {
  return [
    "Raw creative brief:",
    "---",
    briefText,
    "---",
    "",
    "Return only JSON matching this schema:",
    OUTPUT_SCHEMA,
    "",
    'Use null for duration_seconds if the brief does not state a duration.',
    'Use "Not stated in the brief" for any string field the brief does not state.',
    "Do not invent requirements that are not in the brief.",
  ].join("\n");
}

async function runIntakeAgent({ briefText, traceId, taskId = "task_intake" }, { provider, heuristics }) {
  const trimmed = String(briefText || "").trim();

  if (!trimmed) {
    throw new Error("Intake Agent requires a brief");
  }

  let output = null;
  let degradedReason = null;

  try {
    output = await provider.generateJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(trimmed),
      briefText: trimmed,
    });

    const errors = heuristics.validateIntakeOutput(output);
    if (errors.length > 0) {
      throw new Error(`schema validation failed: ${errors.join("; ")}`);
    }
  } catch (error) {
    degradedReason = error.message;
    output = heuristics.parseBrief(trimmed);
  }

  const structuredBrief = output.structured_brief;
  const questions = output.clarifying_questions || [];

  return {
    agent_id: "intake_agent",
    task_id: taskId,
    status: "completed",
    summary: heuristics.summarize(structuredBrief, questions.length),
    artifact: {
      type: "structured_brief",
      structured_brief: structuredBrief,
      fields: heuristics.toFields(structuredBrief),
    },
    clarifying_questions: questions,
    review_items: [],
    audit_message: degradedReason
      ? `Intake Agent fell back to the keyless parser (${provider.name} unavailable: ${degradedReason}).`
      : `Intake Agent (${provider.name}) converted the raw brief into a structured brief.`,
    provider: degradedReason ? "local" : provider.name,
    degraded: Boolean(degradedReason),
    degraded_reason: degradedReason,
    trace_id: traceId,
  };
}

module.exports = {
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  runIntakeAgent,
};
