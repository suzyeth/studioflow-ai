// Render Critic — closes the constraint loop on the rendered clip.
//
// The plan-level Critic checks that the packet honours the brief before any
// video exists. Once Veo has rendered the hero shot, this agent asks the last
// question: does the CLIP honour the brief? Same constraints, same discipline,
// one new capability — the model watches the video.
//
// Three-state verdicts on purpose: pass / fail / cannot_tell. A model that is
// not sure must say so — "a wrong finding costs more than a missed one" applies
// to a rendered frame exactly as it applies to a shot list. And the audit is
// advisory: it annotates the clip for the human, it never deletes or blocks it.
//
// Failure semantics mirror every other model call in this project: any failure
// — no multimodal provider, network, schema violation — reports the audit as
// skipped with the reason. It never invents verdicts and never fails the run.

const SYSTEM_PROMPT = `You are the Render Critic for an enterprise creative production workflow.

You watch a rendered clip and judge it against the checks you are given — nothing
else. You do not review style or taste; you verify facts a camera can show.

For each check, answer:
- "pass" only if the clip clearly satisfies it,
- "fail" only if the clip clearly violates it,
- "cannot_tell" whenever you are not sure. Saying cannot_tell is correct and
  expected; a confident wrong verdict is the worst answer you can give.

Return only valid JSON matching the requested schema.`;

// The checks are the brief's own constraints plus one the product always cares
// about: the subject has to actually be in the shot the packet calls the hero.
function buildChecks(constraints, subject) {
  return [
    `The subject — ${subject} — appears clearly in the clip`,
    ...constraints,
  ];
}

function buildUserPrompt(checks) {
  return [
    "Watch the attached clip, then judge each check below against what is",
    "actually visible or audible in it.",
    "",
    "Checks:",
    ...checks.map((check, index) => `${index + 1}. ${check}`),
    "",
    "Return only JSON matching this schema:",
    '{ "verdicts": [ { "check": "string — the check, echoed verbatim", "verdict": "pass | fail | cannot_tell", "evidence": "one sentence naming what you saw" } ] }',
    "",
    "RULES:",
    `1. Exactly ${checks.length} verdict(s), in the order given, echoing each check verbatim.`,
    "2. Evidence describes the clip, not the check. \"The can appears at the start,",
    "   centered and unobstructed\" is evidence; \"the constraint is satisfied\" is not.",
    "3. A check about something a clip cannot show (delivery format, platform,",
    "   scheduling) is cannot_tell — do not guess.",
  ].join("\n");
}

const VERDICTS = new Set(["pass", "fail", "cannot_tell"]);

function validateVerdicts(output, checks) {
  const verdicts = output && typeof output === "object" ? output.verdicts : null;
  if (!Array.isArray(verdicts)) return ["verdicts must be an array"];

  const errors = [];
  if (verdicts.length !== checks.length) {
    errors.push(`expected ${checks.length} verdict(s), got ${verdicts.length}`);
  }
  verdicts.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`verdicts[${index}] must be an object`);
      return;
    }
    if (!VERDICTS.has(entry.verdict)) {
      errors.push(`verdicts[${index}].verdict must be pass, fail, or cannot_tell`);
    }
    if (typeof entry.evidence !== "string" || !entry.evidence.trim()) {
      errors.push(`verdicts[${index}].evidence must be a non-empty string`);
    }
  });
  return errors;
}

async function runRenderCritic({ video, mimeType, constraints, subject }, { provider }) {
  if (typeof provider.generateJsonFromVideo !== "function") {
    return {
      status: "skipped",
      reason: `${provider.name} cannot watch video, so the clip was not audited`,
    };
  }

  const checks = buildChecks(constraints || [], subject || "the subject");

  try {
    const output = await provider.generateJsonFromVideo({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(checks),
      video,
      mimeType,
    });

    const errors = validateVerdicts(output, checks);
    if (errors.length > 0) {
      throw new Error(`schema validation failed: ${errors.join("; ")}`);
    }

    // The model echoes checks, but the authoritative text is ours — a paraphrase
    // must not end up in front of a human as if it were the brief's words.
    const verdicts = output.verdicts.map((entry, index) => ({
      check: checks[index],
      verdict: entry.verdict,
      evidence: entry.evidence.trim(),
    }));

    return { status: "done", provider: provider.name, verdicts };
  } catch (error) {
    return { status: "skipped", reason: error.message };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  buildChecks,
  buildUserPrompt,
  runRenderCritic,
  validateVerdicts,
};
