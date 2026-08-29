// Render Critic — closes the constraint loop on video.
//
// The plan-level Critic checks that the packet honours the brief before any
// video exists. This agent asks the last question: does the FOOTAGE honour it?
// Same constraints, same discipline, one new capability — the model watches.
//
// It runs in two scopes, and the difference is the point:
//
//   scope "shot"     — one rendered shot out of a longer film. Most of the
//                      brief's constraints are NOT this clip's to answer, and
//                      judging them here produces false verdicts.
//   scope "delivery" — a delivered cut of the whole film. Every constraint is
//                      fair game, because this footage is the deliverable.
//
// The scoping exists because of two real false verdicts, one in each
// direction. Rendering the hero shot of a 30-second film and asking "does it
// include a clear CTA?" answered no — correctly, since the CTA lives at 0:26
// and the clip covers 0:10-0:15. The clip was blamed for the film's job.
// Worse the other way: "show the product in the first 5 seconds" answered
// PASS because the product appeared at 0:01 *of the clip*, while in the film
// that shot starts at 0:10. A clip does not carry the film's clock, so a
// verdict read off it is meaningless — that check belongs to the plan Critic,
// which has the timings and already fails it.
//
// Three-state verdicts on purpose: pass / fail / cannot_tell. A model that is
// not sure must say so — "a wrong finding costs more than a missed one"
// applies to a rendered frame exactly as it applies to a shot list. And the
// audit is advisory: it annotates footage for the human, never blocks it.
//
// Failure semantics mirror every other model call here: any failure — no
// multimodal provider, network, schema violation — reports the audit as
// skipped with the reason. It never invents verdicts and never fails a run.

const SYSTEM_PROMPT = `You are the Render Critic for an enterprise creative production workflow.

You watch footage and judge it against the checks you are given — nothing else.
You do not review style or taste; you verify facts a camera can show.

For each check, answer:
- "pass" only if the footage clearly satisfies it,
- "fail" only if the footage clearly violates it,
- "cannot_tell" whenever you are not sure. Saying cannot_tell is correct and
  expected; a confident wrong verdict is the worst answer you can give.

Return only valid JSON matching the requested schema.`;

// Constraint classes that decide scope. Deliberately the same phrasings the
// plan-level Critic recognises, so the two agents agree about what a
// constraint is even though they judge different things.
const PROHIBITION = /^(no|avoid|never|do not|don't)\b/i;
const PROHIBITION_LOOSE = /\b(without|must not|should not|cannot|excluding|free of)\b/i;
const CTA = /\bcta\b|call to action/i;
const TIMING_WINDOW = /\bfirst\s+\d+\s*seconds?\b/i;
const DELIVERY = /\b(deliver|delivery|export|upload|publish|aspect ratio|9:16|16:9)\b/i;

function isProhibition(constraint) {
  return PROHIBITION.test(constraint) || PROHIBITION_LOOSE.test(constraint);
}

// Splits the brief's constraints into what this footage can fairly answer for
// and what it cannot, with the reason. The out-of-scope list is reported, not
// hidden: "we did not judge this, and here is why" is information, whereas a
// silently dropped constraint looks like a constraint that passed.
function scopeConstraints(constraints, { scope, shot }) {
  const checks = [];
  const outOfScope = [];
  const skip = (constraint, reason) => outOfScope.push({ check: constraint, reason });

  for (const constraint of constraints) {
    if (scope === "delivery") {
      // The whole film is on screen; every constraint is answerable, and the
      // ones that are not visual at all resolve to cannot_tell honestly.
      checks.push(constraint);
      continue;
    }

    // A prohibition binds every frame — a forbidden element must not appear
    // in this shot regardless of which shot it is.
    if (isProhibition(constraint)) {
      checks.push(constraint);
      continue;
    }
    if (TIMING_WINDOW.test(constraint)) {
      skip(
        constraint,
        "this clip does not carry the film's clock — the plan Critic verifies timings",
      );
      continue;
    }
    if (CTA.test(constraint)) {
      if (shot && shot.is_cta) checks.push(constraint);
      else skip(constraint, "the call to action belongs to a different shot in the packet");
      continue;
    }
    if (DELIVERY.test(constraint)) {
      skip(constraint, "a delivery requirement, not something footage can show");
      continue;
    }
    skip(constraint, "a whole-film requirement — this clip is one shot of it");
  }

  return { checks, outOfScope };
}

// The subject-visibility check is the product's own, not the brief's: whatever
// else is true, the shot the packet calls the hero has to actually show the
// subject. On a delivered cut the same question applies to the film.
function buildChecks(constraints, subject, { scope = "shot", shot = null } = {}) {
  const { checks, outOfScope } = scopeConstraints(constraints || [], { scope, shot });
  const subjectCheck =
    scope === "delivery"
      ? `The subject — ${subject} — appears clearly in the film`
      : `The subject — ${subject} — appears clearly in the clip`;

  // Only the hero shot answers for the subject; another shot may legitimately
  // not contain it.
  const includeSubject = scope === "delivery" || !shot || shot.is_hero;
  if (!includeSubject) {
    outOfScope.push({
      check: subjectCheck,
      reason: "this is not the shot the packet designates as the subject reveal",
    });
  }

  return { checks: includeSubject ? [subjectCheck, ...checks] : checks, outOfScope };
}

function buildUserPrompt(checks, scope) {
  const noun = scope === "delivery" ? "delivered cut" : "clip";
  return [
    `Watch the attached ${noun}, then judge each check below against what is`,
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
    '2. Evidence describes the footage, not the check. "The can appears at the start,',
    '   centered and unobstructed" is evidence; "the constraint is satisfied" is not.',
    "3. Judge only what this footage shows. If answering would need something",
    "   outside the frame, that is cannot_tell — do not guess.",
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

async function runRenderCritic(
  { video, mimeType, constraints, subject, shot = null, scope = "shot" },
  { provider },
) {
  const { checks, outOfScope } = buildChecks(constraints, subject || "the subject", {
    scope,
    shot,
  });

  if (typeof provider.generateJsonFromVideo !== "function") {
    return {
      status: "skipped",
      scope,
      reason: `${provider.name} cannot watch video, so the footage was not audited`,
    };
  }

  // Every constraint was out of scope: there is nothing to ask a model, and
  // spending a paid multimodal call to be told so would be waste.
  if (checks.length === 0) {
    return {
      status: "done",
      scope,
      provider: provider.name,
      verdicts: [],
      out_of_scope: outOfScope,
    };
  }

  try {
    const output = await provider.generateJsonFromVideo({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(checks, scope),
      video,
      mimeType,
    });

    const errors = validateVerdicts(output, checks);
    if (errors.length > 0) {
      throw new Error(`schema validation failed: ${errors.join("; ")}`);
    }

    // The model echoes checks, but the authoritative text is ours — a
    // paraphrase must not reach a human as if it were the brief's words.
    const verdicts = output.verdicts.map((entry, index) => ({
      check: checks[index],
      verdict: entry.verdict,
      evidence: entry.evidence.trim(),
    }));

    return { status: "done", scope, provider: provider.name, verdicts, out_of_scope: outOfScope };
  } catch (error) {
    return { status: "skipped", scope, reason: error.message };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  buildChecks,
  buildUserPrompt,
  runRenderCritic,
  scopeConstraints,
  validateVerdicts,
};
