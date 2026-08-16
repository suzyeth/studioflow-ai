// Brief parsing shared by the server and the browser's offline path.
//
// Like data.js and view-model.js this is a plain browser script: no DOM access,
// no module syntax. Node evaluates the same file in a sandbox.
//
// This is the keyless Intake implementation. It is deliberately a real parser
// rather than a stub: it is what runs when no model is configured and when the
// page is opened straight off the filesystem, so the brief has to drive the
// output on this path too.
const STUDIOFLOW_INTAKE = {
  PLATFORMS: [
    { match: /instagram\s*reels?|(^|\W)reels?(\W|$)/i, label: "Instagram Reels" },
    { match: /tiktok/i, label: "TikTok" },
    { match: /youtube\s*shorts?/i, label: "YouTube Shorts" },
    { match: /youtube/i, label: "YouTube" },
    { match: /broadcast|\btv\b|television/i, label: "Broadcast" },
    { match: /cinema|theatrical/i, label: "Cinema" },
    { match: /linkedin/i, label: "LinkedIn" },
    { match: /web\s*site|landing page|\bweb\b/i, label: "Web" },
  ],

  STYLE_WORDS: [
    "cinematic", "documentary", "neon", "realism", "energetic", "minimal",
    "handheld", "moody", "vibrant", "gritty", "premium", "playful", "epic",
    "intimate", "surreal", "retro", "naturalistic", "high contrast",
  ],

  // "Label: value" lines, which is how briefs are usually pasted in.
  readLabel(text, labels) {
    for (const label of labels) {
      const pattern = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, "im");
      const found = text.match(pattern);
      if (found) {
        return found[1].trim().replace(/[.;]+$/, "");
      }
    }
    return null;
  },

  splitList(value) {
    return String(value)
      .split(/[,;、，；]|\band\b/i)
      .map((part) => part.trim().replace(/^[-*]\s*/, "").replace(/[.]+$/, ""))
      .filter((part) => part.length > 1);
  },

  readDurationSeconds(text) {
    const minutes = text.match(/(\d+(?:\.\d+)?)\s*[-\s]?\s*(?:minute|minutes|min)\b/i);
    if (minutes) {
      return Math.round(Number(minutes[1]) * 60);
    }

    const seconds = text.match(/(\d+)\s*[-\s]?\s*(?:second|seconds|sec|s)\b/i);
    if (seconds) {
      return Number(seconds[1]);
    }
    return null;
  },

  readPlatform(text) {
    const labelled = this.readLabel(text, ["platform", "channel", "deliver(?:able)?"]);
    if (labelled) return labelled;

    const hit = this.PLATFORMS.find((platform) => platform.match.test(text));
    return hit ? hit.label : null;
  },

  readStyle(text) {
    const labelled = this.readLabel(text, ["style", "tone", "look", "mood"]);
    if (labelled) return this.splitList(labelled);

    const found = this.STYLE_WORDS.filter((word) =>
      new RegExp(`\\b${word}\\b`, "i").test(text),
    );
    return found;
  },

  // Words that mark a phrase as describing people rather than a product.
  PEOPLE: /\b(people|persons?|professionals?|users?|customers?|consumers?|clients?|fans?|viewers?|audiences?|players?|gamers?|readers?|shoppers?|buyers?|parents?|students?|teens?|adults?|seniors?|women|men|scientists?|engineers?|developers?|designers?|marketers?|executives?|managers?|athletes?|runners?|commuters?|travell?ers?|baristas?|makers?|owners?|subscribers?|members?|families|households|millennials?|boomers?|demographics?)\b/i,

  readAudience(text) {
    const labelled = this.readLabel(text, ["audience", "target audience", "viewers", "for whom"]);
    if (labelled) return labelled;

    // "aimed at" and "targeting" are unambiguous.
    const explicit = text.match(/\b(?:aimed at|targeting|target(?:ed)? at)\s+([a-z][^.\n]{3,60})/i);
    if (explicit) return explicit[1].trim().replace(/[.;]+$/, "");

    // A bare "for X" usually names the product ("a teaser for the new shoe"),
    // so only accept it when X actually describes people.
    const loose = text.match(/\bfor\s+([a-z][^.\n]{3,60})/i);
    if (loose && this.PEOPLE.test(loose[1])) {
      return loose[1].trim().replace(/[.;]+$/, "");
    }

    return null;
  },

  readGoal(text) {
    const labelled = this.readLabel(text, ["goal", "objective", "brief", "ask"]);
    if (labelled) return labelled;

    const firstSentence = text.trim().split(/(?<=[.!?])\s+|\n{2,}/)[0];
    return firstSentence ? firstSentence.trim().replace(/[.;]+$/, "") : null;
  },

  readConstraints(text) {
    const labelled = this.readLabel(text, ["constraints?", "guardrails?", "requirements?", "rules?"]);
    const fromLabel = labelled ? this.splitList(labelled) : [];

    // Imperative guardrails stated inline rather than under a label.
    const inline = [];
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    for (const sentence of sentences) {
      const trimmed = sentence.trim().replace(/[.;]+$/, "");
      if (!trimmed || /^[a-z]+\s*[:：]/i.test(trimmed)) continue;
      if (/^(avoid|no |never|must|do not|don't|include|show|keep|ensure)\b/i.test(trimmed)) {
        inline.push(trimmed);
      }
    }

    const all = [...fromLabel, ...inline];
    return all.filter((item, index) => all.indexOf(item) === index);
  },

  parseBrief(rawText) {
    const text = String(rawText || "").trim();

    const goal = this.readGoal(text);
    const audience = this.readAudience(text);
    const platform = this.readPlatform(text);
    const durationSeconds = this.readDurationSeconds(text);
    const style = this.readStyle(text);
    const constraints = this.readConstraints(text);

    const successCriteria = [];
    if (durationSeconds) successCriteria.push(`Runs ${durationSeconds} seconds`);
    if (platform) successCriteria.push(`Delivers in ${platform} format`);
    if (constraints.length > 0) successCriteria.push("Every stated constraint is met");

    // Only ask about things that would actually block planning.
    // `fills` names the brief label an answer belongs under. Answers are folded
    // back in as "Label: value" so the parser can read them the same way it reads
    // the original brief — appending the raw question text would not parse.
    const clarifyingQuestions = [];
    if (!audience) {
      clarifyingQuestions.push({
        id: "question_audience",
        fills: "Audience",
        question: "Who is the intended audience?",
        why_it_matters: "Casting, tone, and platform choices all depend on it.",
      });
    }
    if (!platform) {
      clarifyingQuestions.push({
        id: "question_platform",
        fills: "Platform",
        question: "Where will this be delivered?",
        why_it_matters: "Aspect ratio and cut length are set by the platform.",
      });
    }
    if (!durationSeconds) {
      clarifyingQuestions.push({
        id: "question_duration",
        fills: "Duration",
        question: "What is the target duration?",
        why_it_matters: "The shot count and pacing cannot be planned without it.",
      });
    }

    return {
      structured_brief: {
        goal: goal || "Not stated in the brief",
        audience: audience || "Not stated in the brief",
        platform: platform || "Not stated in the brief",
        duration_seconds: durationSeconds,
        style,
        constraints,
        success_criteria: successCriteria,
      },
      clarifying_questions: clarifyingQuestions,
    };
  },

  // Shared by the server agent and the offline path so both describe an intake
  // result with the same sentence.
  summarize(structuredBrief, questionCount = 0) {
    const parts = [
      `Goal: ${structuredBrief.goal}`,
      `Audience: ${structuredBrief.audience}`,
      `Platform: ${structuredBrief.platform}`,
    ];
    if (structuredBrief.duration_seconds) {
      parts.push(`Duration: ${structuredBrief.duration_seconds}s`);
    }
    if (structuredBrief.constraints?.length > 0) {
      parts.push(`${structuredBrief.constraints.length} guardrail(s) captured`);
    }
    if (questionCount > 0) {
      parts.push(`${questionCount} clarifying question(s) raised`);
    }
    return `${parts.join(". ")}.`;
  },

  // The workspace brief chips render from this, so LLM output and heuristic
  // output reach the UI through one shape.
  toFields(structuredBrief) {
    const fields = [];
    const duration = structuredBrief.duration_seconds;

    fields.push(["Goal", structuredBrief.goal]);
    fields.push(["Audience", structuredBrief.audience]);
    fields.push(["Platform", structuredBrief.platform]);
    if (duration) fields.push(["Duration", `${duration}s`]);
    if (structuredBrief.style?.length) fields.push(["Style", structuredBrief.style.join(", ")]);
    if (structuredBrief.constraints?.length) {
      fields.push(["Guardrails", structuredBrief.constraints.join("; ")]);
    }
    return fields;
  },

  // Applied to model output before it is allowed to become an artifact, per
  // docs/AGENT_CONTRACTS.md. Returns the list of problems; empty means valid.
  validateIntakeOutput(value) {
    const errors = [];
    const isString = (v) => typeof v === "string" && v.trim().length > 0;
    const isStringArray = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");

    if (!value || typeof value !== "object") {
      return ["output is not an object"];
    }

    const brief = value.structured_brief;
    if (!brief || typeof brief !== "object") {
      return ["structured_brief is missing"];
    }

    for (const key of ["goal", "audience", "platform"]) {
      if (!isString(brief[key])) errors.push(`structured_brief.${key} must be a non-empty string`);
    }
    if (brief.duration_seconds !== null && typeof brief.duration_seconds !== "number") {
      errors.push("structured_brief.duration_seconds must be a number or null");
    }
    for (const key of ["style", "constraints", "success_criteria"]) {
      if (!isStringArray(brief[key])) errors.push(`structured_brief.${key} must be an array of strings`);
    }

    const questions = value.clarifying_questions;
    if (!Array.isArray(questions)) {
      errors.push("clarifying_questions must be an array");
    } else {
      questions.forEach((question, index) => {
        if (!question || typeof question !== "object" || !isString(question.question)) {
          errors.push(`clarifying_questions[${index}] must have a question string`);
        }
      });
    }

    return errors;
  },
};
