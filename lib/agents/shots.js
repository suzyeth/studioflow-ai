// Shot Agent — the second agent that talks to a model.
//
// The division of labour is deliberately narrow: the deterministic skeleton
// from buildShotList keeps the timings, order, count, ids, and hero/CTA flags,
// and the model writes ONLY the shot descriptions over it. Two invariants
// depend on that narrowness:
//
//   1. The first pass must be able to be wrong. The Shot Agent does not see
//      the brief's constraints — the Critic checks the result against them and
//      a human reviews what it finds. Handing the model the constraints would
//      make the review gate decorative (see CLAUDE.md, "The revision loop").
//   2. The timeline cannot be corrupted. The model returns strings keyed by
//      existing shot ids; it has no way to move a timing, drop a shot, or
//      invent one. The Critic's timeline check stays as the guard for the day
//      the model's role grows.
//
// Same degradation rules as the Intake Agent: any model failure — network,
// malformed JSON, schema violation, missing or extra ids — keeps the
// skeleton's own descriptions and reports why. A model failure must never
// fail a run.

const SYSTEM_PROMPT = `You are the Shot Agent for an enterprise creative production workflow.

You write shot DESCRIPTIONS over a fixed shot skeleton. The skeleton's timings,
order, count, ids, and flags are already decided and are not yours to change.

You deliberately do not see the brief's constraints. A separate Critic checks
your output against them, and a human reviews what it finds. Do not guess at
constraints; describe the best film you can.

Return only valid JSON matching the requested schema.`;

function buildUserPrompt(shotList, structuredBrief) {
  const skeleton = shotList.shots
    .map((shot) => {
      const flags = [shot.is_hero ? "HERO — the subject reveal" : "", shot.is_cta ? "CTA — explicit call to action" : ""]
        .filter(Boolean)
        .join(", ");
      return `- ${shot.id} (${shot.timecode}) purpose: ${shot.purpose}${flags ? ` [${flags}]` : ""}`;
    })
    .join("\n");

  return [
    "Film context:",
    `- Subject: ${shotList.subject}`,
    `- Style: ${shotList.style}`,
    `- Audience: ${structuredBrief.audience}`,
    `- Platform: ${structuredBrief.platform}   Frame: ${shotList.aspect_ratio}   Runtime: ${shotList.duration_seconds}s`,
    "",
    "Shot skeleton (fixed — do not change it):",
    skeleton,
    "",
    "Return only JSON matching this schema:",
    '{ "descriptions": { "<shot id>": "string" } }',
    "",
    "RULES:",
    "1. One entry per skeleton shot id, exactly those ids — no additions, no omissions.",
    "2. Each description is ONE concrete, filmable sentence in present tense naming",
    "   what the camera sees. No timings — the skeleton owns them.",
    `3. A HERO shot presents ${shotList.subject} clearly and unobstructed.`,
    "4. A CTA shot names the explicit on-screen call to action.",
  ].join("\n");
}

// The whole schema check for the narrow contract: exactly the skeleton's ids,
// each mapping to a usable one-liner. Anything else keeps the skeleton.
function validateDescriptions(output, shotList) {
  const errors = [];
  const descriptions = output && typeof output === "object" ? output.descriptions : null;

  if (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions)) {
    return ["descriptions must be an object keyed by shot id"];
  }

  const expected = new Set(shotList.shots.map((shot) => shot.id));
  for (const id of expected) {
    const value = descriptions[id];
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`descriptions.${id} must be a non-empty string`);
    } else if (value.length > 400) {
      errors.push(`descriptions.${id} is not a one-liner (${value.length} chars)`);
    }
  }
  for (const id of Object.keys(descriptions)) {
    if (!expected.has(id)) {
      errors.push(`descriptions.${id} does not match any skeleton shot`);
    }
  }
  return errors;
}

// buildPromptPack renders "<description>. Style: ..." — a description that
// keeps its own trailing period would render "..". Same normalisation the
// Intake Agent applies to model-filled fields.
function stripTrailing(text) {
  return text.trim().replace(/[.;,\s]+$/, "");
}

async function runShotAgent({ structuredBrief, enforce = {} }, { provider, production }) {
  const skeleton = production.buildShotList(structuredBrief, enforce);

  const disabled =
    provider.name === "local" || process.env.STUDIOFLOW_SHOT_AGENT === "off";
  if (disabled) {
    return {
      shotList: skeleton,
      provider: "derived",
      degraded: false,
      degraded_reason: null,
      audit_message: `Shot Agent generated ${skeleton.shots.length} timed shots for ${skeleton.duration_seconds}s.`,
    };
  }

  let descriptions = null;
  let degradedReason = null;

  try {
    const output = await provider.generateJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(skeleton, structuredBrief),
    });

    const errors = validateDescriptions(output, skeleton);
    if (errors.length > 0) {
      throw new Error(`schema validation failed: ${errors.join("; ")}`);
    }
    descriptions = output.descriptions;
  } catch (error) {
    degradedReason = error.message;
  }

  if (degradedReason) {
    return {
      shotList: skeleton,
      provider: "derived",
      degraded: true,
      degraded_reason: degradedReason,
      audit_message: `Shot Agent fell back to the template descriptions (${provider.name} unavailable: ${degradedReason}).`,
    };
  }

  const shotList = {
    ...skeleton,
    shots: skeleton.shots.map((shot) => ({
      ...shot,
      description: stripTrailing(descriptions[shot.id]),
    })),
  };

  return {
    shotList,
    provider: provider.name,
    degraded: false,
    degraded_reason: null,
    audit_message: `Shot Agent (${provider.name}) wrote ${shotList.shots.length} shot descriptions over the deterministic timeline.`,
  };
}

module.exports = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  runShotAgent,
  validateDescriptions,
};
