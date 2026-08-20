// The Critic Agent's checks, one entry per constraint class.
//
// Plain browser script like data.js / intake-heuristics.js / production-heuristics.js:
// no DOM, no module syntax, evaluated in a sandbox by Node. It shares that sandbox
// with production-heuristics.js, so the two globals see each other exactly the way
// two <script> tags do in the browser.
//
// Split out of production-heuristics.js once the checks outgrew it. Adding a check
// is the highest-value repeated work in this project, and it should cost one entry
// in CHECKS rather than another hundred lines inside one function.
//
// Two rules govern every check, and both exist to protect the only claim this
// project can defend — that everything in the review queue is real:
//
//   1. A check reads real generated output. Restating the brief back to the user
//      is not a finding.
//   2. A check stays silent when the brief says nothing about its subject.
//      Inventing findings to make the queue look busy is worse than finding none.
//
// Checks run in array order and their findings are concatenated in that order, so
// the queue reads brief-constraint problems first and artifact-integrity problems
// last. Reordering this array reorders the review queue.
const STUDIOFLOW_CRITIC = {
  // Phrasings that forbid something. buildPromptPack only recognises the first
  // group, so anything matched by the loose pattern but not the strict one is a
  // constraint the prompt pack silently dropped — which is exactly what the
  // uncovered-prohibition check exists to catch.
  PROHIBITION: /^(no|avoid|never|do not|don't)\b/i,
  PROHIBITION_LOOSE: /\b(without|must not|should not|cannot|excluding|free of|minus)\b/i,

  REQUIREMENT: /\b(must include|include|show|feature|keep|ensure)\b/i,

  // A requirement quantified over every shot, and the words the quantifier
  // phrase itself contributes — matching those against a description would
  // satisfy the constraint with its own phrasing.
  QUANTIFIER: /\b(?:every|all|each)\s+(?:shot|scene|frame)s?\b/i,
  QUANTIFIER_WORDS: new Set(["every", "each", "all", "scene", "scenes", "frame", "frames"]),

  // Words that carry no visual meaning on their own, so requiring the shot list to
  // "mention" them would produce noise rather than a finding.
  STOPWORDS: new Set([
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with",
    "clear", "clearly", "visible", "first", "seconds", "second", "shot", "shots",
    "must", "include", "including", "show", "showing", "feature", "keep", "ensure",
    "it", "its", "their", "our", "your", "is", "are", "be",
  ]),

  keywordsFrom(text) {
    return String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !this.STOPWORDS.has(word));
  },

  // Whole-word match. The prohibition checks raise high-severity findings, so they
  // cannot use substring matching: "ad" would hit "additional" and "cat" would hit
  // "category". A wrong finding costs more than a missed one.
  matchesWord(haystack, word) {
    const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(String(haystack));
  },

  // Each check takes the same context and returns an array of findings — empty
  // when it has nothing to say, which is the common case and the point.
  //
  // ctx: { shotList, structuredBrief, constraints, clarifyingQuestions,
  //        promptPack, manifest }
  CHECKS: [
    {
      id: "hero-window",
      // "product visible in the first 5 seconds" style requirements.
      run({ shotList, constraints }) {
        const findings = [];
        const heroShot = shotList.shots.find((shot) => shot.is_hero);

        for (const constraint of constraints) {
          const window = constraint.match(/first\s+(\d+)\s*seconds?/i);
          if (!window) continue;

          const deadline = Number(window[1]);
          if (heroShot && heroShot.start_seconds > deadline) {
            findings.push({
              id: "hero-window",
              title: "Subject appears too late",
              severity: "high",
              target_task_ids: ["shots", "prompts"],
              body: `The brief requires "${constraint}", but the subject reveal starts at ${heroShot.start_seconds}s (${heroShot.timecode}).`,
              enforce: { heroFirst: true },
            });
          }
        }
        return findings;
      },
    },

    {
      id: "missing-cta",
      // An explicit CTA requirement with no CTA shot.
      run({ shotList, constraints }) {
        const wantsCta = constraints.some((constraint) =>
          /\bcta\b|call to action/i.test(constraint),
        );
        if (!wantsCta || shotList.shots.some((shot) => shot.is_cta)) return [];

        return [
          {
            id: "missing-cta",
            title: "No explicit call to action",
            severity: "medium",
            target_task_ids: ["shots", "prompts"],
            body: "The brief asks for a clear call to action, but the closing beat is a generic closing frame.",
            enforce: { ctaClose: true },
          },
        ];
      },
    },

    {
      id: "assumed-duration",
      // A runtime nobody stated is a planning risk, not a shot problem.
      run({ shotList, structuredBrief }) {
        if (structuredBrief.duration_seconds) return [];
        return [
          {
            id: "assumed-duration",
            title: "Runtime was assumed",
            severity: "medium",
            target_task_ids: ["shots"],
            body: `The brief states no duration, so the shot list assumes ${shotList.duration_seconds}s. Confirm before production.`,
          },
        ];
      },
    },

    {
      id: "stated-duration-mismatch",
      // The mirror of assumed-duration: the brief DID state a runtime and the
      // shot list planned a different one. buildShotList cannot produce this
      // today — it reads the duration straight off the brief — so like the
      // timeline check this exists for the moment a model writes the shot list,
      // where "a 30s brief, a 25s plan" is exactly the plausible-looking error a
      // per-shot schema check cannot see.
      run({ shotList, structuredBrief }) {
        if (!structuredBrief.duration_seconds) return [];
        if (shotList.duration_seconds === structuredBrief.duration_seconds) return [];
        return [
          {
            id: "stated-duration-mismatch",
            title: "Planned runtime contradicts the brief",
            severity: "high",
            target_task_ids: ["shots", "prompts"],
            body: `The brief states ${structuredBrief.duration_seconds}s, but the shot list was planned for ${shotList.duration_seconds}s.`,
          },
        ];
      },
    },

    {
      id: "undefined-style",
      run({ structuredBrief }) {
        if ((structuredBrief.style || []).length > 0) return [];
        return [
          {
            id: "undefined-style",
            title: "Visual direction undefined",
            severity: "low",
            target_task_ids: ["prompts"],
            body: "No style was stated, so prompts fall back to a neutral look.",
          },
        ];
      },
    },

    {
      id: "open-questions",
      run({ clarifyingQuestions }) {
        if (clarifyingQuestions.length === 0) return [];
        return [
          {
            id: "open-questions",
            title: "Intake questions still open",
            severity: "medium",
            target_task_ids: ["shots"],
            body: `Intake raised ${clarifyingQuestions.length} unanswered question(s): ${clarifyingQuestions
              .map((question) => question.question)
              .join(" ")}`,
          },
        ];
      },
    },

    {
      id: "uncovered-prohibition",
      // A prohibition the prompt pack did not turn into a negative prompt would
      // reach the generator as nothing at all.
      run({ constraints, promptPack }) {
        if (!promptPack) return [];

        const findings = [];
        const covered = new Set(
          (promptPack.shared_negative_prompt || []).map((item) => item.toLowerCase()),
        );

        for (const constraint of constraints) {
          const isProhibition =
            STUDIOFLOW_CRITIC.PROHIBITION.test(constraint) ||
            STUDIOFLOW_CRITIC.PROHIBITION_LOOSE.test(constraint);
          if (!isProhibition) continue;

          const keywords = STUDIOFLOW_CRITIC.keywordsFrom(constraint);
          const isCovered = [...covered].some((negative) =>
            keywords.some((word) => negative.includes(word)),
          );

          if (!isCovered) {
            findings.push({
              id: `uncovered-prohibition-${keywords[0] || "constraint"}`,
              title: "Prohibition missing from the prompt pack",
              severity: "high",
              target_task_ids: ["prompts"],
              body: `The brief states "${constraint}", but no negative prompt covers it, so nothing stops a generator from producing it.`,
            });
          }
        }
        return findings;
      },
    },

    {
      id: "prohibited-in-output",
      // The mirror of the check above, and the worse failure of the two. That one
      // asks whether a prohibition reached the negative prompts; this one asks
      // whether the thing is being actively asked for somewhere in the positive
      // output. A negative prompt cannot save a shot whose own description
      // requests the forbidden thing.
      run({ shotList, constraints, promptPack }) {
        const findings = [];

        for (const constraint of constraints) {
          const isProhibition =
            STUDIOFLOW_CRITIC.PROHIBITION.test(constraint) ||
            STUDIOFLOW_CRITIC.PROHIBITION_LOOSE.test(constraint);
          if (!isProhibition) continue;

          const keywords = STUDIOFLOW_CRITIC.keywordsFrom(constraint);
          if (keywords.length === 0) continue;

          // A prohibition whose subject is the film's own subject is a
          // contradiction in the brief, not a shot-list defect. It gets its own
          // finding, and matching it here would flag every single shot.
          const subjectWords = keywords.filter((word) =>
            STUDIOFLOW_CRITIC.matchesWord(shotList.subject, word),
          );
          const testable = keywords.filter((word) => !subjectWords.includes(word));

          if (subjectWords.length > 0) {
            findings.push({
              id: `prohibition-hits-subject-${subjectWords[0]}`,
              title: "Constraint contradicts the subject",
              severity: "high",
              target_task_ids: ["intake", "shots"],
              body: `The brief states "${constraint}", but the film's subject is "${shotList.subject}". A human has to resolve which one wins before production.`,
            });
            continue;
          }

          if (testable.length === 0) continue;

          const offenders = [];
          for (const shot of shotList.shots) {
            const hit = testable.find((word) =>
              STUDIOFLOW_CRITIC.matchesWord(shot.description, word),
            );
            if (hit) offenders.push({ where: shot.timecode, word: hit });
          }
          for (const prompt of promptPack ? promptPack.prompts : []) {
            const hit = testable.find((word) =>
              STUDIOFLOW_CRITIC.matchesWord(prompt.prompt, word),
            );
            if (hit && !offenders.some((entry) => entry.where === prompt.timecode)) {
              offenders.push({ where: prompt.timecode, word: hit });
            }
          }

          if (offenders.length > 0) {
            findings.push({
              id: `prohibited-in-output-${offenders[0].word}`,
              title: "Forbidden element appears in the production output",
              severity: "high",
              target_task_ids: ["shots", "prompts"],
              body: `The brief states "${constraint}", but "${offenders[0].word}" is written into ${offenders.length} generated item(s), starting at ${offenders[0].where}.`,
            });
          }
        }
        return findings;
      },
    },

    {
      id: "unmet-requirement",
      // Something the brief requires that no shot actually depicts.
      run({ shotList, constraints }) {
        const findings = [];

        for (const constraint of constraints) {
          if (!STUDIOFLOW_CRITIC.REQUIREMENT.test(constraint)) continue;
          if (
            STUDIOFLOW_CRITIC.PROHIBITION.test(constraint) ||
            /\bcta\b|call to action/i.test(constraint)
          ) {
            continue;
          }
          if (/first\s+\d+\s*seconds?/i.test(constraint)) continue; // covered by hero-window

          const keywords = STUDIOFLOW_CRITIC.keywordsFrom(constraint);
          if (keywords.length === 0) continue;

          const described = shotList.shots
            .map((shot) => shot.description.toLowerCase())
            .join(" ");

          if (!keywords.some((word) => described.includes(word))) {
            findings.push({
              id: `unmet-requirement-${keywords[0]}`,
              title: "Required element missing from the shot list",
              severity: "high",
              target_task_ids: ["shots", "prompts"],
              body: `The brief requires "${constraint}", but no shot depicts it.`,
            });
          }
        }
        return findings;
      },
    },

    {
      id: "every-shot",
      // A requirement quantified over every shot — "keep the logo visible in
      // every shot" — met by some shots and not others. Partial coverage is the
      // one case unmet-requirement cannot see: it goes quiet as soon as ANY shot
      // depicts the element. Total absence is deliberately left to it, so the
      // two checks never fire on the same constraint.
      run({ shotList, constraints }) {
        const findings = [];

        for (const constraint of constraints) {
          if (!STUDIOFLOW_CRITIC.QUANTIFIER.test(constraint)) continue;

          const keywords = STUDIOFLOW_CRITIC.keywordsFrom(constraint).filter(
            (word) => !STUDIOFLOW_CRITIC.QUANTIFIER_WORDS.has(word),
          );
          if (keywords.length === 0) continue;

          const missing = shotList.shots.filter(
            (shot) =>
              !keywords.some((word) => STUDIOFLOW_CRITIC.matchesWord(shot.description, word)),
          );

          // All missing → unmet-requirement's finding; none missing → satisfied.
          if (missing.length === 0 || missing.length === shotList.shots.length) continue;

          findings.push({
            id: `every-shot-${keywords[0]}`,
            title: "Required in every shot, missing from some",
            severity: "medium",
            target_task_ids: ["shots", "prompts"],
            body: `The brief requires "${constraint}", but ${missing.length} of ${shotList.shots.length} shot(s) do not include it, starting at ${missing[0].timecode}.`,
          });
        }
        return findings;
      },
    },

    {
      id: "pacing",
      // Both directions are real production problems.
      run({ shotList }) {
        const averageShot = shotList.duration_seconds / shotList.shots.length;

        if (averageShot > 15) {
          return [
            {
              id: "slow-pacing",
              title: "Shots run long",
              severity: "low",
              target_task_ids: ["shots"],
              body: `${shotList.shots.length} shots across ${shotList.duration_seconds}s averages ${Math.round(averageShot)}s per shot. Consider more coverage.`,
            },
          ];
        }

        if (averageShot < 1.5 && shotList.shots.length > 2) {
          return [
            {
              id: "fast-pacing",
              title: "Cuts are very fast",
              severity: "low",
              target_task_ids: ["shots"],
              body: `${shotList.shots.length} shots across ${shotList.duration_seconds}s averages ${averageShot.toFixed(1)}s per shot, which is too fast to read.`,
            },
          ];
        }

        return [];
      },
    },

    {
      id: "aspect-conflict",
      // An aspect ratio the brief asks for that the platform contradicts.
      run({ shotList, structuredBrief, constraints }) {
        const wantsVertical = /\b(vertical|9:16|portrait)\b/i.test(JSON.stringify(constraints));
        const wantsHorizontal = /\b(horizontal|16:9|landscape|widescreen)\b/i.test(
          JSON.stringify(constraints),
        );
        const isVertical = shotList.aspect_ratio.includes("9:16");

        if (!((wantsVertical && !isVertical) || (wantsHorizontal && isVertical))) return [];

        return [
          {
            id: "aspect-conflict",
            title: "Aspect ratio conflicts with the platform",
            severity: "high",
            target_task_ids: ["shots", "prompts"],
            body: `The brief asks for ${wantsVertical ? "a vertical" : "a horizontal"} frame, but ${structuredBrief.platform} was planned as ${shotList.aspect_ratio}.`,
          },
        ];
      },
    },

    {
      id: "timeline",
      // `allocate` guarantees contiguous whole seconds today, so this stays quiet
      // on generated output — it exists for the moment a model writes the shot
      // list (TODO.md item 5), where a gap, an overlap, or a runtime that misses
      // the target is exactly the kind of plausible-looking error a schema check
      // cannot see. validateShotList only checks each shot in isolation; nothing
      // else looks at the seams between them.
      //
      // Both findings come from one walk, and a discontinuity suppresses the
      // runtime finding: once the seams are wrong the total is meaningless.
      run({ shotList }) {
        const ordered = [...shotList.shots].sort((a, b) => a.sequence - b.sequence);
        let expectedStart = 0;

        for (const shot of ordered) {
          if (shot.start_seconds !== expectedStart) {
            const kind = shot.start_seconds > expectedStart ? "gap" : "overlap";
            return [
              {
                id: "timeline-discontinuity",
                title: `Shot timings leave a ${kind}`,
                severity: "high",
                target_task_ids: ["shots"],
                body: `${shot.id} starts at ${shot.start_seconds}s but the previous shot ends at ${expectedStart}s, leaving a ${Math.abs(shot.start_seconds - expectedStart)}s ${kind}.`,
              },
            ];
          }
          expectedStart = shot.end_seconds;
        }

        if (expectedStart === shotList.duration_seconds) return [];

        return [
          {
            id: "runtime-mismatch",
            title: "Shot list does not fill the runtime",
            severity: "high",
            target_task_ids: ["shots"],
            body: `The shots total ${expectedStart}s against a planned runtime of ${shotList.duration_seconds}s.`,
          },
        ];
      },
    },

    {
      id: "asset-coverage",
      // An asset group nobody shoots. This is a real defect the revision loop can
      // introduce rather than a hypothetical: buildAssetManifest binds groups to
      // beats, and a rerun with enforce.heroFirst reorders beats while fitBeats
      // can drop them entirely on short runtimes — leaving, say, a talent group
      // with no shot to appear in. Someone would go and cast it anyway.
      run({ shotList, manifest }) {
        if (!manifest) return [];

        const findings = [];
        const shotIds = new Set(shotList.shots.map((shot) => shot.id));

        for (const asset of manifest.assets || []) {
          const neededFor = asset.needed_for || [];

          if (neededFor.length === 0) {
            findings.push({
              id: `orphan-asset-${asset.id}`,
              title: "Asset group is not used by any shot",
              severity: "medium",
              target_task_ids: ["assets"],
              body: `"${asset.name}" (${asset.category}) is in the manifest but no shot calls for it, so it would be sourced for nothing.`,
            });
            continue;
          }

          const dangling = neededFor.filter((shotId) => !shotIds.has(shotId));
          if (dangling.length > 0) {
            findings.push({
              id: `dangling-asset-${asset.id}`,
              title: "Asset points at a shot that does not exist",
              severity: "high",
              target_task_ids: ["assets"],
              body: `"${asset.name}" lists ${dangling.join(", ")}, which the shot list does not contain — the manifest is out of date with the shots.`,
            });
          }
        }
        return findings;
      },
    },

    {
      id: "prompt-coverage",
      // The prompt pack's seams against the shot list, the way asset-coverage
      // walks the manifest's. A shot with no prompt reaches the generator with
      // no instructions at all; a prompt whose shot no longer exists is stale
      // direction someone would render anyway. buildPromptPack derives one
      // prompt per shot today, so this stays quiet on generated output — it
      // exists for a model-written pack and for reruns that regenerate one
      // artifact but not the other.
      run({ shotList, promptPack }) {
        if (!promptPack) return [];

        const prompts = promptPack.prompts || [];
        const promptShotIds = new Set(
          prompts.map((prompt) => prompt.shot_id).filter(Boolean),
        );
        // A pack that carries no shot ids at all cannot be judged against the
        // shot list — silence beats flagging every shot on a format difference.
        if (promptShotIds.size === 0) return [];

        const findings = [];
        const shotIds = new Set(shotList.shots.map((shot) => shot.id));

        for (const shot of shotList.shots) {
          if (!promptShotIds.has(shot.id)) {
            findings.push({
              id: `missing-prompt-${shot.id}`,
              title: "Shot has no prompt",
              severity: "high",
              target_task_ids: ["prompts"],
              body: `${shot.id} (${shot.timecode}) has no entry in the prompt pack, so nothing tells a generator what to produce for it.`,
            });
          }
        }

        for (const prompt of prompts) {
          if (prompt.shot_id && !shotIds.has(prompt.shot_id)) {
            findings.push({
              id: `stale-prompt-${prompt.shot_id}`,
              title: "Prompt points at a shot that does not exist",
              severity: "medium",
              target_task_ids: ["prompts"],
              body: `A prompt targets ${prompt.shot_id}, which the shot list does not contain — the pack is out of date with the shots.`,
            });
          }
        }
        return findings;
      },
    },
  ],

  // Runs every check in order and concatenates what they return. The number of
  // findings varies by brief, which is the point: an empty list means the shot
  // list actually satisfied it.
  review(ctx) {
    const findings = [];
    for (const check of this.CHECKS) {
      const produced = check.run(ctx);
      if (produced && produced.length > 0) findings.push(...produced);
    }
    return findings;
  },
};
