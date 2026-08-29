// Conformance Auditor — the delivered cut against the approved shot list.
//
// This is the question a producer actually asks when a cut comes back: is this
// the film we approved? Not "is it good" — that is taste, and taste is not
// something this product claims to judge — but "are the shots we signed off
// on actually in it, in that order, and is there anything in here nobody
// approved."
//
// It is the audit with the strongest evidence in the system, because the
// standard is not the model's opinion and not the brief's prose: it is the
// shot list a human approved, with ids, timecodes, and descriptions. The
// packet stops being only a deliverable and becomes the acceptance criteria.
//
// Deliberate limits, stated in the prompt and on screen:
//   - Frame-accurate cut detection is not expected of a model watching video.
//     Statuses are present / missing / uncertain, not edit-decision-list
//     precision, and "uncertain" is the correct answer whenever the match is
//     arguable.
//   - Timing is reported as observed, never as pass/fail. A cut that runs its
//     beats slightly long is a normal edit, not a violation.
//
// Runs only against a delivered cut. Asking it of a single rendered shot is
// meaningless — that clip IS one shot, so conformance would be trivially true.

const SYSTEM_PROMPT = `You are the Conformance Auditor for an enterprise creative production workflow.

You are given the shot list a human approved, and a delivered cut of the film.
Your only job is to report which approved shots you can actually find in the
cut, and whether the cut contains anything the shot list does not.

You are not reviewing quality, style, taste, or pacing. You are matching
content against a list.

Judge by what each shot DEPICTS, not by exact timing — an editor legitimately
trims and shifts beats. Report timing as what you observed, never as a verdict.

Use "uncertain" whenever a match is arguable. It is the correct answer far more
often than people expect, and a confident wrong match is the worst outcome.

Return only valid JSON matching the requested schema.`;

function buildUserPrompt(shotList) {
  const rows = shotList.shots.map(
    (shot) => `- ${shot.id} (${shot.timecode}, ${shot.purpose}): ${shot.description}`,
  );

  return [
    `Approved shot list for "${shotList.subject}" — ${shotList.shots.length} shots across ${shotList.duration_seconds}s, ${shotList.aspect_ratio}:`,
    ...rows,
    "",
    "Watch the attached delivered cut and match it against that list.",
    "",
    "Return only JSON matching this schema:",
    '{ "shots": [ { "shot_id": "string — an id from the list above", "status": "present | missing | uncertain", "observed": "one sentence: what you saw and roughly where, or why you could not find it" } ], "unplanned": [ { "observed": "one sentence describing footage that matches no approved shot", "where": "approximate timecode in the cut" } ] }',
    "",
    "RULES:",
    `1. Exactly ${shotList.shots.length} entries in "shots", one per id above, in the same order.`,
    '2. "present" means you can point at footage that depicts what the shot describes.',
    '3. "missing" means you watched the whole cut and that content is not in it.',
    '4. "uncertain" for anything arguable — a partial match, or a shot you think you',
    "   saw but could not distinguish from a neighbouring one.",
    '5. "unplanned" lists footage belonging to no approved shot. Return an empty',
    "   array when there is none — do not invent entries to look thorough.",
  ].join("\n");
}

const STATUSES = new Set(["present", "missing", "uncertain"]);

function validateConformance(output, shotList) {
  const errors = [];
  if (!output || typeof output !== "object") return ["output is not an object"];
  if (!Array.isArray(output.shots)) return ["shots must be an array"];

  const expected = shotList.shots.map((shot) => shot.id);
  if (output.shots.length !== expected.length) {
    errors.push(`expected ${expected.length} shot entries, got ${output.shots.length}`);
  }
  output.shots.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`shots[${index}] must be an object`);
      return;
    }
    if (!STATUSES.has(entry.status)) {
      errors.push(`shots[${index}].status must be present, missing, or uncertain`);
    }
    if (typeof entry.observed !== "string" || !entry.observed.trim()) {
      errors.push(`shots[${index}].observed must be a non-empty string`);
    }
  });
  if (output.unplanned !== undefined && !Array.isArray(output.unplanned)) {
    errors.push("unplanned must be an array when present");
  }
  return errors;
}

async function runConformanceAudit({ video, mimeType, shotList }, { provider }) {
  if (!shotList || !Array.isArray(shotList.shots) || shotList.shots.length === 0) {
    return { status: "skipped", reason: "this run has no approved shot list to compare against" };
  }
  if (typeof provider.generateJsonFromVideo !== "function") {
    return {
      status: "skipped",
      reason: `${provider.name} cannot watch video, so the cut was not compared to the shot list`,
    };
  }

  try {
    // Same one-retry rule as the Render Critic: a wrong entry count or stray
    // enum gets a fresh attempt before the honest skip.
    let output;
    let errors;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      output = await provider.generateJsonFromVideo({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(shotList),
        video,
        mimeType,
      });
      errors = validateConformance(output, shotList);
      if (errors.length === 0) break;
    }
    if (errors.length > 0) {
      throw new Error(`schema validation failed: ${errors.join("; ")}`);
    }

    // The shot's identity, timecode and purpose come from the approved packet,
    // never from the model — it only contributes status and what it observed.
    // A model paraphrase must not stand in for the thing a human signed off on.
    const shots = shotList.shots.map((shot, index) => {
      const entry = output.shots[index] || {};
      return {
        shot_id: shot.id,
        timecode: shot.timecode,
        purpose: shot.purpose,
        status: entry.status,
        observed: String(entry.observed || "").trim(),
      };
    });

    const unplanned = (output.unplanned || [])
      .filter((entry) => entry && typeof entry.observed === "string" && entry.observed.trim())
      .map((entry) => ({
        observed: entry.observed.trim(),
        where: typeof entry.where === "string" ? entry.where.trim() : null,
      }));

    return {
      status: "done",
      provider: provider.name,
      shots,
      unplanned,
      summary: {
        present: shots.filter((s) => s.status === "present").length,
        missing: shots.filter((s) => s.status === "missing").length,
        uncertain: shots.filter((s) => s.status === "uncertain").length,
        unplanned: unplanned.length,
      },
    };
  } catch (error) {
    return { status: "skipped", reason: error.message };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  runConformanceAudit,
  validateConformance,
};
