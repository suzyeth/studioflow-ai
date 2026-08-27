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

You EXTRACT. You do not INFER. This is the whole job, and the difference matters more
than anything else you do: a field you filled in from a plausible reading is worse than
a field you left empty, because the empty one gets asked about and the plausible one
gets built on. Nothing downstream can tell the two apart.

Ask clarifying questions only when the missing information would block planning.
Return only valid JSON matching the requested schema.`;

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
    {
      "id": "question_audience",
      "fills": "Audience",
      "question": "string",
      "why_it_matters": "string"
    }
  ]
}`;

// An answer is folded back into the brief as "<fills>: <answer>" so the same parser
// reads it the way it read the original prose. A question without a usable `fills`
// cannot be answered — the clarification loop silently breaks — which is why this list
// is closed rather than free text.
const FILLABLE_FIELDS = ["Goal", "Audience", "Platform", "Duration", "Style", "Constraints"];

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
    "RULES — the first one is the one that matters:",
    "",
    "1. Only record what the brief actually states. If you are reasoning from context",
    "   to fill a field, stop: that field is not stated. Write the exact string",
    '   "Not stated in the brief" and raise a clarifying question for it instead.',
    "",
    "2. An audience is a description of PEOPLE — who watches this. A market, a",
    "   place, a product category, or a distribution channel is not an audience.",
    "   If the brief names only a market or a place, it has no audience: leave the",
    "   field unstated and ask.",
    "",
    "   But if the brief states an audience ANYWHERE, including on a line labelled",
    "   \"Audience:\", that IS the audience — record it exactly as written and do",
    "   not ask about it again. A brief you have seen before may come back with",
    "   answers appended; read what is in front of you, not what you decided last",
    "   time.",
    "",
    "3. Use null for duration_seconds if the brief does not state a duration.",
    "",
    "4. Copy each constraint in the brief's own words. Do not merge, split, reword",
    "   or add to them — they are checked verbatim against the artifacts later.",
    "",
    `5. Every clarifying question must carry "fills", exactly one of: ${FILLABLE_FIELDS.join(", ")}.`,
    "   It names the field the answer belongs to. A question without it cannot be",
    "   answered, because the answer is folded back into the brief under that label.",
    "",
    "6. Ask only about what physically blocks building a production plan: who is",
    "   in it, where it runs, how long it is. The test is simple — if you can",
    "   produce a shot list without the answer, do not ask.",
    "",
    "   That rules out budget, timeline, approvals, success criteria, KPIs,",
    "   performance targets, brand guidelines and stakeholders. None of them",
    "   stop a plan being made. success_criteria in the schema is derived from",
    "   what the brief already states — it is never a reason to ask a question.",
    "",
    "   Asking nothing is a valid and common answer. A brief that states its",
    "   audience, platform and duration needs no questions at all.",
  ].join("\n");
}

// The keyless parser strips trailing punctuation from the fields it reads; a model
// answering the same schema keeps it, so a goal ending in a full stop rendered as
// "…night market.. Audience:" in the summary line the UI shows. Normalising here
// rather than in each consumer keeps both providers producing the same shape, which
// is the point of validating them against one contract.
function normalizeBrief(brief) {
  const trim = (value) =>
    typeof value === "string" ? value.trim().replace(/[.;,]+$/, "") : value;

  return {
    ...brief,
    goal: trim(brief.goal),
    audience: trim(brief.audience),
    platform: trim(brief.platform),
    style: (brief.style || []).map(trim).filter(Boolean),
    constraints: (brief.constraints || []).map(trim).filter(Boolean),
    success_criteria: (brief.success_criteria || []).map(trim).filter(Boolean),
  };
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

  const structuredBrief = normalizeBrief(output.structured_brief);
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
