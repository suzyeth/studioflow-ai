// Labels and the default brief. Every artifact's *content* now comes from the
// agents, so nothing in this file describes a result — only what things are
// called and what brief the workspace opens with.
const STUDIOFLOW_DEMO = {
  project: {
    id: "proj_default",
    title: "Untitled project",
    status: "draft",
    track: "Taskmaster",
  },
  brief: {
    text: `Create a 30-second launch film for a premium canned coffee brand entering the Tokyo night market.

Audience: young urban professionals.
Style: neon realism, cinematic, energetic.
Constraints: show the product in the first 5 seconds, avoid health claims, include a clear CTA, deliver for Instagram Reels.`,
  },
  tasks: [
    {
      id: "intake",
      title: "Clarify creative requirements",
      agent: "Intake Agent",
      state: "queued",
    },
    {
      id: "planning",
      title: "Create production workflow",
      agent: "Planning Agent",
      state: "queued",
    },
    {
      id: "shots",
      title: "Generate scene and shot list",
      agent: "Shot Agent",
      state: "queued",
    },
    {
      id: "assets",
      title: "Extract production assets",
      agent: "Asset Agent",
      state: "queued",
    },
    {
      id: "prompts",
      title: "Create generation prompt pack",
      agent: "Prompt Agent",
      state: "queued",
    },
    {
      id: "critic",
      title: "Review continuity and brand risk",
      agent: "Critic Agent",
      state: "queued",
    },
  ],
  // Artifact titles. The bodies used to live here; agents produce them now.
  artifactTitles: {
    intake: 'Structured Creative Brief',
    planning: 'Workflow Plan',
    shots: 'Shot List',
    assets: 'Asset Manifest',
    prompts: 'Prompt Pack',
    critic: 'Risk Report',
  },
};
