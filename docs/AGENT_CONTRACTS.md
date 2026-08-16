# StudioFlow AI Agent Contracts

These contracts define the role, input, and schema-shaped output for each MVP
agent. The implementation should validate every agent response before saving an
artifact or advancing a task state.

## Shared Runtime Rules

Every agent receives:

```json
{
  "project_id": "proj_tokyo_coffee",
  "trace_id": "run-2026-08-10-001",
  "brief": {},
  "prior_artifacts": [],
  "task": {}
}
```

Every agent returns:

```json
{
  "agent_id": "intake_agent",
  "task_id": "task_intake",
  "status": "completed | needs_review | failed",
  "summary": "One-paragraph result summary.",
  "artifact": {},
  "review_items": [],
  "audit_message": "Human-readable event summary."
}
```

## Intake Agent

Responsibility: convert a rough creative brief into a structured brief and ask
only necessary clarifying questions.

Output schema:

```json
{
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
      "id": "question_budget",
      "question": "string",
      "why_it_matters": "string"
    }
  ]
}
```

Prompt intent:

```text
You are the Intake Agent for an enterprise creative production workflow.
Extract concrete requirements from the raw brief. Ask clarifying questions only
when missing information would block planning. Return only valid JSON matching
the requested schema.
```

## Planning Agent

Responsibility: turn the structured brief into a workflow plan and production
milestones.

Output schema:

```json
{
  "scene_breakdown": [
    {
      "id": "scene_01",
      "title": "string",
      "purpose": "string",
      "duration_seconds": 6,
      "required_constraints": ["string"]
    }
  ],
  "workflow_tasks": [
    {
      "id": "task_shots",
      "title": "Generate scene and shot list",
      "agent_id": "shot_agent",
      "depends_on": ["task_planning"]
    }
  ]
}
```

Prompt intent:

```text
You are the Planning Agent. Create a practical production workflow that a brand
studio could review. Keep tasks explicit, dependent, and auditable. Return only
valid JSON matching the requested schema.
```

## Shot Agent

Responsibility: create a shot list that satisfies timing and brand constraints.

Output schema:

```json
{
  "shots": [
    {
      "id": "shot_001",
      "scene_id": "scene_01",
      "time_range": "0:00-0:03",
      "description": "string",
      "camera_direction": "string",
      "brand_requirement": "string"
    }
  ]
}
```

Prompt intent:

```text
You are the Shot Agent. Convert the scene plan into timed shots. Make sure the
product and CTA constraints are directly represented. Return only valid JSON
matching the requested schema.
```

## Asset Agent

Responsibility: extract every asset needed to execute the production plan.

Output schema:

```json
{
  "assets": [
    {
      "id": "asset_product_can",
      "type": "product | location | prop | wardrobe | sound | vfx | graphic",
      "name": "string",
      "usage": "string",
      "risk_notes": ["string"]
    }
  ]
}
```

Prompt intent:

```text
You are the Asset Agent. Build a production asset manifest from the brief,
scenes, and shots. Include usage notes and risks. Return only valid JSON
matching the requested schema.
```

## Prompt Agent

Responsibility: generate controlled prompts for media generation or downstream
creative tooling.

Output schema:

```json
{
  "prompts": [
    {
      "shot_id": "shot_001",
      "positive_prompt": "string",
      "negative_prompt": "string",
      "format_constraints": ["vertical 9:16", "30 second campaign context"],
      "continuity_constraints": ["string"]
    }
  ]
}
```

Prompt intent:

```text
You are the Prompt Agent. Create per-shot generation prompts that preserve
style, continuity, platform format, and brand constraints. Return only valid
JSON matching the requested schema.
```

## Critic Agent

Responsibility: inspect all artifacts and decide whether the package needs
human review before delivery.

Output schema:

```json
{
  "overall_status": "pass | needs_review",
  "findings": [
    {
      "id": "review_product_window",
      "severity": "low | medium | high",
      "title": "string",
      "body": "string",
      "target_task_ids": ["task_shots", "task_prompts"],
      "recommended_action": "approve | revise"
    }
  ],
  "approval_checklist": [
    {
      "item": "Product appears inside first 5 seconds",
      "status": "pass | fail | needs_review",
      "evidence": "string"
    }
  ]
}
```

Prompt intent:

```text
You are the Critic Agent. Review all generated artifacts against the structured
brief. Do not rewrite the package. Identify issues that should go to a human
reviewer and cite the affected tasks. Return only valid JSON matching the
requested schema.
```

## Policy Gate

Responsibility: deterministic validation before task state advancement.

Checks:

- Required JSON fields are present.
- `task_id` and `agent_id` match the assigned task.
- Required brief constraints are represented in downstream artifacts.
- High-severity findings cannot be auto-approved.
- Failed schema validation creates a `failed` task state and audit event.

## Human Review Rules

- `low` findings may be approved as-is.
- `medium` findings default to human review.
- `high` findings require revision before packet generation.
- A revision targets only the affected task IDs, not the whole workflow.

