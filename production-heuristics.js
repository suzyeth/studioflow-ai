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

  // The checks themselves live in critic-checks.js. They outgrew this file, and
  // adding one should cost an entry in that array rather than another branch in a
  // 300-line function. Both files are loaded into the same sandbox, so the global
  // below is visible here exactly as it is in the browser.
  //
  // The signature is unchanged on purpose: server.js, the pipeline, the offline
  // browser path, and the tests all call this, and none of them should have to
  // know the checks moved.
  reviewShotList(
    shotList,
    structuredBrief,
    clarifyingQuestions = [],
    promptPack = null,
    manifest = null,
  ) {
    return STUDIOFLOW_CRITIC.review({
      shotList,
      structuredBrief,
      constraints: structuredBrief.constraints || [],
      clarifyingQuestions,
      promptPack,
      manifest,
    });
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
