// Shot list, asset manifest, prompt pack, and critic findings.
//
// Plain browser script like data.js / intake-heuristics.js: no DOM, no module
// syntax, evaluated in a sandbox by Node.
//
// Division of labour that matters: the Shot Agent lays out a standard narrative
// structure and does NOT try to satisfy every stated constraint. The Critic Agent
// checks the result against the brief. A revision re-runs the Shot Agent with the
// specific constraint enforced. That is what makes the review loop real work
// rather than theatre — the first pass genuinely can be wrong.
const STUDIOFLOW_PRODUCTION = {
  DEFAULT_DURATION: 30,

  VERTICAL: /reels?|tiktok|shorts?|stories/i,

  // Beat template, as fractions of the runtime. Atmosphere opens, the subject is
  // revealed after the world is established.
  BEATS: [
    { id: "hook", share: 0.12, purpose: "Open on atmosphere and establish tone" },
    { id: "context", share: 0.2, purpose: "Establish the world and the situation" },
    { id: "hero", share: 0.18, purpose: "Reveal the subject clearly", hero: true },
    { id: "detail", share: 0.2, purpose: "Close detail and texture" },
    { id: "proof", share: 0.18, purpose: "Human beat that carries the point" },
    { id: "close", share: 0.12, purpose: "Closing frame" },
  ],

  subjectFrom(structuredBrief) {
    const goal = String(structuredBrief.goal || "").trim();
    const about = goal.match(/\b(?:about|for|of|featuring|promoting)\s+(.+)$/i);
    if (about) {
      return about[1].replace(/[.]+$/, "").trim();
    }
    // Fall back to the goal minus a leading duration/format phrase.
    const stripped = goal.replace(/^(?:a|an|the)\s+/i, "").replace(/^\d+[-\s]?\w*\s+/i, "");
    return stripped || "the subject";
  },

  aspectFor(platform) {
    return this.VERTICAL.test(String(platform || "")) ? "9:16 vertical" : "16:9 horizontal";
  },

  // Whole-second timings that always add up to the runtime. Rounding error is
  // spread across beats, and no beat is ever allowed below one second — so the
  // caller must not pass more beats than there are seconds.
  allocate(durationSeconds, beats) {
    const total = beats.reduce((sum, beat) => sum + beat.share, 0);
    const lengths = beats.map((beat) =>
      Math.max(1, Math.round((beat.share / total) * durationSeconds)),
    );

    // drift is (allocated - target): adding a second to a beat moves it up by one.
    let drift = lengths.reduce((sum, value) => sum + value, 0) - durationSeconds;
    let guard = lengths.length * (Math.abs(drift) + 1);

    while (drift !== 0 && guard > 0) {
      const before = drift;

      for (let i = lengths.length - 1; i >= 0 && drift !== 0; i -= 1) {
        if (drift > 0 && lengths[i] > 1) {
          lengths[i] -= 1;
          drift -= 1;
        } else if (drift < 0) {
          lengths[i] += 1;
          drift += 1;
        }
      }

      guard -= 1;
      if (drift === before) break; // every beat is already at the floor
    }

    return lengths;
  },

  // One beat cannot be shorter than a second, so a very short runtime gets fewer
  // beats. The subject reveal is never the beat that gets dropped.
  fitBeats(beats, durationSeconds) {
    if (durationSeconds >= beats.length) return beats;

    const kept = beats.slice(0, Math.max(1, durationSeconds));
    if (!kept.some((beat) => beat.hero)) {
      const hero = beats.find((beat) => beat.hero);
      if (hero) kept[kept.length - 1] = { ...hero };
    }
    return kept;
  },

  formatClock(seconds) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  },

  // enforce.heroFirst moves the subject reveal to the top; enforce.ctaClose turns
  // the final beat into an explicit call to action. Both are applied on rerun.
  // The Planning Agent's output: what the film is, how long, and which beats it is
  // made of. The Shot Agent lays timings over this, so planning genuinely precedes
  // shots instead of being reverse-engineered from them.
  buildPlan(structuredBrief, enforce = {}) {
    const duration = structuredBrief.duration_seconds || this.DEFAULT_DURATION;
    const aspect = this.aspectFor(structuredBrief.platform);

    let beats = this.BEATS.map((beat) => ({ ...beat }));
    if (enforce.heroFirst) {
      const hero = beats.find((beat) => beat.hero);
      beats = [hero, ...beats.filter((beat) => !beat.hero)];
    }
    beats = this.fitBeats(beats, duration);

    if (enforce.ctaClose) {
      const last = beats[beats.length - 1];
      last.id = "cta";
      last.purpose = "Explicit call to action on a clean end frame";
      last.cta = true;
    }

    return {
      subject: this.subjectFrom(structuredBrief),
      style: (structuredBrief.style || []).join(", ") || "neutral",
      duration_seconds: duration,
      aspect_ratio: aspect,
      beats,
      review_gates: ["critic_review", "human_approval"],
      delivery: `${aspect}, ${duration}s`,
    };
  },

  buildShotList(structuredBrief, enforce = {}) {
    const plan = this.buildPlan(structuredBrief, enforce);
    const { duration_seconds: duration, subject, style, aspect_ratio: aspect, beats } = plan;

    const lengths = this.allocate(duration, beats);
    let cursor = 0;

    const shots = beats.map((beat, index) => {
      const start = cursor;
      const end = cursor + lengths[index];
      cursor = end;

      const description = beat.cta
        ? `End card with a clear call to action alongside ${subject}`
        : beat.hero
          ? `${subject} presented clearly in frame, unobstructed`
          : `${beat.purpose}, built around ${subject}`;

      return {
        id: `shot_${index + 1}`,
        sequence: index + 1,
        start_seconds: start,
        end_seconds: end,
        timecode: `${this.formatClock(start)}-${this.formatClock(end)}`,
        beat: beat.id,
        purpose: beat.purpose,
        description,
        is_hero: Boolean(beat.hero),
        is_cta: Boolean(beat.cta),
      };
    });

    return {
      subject,
      duration_seconds: duration,
      aspect_ratio: aspect,
      style,
      shots,
    };
  },

  buildAssetManifest(shotList, structuredBrief) {
    const assets = [
      { id: "asset_subject", name: shotList.subject, category: "subject", needed_for: shotList.shots.filter((s) => s.is_hero).map((s) => s.id) },
      { id: "asset_location", name: `Primary location supporting "${shotList.style}"`, category: "location", needed_for: shotList.shots.filter((s) => s.beat === "context").map((s) => s.id) },
      { id: "asset_talent", name: `On-camera presence for ${structuredBrief.audience}`, category: "talent", needed_for: shotList.shots.filter((s) => s.beat === "proof").map((s) => s.id) },
      { id: "asset_detail", name: `Macro / texture coverage of ${shotList.subject}`, category: "coverage", needed_for: shotList.shots.filter((s) => s.beat === "detail").map((s) => s.id) },
      { id: "asset_audio", name: "Ambient bed and sound design", category: "audio", needed_for: shotList.shots.map((s) => s.id) },
    ];

    const ctaShots = shotList.shots.filter((shot) => shot.is_cta);
    if (ctaShots.length > 0) {
      assets.push({
        id: "asset_endcard",
        name: "End-card lockup and CTA typography",
        category: "graphics",
        needed_for: ctaShots.map((shot) => shot.id),
      });
    }

    return { assets, delivery: `${shotList.aspect_ratio}, ${shotList.duration_seconds}s` };
  },

  buildPromptPack(shotList, structuredBrief) {
    const negatives = (structuredBrief.constraints || [])
      .filter((constraint) => /^(no|avoid|never|do not|don't)\b/i.test(constraint))
      .map((constraint) => constraint.replace(/^(no|avoid|never|do not|don't)\s*/i, "").trim())
      .filter(Boolean);

    return {
      shared_negative_prompt: negatives,
      prompts: shotList.shots.map((shot) => ({
        shot_id: shot.id,
        timecode: shot.timecode,
        prompt: `${shot.description}. Style: ${shotList.style}. Framing: ${shotList.aspect_ratio}. ${shot.purpose}.`,
        negative_prompt: negatives,
      })),
    };
  },

  // Phrasings that forbid something. buildPromptPack only recognises the first
  // group, so anything matched here but not there is a constraint the prompt pack
  // silently dropped — which is exactly what the Critic exists to catch.
  PROHIBITION: /^(no|avoid|never|do not|don't)\b/i,
  PROHIBITION_LOOSE: /\b(without|must not|should not|cannot|excluding|free of|minus)\b/i,

  REQUIREMENT: /\b(must include|include|show|feature|keep|ensure)\b/i,

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

  // Whole-word match. The prohibition checks below raise high-severity findings,
  // so they cannot use substring matching: "ad" would hit "additional" and
  // "cat" would hit "category". A wrong finding costs more than a missed one —
  // the review queue is only worth anything if every item in it is real.
  matchesWord(haystack, word) {
    const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(String(haystack));
  },

  // Real checks against the brief. The number of findings varies by brief, which
  // is the point: an empty list means the shot list actually satisfied it.
  reviewShotList(
    shotList,
    structuredBrief,
    clarifyingQuestions = [],
    promptPack = null,
    manifest = null,
  ) {
    const findings = [];
    const constraints = structuredBrief.constraints || [];
    const heroShot = shotList.shots.find((shot) => shot.is_hero);

    // "product visible in the first 5 seconds" style requirements.
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

    // An explicit CTA requirement with no CTA shot.
    const wantsCta = constraints.some((constraint) => /\bcta\b|call to action/i.test(constraint));
    if (wantsCta && !shotList.shots.some((shot) => shot.is_cta)) {
      findings.push({
        id: "missing-cta",
        title: "No explicit call to action",
        severity: "medium",
        target_task_ids: ["shots", "prompts"],
        body: "The brief asks for a clear call to action, but the closing beat is a generic closing frame.",
        enforce: { ctaClose: true },
      });
    }

    // A runtime nobody stated is a planning risk, not a shot problem.
    if (!structuredBrief.duration_seconds) {
      findings.push({
        id: "assumed-duration",
        title: "Runtime was assumed",
        severity: "medium",
        target_task_ids: ["shots"],
        body: `The brief states no duration, so the shot list assumes ${shotList.duration_seconds}s. Confirm before production.`,
      });
    }

    if ((structuredBrief.style || []).length === 0) {
      findings.push({
        id: "undefined-style",
        title: "Visual direction undefined",
        severity: "low",
        target_task_ids: ["prompts"],
        body: "No style was stated, so prompts fall back to a neutral look.",
      });
    }

    if (clarifyingQuestions.length > 0) {
      findings.push({
        id: "open-questions",
        title: "Intake questions still open",
        severity: "medium",
        target_task_ids: ["shots"],
        body: `Intake raised ${clarifyingQuestions.length} unanswered question(s): ${clarifyingQuestions
          .map((question) => question.question)
          .join(" ")}`,
      });
    }

    // A prohibition the prompt pack did not turn into a negative prompt would
    // reach the generator as nothing at all.
    if (promptPack) {
      const covered = new Set(
        (promptPack.shared_negative_prompt || []).map((item) => item.toLowerCase()),
      );

      for (const constraint of constraints) {
        const isProhibition =
          this.PROHIBITION.test(constraint) || this.PROHIBITION_LOOSE.test(constraint);
        if (!isProhibition) continue;

        const keywords = this.keywordsFrom(constraint);
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
    }

    // The mirror of the check above, and the worse failure of the two. That one
    // asks whether a prohibition reached the negative prompts; this one asks
    // whether the thing is being actively asked for somewhere in the positive
    // output. A negative prompt cannot save a shot whose own description
    // requests the forbidden thing.
    for (const constraint of constraints) {
      const isProhibition =
        this.PROHIBITION.test(constraint) || this.PROHIBITION_LOOSE.test(constraint);
      if (!isProhibition) continue;

      const keywords = this.keywordsFrom(constraint);
      if (keywords.length === 0) continue;

      // A prohibition whose subject is the film's own subject is a contradiction
      // in the brief, not a shot-list defect. It gets its own finding below, and
      // matching it here would flag every single shot.
      const subjectWords = keywords.filter((word) => this.matchesWord(shotList.subject, word));
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
        const hit = testable.find((word) => this.matchesWord(shot.description, word));
        if (hit) offenders.push({ where: shot.timecode, word: hit });
      }
      for (const prompt of promptPack ? promptPack.prompts : []) {
        const hit = testable.find((word) => this.matchesWord(prompt.prompt, word));
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

    // Something the brief requires that no shot actually depicts.
    for (const constraint of constraints) {
      if (!this.REQUIREMENT.test(constraint)) continue;
      if (this.PROHIBITION.test(constraint) || /\bcta\b|call to action/i.test(constraint)) continue;
      if (/first\s+\d+\s*seconds?/i.test(constraint)) continue; // covered by hero-window

      const keywords = this.keywordsFrom(constraint);
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

    // Pacing. Both directions are real production problems.
    const averageShot = shotList.duration_seconds / shotList.shots.length;
    if (averageShot > 15) {
      findings.push({
        id: "slow-pacing",
        title: "Shots run long",
        severity: "low",
        target_task_ids: ["shots"],
        body: `${shotList.shots.length} shots across ${shotList.duration_seconds}s averages ${Math.round(averageShot)}s per shot. Consider more coverage.`,
      });
    } else if (averageShot < 1.5 && shotList.shots.length > 2) {
      findings.push({
        id: "fast-pacing",
        title: "Cuts are very fast",
        severity: "low",
        target_task_ids: ["shots"],
        body: `${shotList.shots.length} shots across ${shotList.duration_seconds}s averages ${averageShot.toFixed(1)}s per shot, which is too fast to read.`,
      });
    }

    // An aspect ratio the brief asks for that the platform contradicts.
    const wantsVertical = /\b(vertical|9:16|portrait)\b/i.test(JSON.stringify(constraints));
    const wantsHorizontal = /\b(horizontal|16:9|landscape|widescreen)\b/i.test(
      JSON.stringify(constraints),
    );
    const isVertical = shotList.aspect_ratio.includes("9:16");

    if ((wantsVertical && !isVertical) || (wantsHorizontal && isVertical)) {
      findings.push({
        id: "aspect-conflict",
        title: "Aspect ratio conflicts with the platform",
        severity: "high",
        target_task_ids: ["shots", "prompts"],
        body: `The brief asks for ${wantsVertical ? "a vertical" : "a horizontal"} frame, but ${structuredBrief.platform} was planned as ${shotList.aspect_ratio}.`,
      });
    }

    // Timeline integrity. `allocate` guarantees contiguous whole seconds today,
    // so this stays quiet on generated output — it exists for the moment a model
    // writes the shot list (TODO.md item 5), where a gap, an overlap, or a
    // runtime that misses the target is exactly the kind of plausible-looking
    // error a schema check cannot see. validateShotList only checks each shot in
    // isolation; nothing else looks at the seams between them.
    const ordered = [...shotList.shots].sort((a, b) => a.sequence - b.sequence);
    let expectedStart = 0;
    for (const shot of ordered) {
      if (shot.start_seconds !== expectedStart) {
        const kind = shot.start_seconds > expectedStart ? "gap" : "overlap";
        findings.push({
          id: "timeline-discontinuity",
          title: `Shot timings leave a ${kind}`,
          severity: "high",
          target_task_ids: ["shots"],
          body: `${shot.id} starts at ${shot.start_seconds}s but the previous shot ends at ${expectedStart}s, leaving a ${Math.abs(shot.start_seconds - expectedStart)}s ${kind}.`,
        });
        break;
      }
      expectedStart = shot.end_seconds;
    }

    if (
      findings.every((finding) => finding.id !== "timeline-discontinuity") &&
      expectedStart !== shotList.duration_seconds
    ) {
      findings.push({
        id: "runtime-mismatch",
        title: "Shot list does not fill the runtime",
        severity: "high",
        target_task_ids: ["shots"],
        body: `The shots total ${expectedStart}s against a planned runtime of ${shotList.duration_seconds}s.`,
      });
    }

    // An asset group nobody shoots. This is a real defect the revision loop can
    // introduce rather than a hypothetical: buildAssetManifest binds groups to
    // beats, and a rerun with enforce.heroFirst reorders beats while fitBeats can
    // drop them entirely on short runtimes — leaving, say, a talent group with no
    // shot to appear in. Someone would go and cast it anyway.
    if (manifest) {
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
    }

    return findings;
  },

  shotListMarkdown(shotList) {
    return shotList.shots
      .map((shot) => `- ${shot.timecode} ${shot.description}`)
      .join("\n");
  },

  summarizeShotList(shotList) {
    return `${shotList.shots.length} shots across ${shotList.duration_seconds}s in ${shotList.aspect_ratio}, built around ${shotList.subject}.`;
  },

  summarizeAssets(manifest) {
    return `${manifest.assets.length} asset groups for ${manifest.delivery}: ${manifest.assets
      .map((asset) => asset.name)
      .join("; ")}.`;
  },

  summarizePrompts(promptPack) {
    const negatives = promptPack.shared_negative_prompt.length;
    return `${promptPack.prompts.length} per-shot prompts${negatives > 0 ? ` with ${negatives} shared negative prompt(s)` : ""}.`;
  },

  summarizeFindings(findings) {
    return findings.length === 0
      ? "No continuity or brand risks found against the stated constraints."
      : `${findings.length} finding(s) routed to human review: ${findings.map((f) => f.title).join("; ")}.`;
  },

  summarizePlan(plan) {
    return `${plan.beats.length}-beat plan for ${plan.duration_seconds}s, delivering ${plan.aspect_ratio}, with critic review and human approval gates.`;
  },

  planMarkdown(plan) {
    return plan.beats.map((beat, index) => `- ${index + 1}. ${beat.id}: ${beat.purpose}`).join("\n");
  },

  // One call that produces every production artifact. The server pipeline and the
  // browser's offline path both go through here, so neither can drift.
  buildAll(structuredBrief, clarifyingQuestions = [], enforce = {}) {
    const plan = this.buildPlan(structuredBrief, enforce);
    const shotList = this.buildShotList(structuredBrief, enforce);
    const manifest = this.buildAssetManifest(shotList, structuredBrief);
    const promptPack = this.buildPromptPack(shotList, structuredBrief);
    const findings = this.reviewShotList(
      shotList,
      structuredBrief,
      clarifyingQuestions,
      promptPack,
      manifest,
    );

    return {
      plan,
      shotList,
      manifest,
      promptPack,
      findings,
      summaries: {
        planning: this.summarizePlan(plan),
        shots: this.summarizeShotList(shotList),
        assets: this.summarizeAssets(manifest),
        prompts: this.summarizePrompts(promptPack),
        critic: this.summarizeFindings(findings),
      },
      markdown: {
        planning: this.planMarkdown(plan),
        shots: this.shotListMarkdown(shotList),
        assets: manifest.assets.map((asset) => `- ${asset.name}`).join("\n"),
        prompts: promptPack.prompts.map((prompt) => `- ${prompt.prompt}`).join("\n"),
        critic: findings.map((finding) => `- ${finding.title}: ${finding.body}`).join("\n"),
      },
    };
  },

  packetMarkdown(structuredBrief, built) {
    const { shotList, manifest, promptPack, findings } = built;
    const list = (items) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None stated");

    return [
      `# Production Packet: ${shotList.subject}`,
      "",
      "## Structured Brief",
      `- Goal: ${structuredBrief.goal}`,
      `- Audience: ${structuredBrief.audience}`,
      `- Platform: ${structuredBrief.platform}`,
      `- Runtime: ${shotList.duration_seconds}s (${shotList.aspect_ratio})`,
      `- Style: ${shotList.style}`,
      "",
      "## Constraints",
      list(structuredBrief.constraints || []),
      "",
      "## Shot List",
      this.shotListMarkdown(shotList),
      "",
      "## Asset Manifest",
      list(manifest.assets.map((asset) => `${asset.name} (${asset.category})`)),
      "",
      "## Prompt Pack",
      promptPack.prompts.map((prompt) => `- ${prompt.timecode} ${prompt.prompt}`).join("\n"),
      promptPack.shared_negative_prompt.length > 0
        ? `\nNegative prompts: ${promptPack.shared_negative_prompt.join(", ")}`
        : "",
      "",
      "## Critic Review",
      findings.length === 0
        ? "No findings against the stated constraints."
        : list(findings.map((finding) => `${finding.title} — ${finding.body}`)),
      "",
      "## Success Criteria",
      list(structuredBrief.success_criteria || []),
    ].join("\n");
  },

  validateShotList(value) {
    const errors = [];
    if (!value || typeof value !== "object") return ["shot list is not an object"];
    if (!Array.isArray(value.shots) || value.shots.length === 0) {
      return ["shots must be a non-empty array"];
    }
    value.shots.forEach((shot, index) => {
      if (typeof shot.description !== "string" || !shot.description.trim()) {
        errors.push(`shots[${index}].description must be a non-empty string`);
      }
      if (typeof shot.start_seconds !== "number" || typeof shot.end_seconds !== "number") {
        errors.push(`shots[${index}] must have numeric start_seconds and end_seconds`);
      } else if (shot.end_seconds <= shot.start_seconds) {
        errors.push(`shots[${index}] must end after it starts`);
      }
    });
    return errors;
  },

  validateFindings(value) {
    if (!Array.isArray(value)) return ["findings must be an array"];
    const errors = [];
    value.forEach((finding, index) => {
      if (!finding || typeof finding.title !== "string" || !finding.title.trim()) {
        errors.push(`findings[${index}].title must be a non-empty string`);
      }
      if (!Array.isArray(finding.target_task_ids) || finding.target_task_ids.length === 0) {
        errors.push(`findings[${index}].target_task_ids must be a non-empty array`);
      }
    });
    return errors;
  },
};
