# StudioFlow AI: All Things Agentic Hackathon Plan

Status: Draft
Hackathon: All Things Agentic Hackathon
Primary track: The Collaborative Partner (changed from Taskmaster — see below)
Architecture posture: Enterprise-grade agentic workflow
Deadline: 2026-09-01 08:00 GMT+8

## One-Line Pitch

StudioFlow AI turns an ambiguous creative brief into an auditable,
human-approved production package through asynchronous Gemini agents running on
Google Cloud.

## Product Positioning

StudioFlow AI is not an AI video generator. It is a creative operations system
for enterprise content teams: advertising agencies, brand studios, AI video
studios, and pre-production teams that need to move from a loose brief to a
production-ready plan.

The product demonstrates an agent that does real work:

- It clarifies missing requirements.
- It turns a brief into a structured project specification.
- It creates a task graph.
- It runs specialist agents asynchronously.
- It saves state and artifacts across the workflow.
- It sends risky or ambiguous outputs to human review.
- It emits a final production packet with an audit trail.

## Why This Fits The Hackathon

The hackathon rewards agents that move beyond chat and execute complex,
multi-step workflows. StudioFlow AI maps directly to that:

- **Operational utility:** reduces the messy handoff from creative brief to
  shot list, asset plan, risk review, and production packet.
- **Architectural discipline:** uses explicit agents, task states, persistent
  memory, audit logs, and human approval gates.
- **Production readiness:** deploys on Google Cloud and can show Cloud Run,
  Firestore, Pub/Sub, and logging evidence in the demo.

## Recommended Prize Strategy

Submit under **The Collaborative Partner**.

This plan originally said Taskmaster, and that was wrong. Taskmaster's judging
criterion asks whether the agent "completes a multi-step background workflow
**without human intervention**" — and the human review gate is this product's
entire thesis, so the strongest thing about it would have been scored against it.

Collaborative Partner asks for an agent that "asks clarifying questions, guides
the user step-by-step, and has a clear way to capture feedback, so it constantly
adapts to the user's unique way of thinking." Nothing had to be built to fit that
description; the clarification loop, the review queue, and the accumulation of the
reviewer's corrections in `run.enforce` were already there.

Each track has one winner and $20,000, and a submission is associated with exactly
one category, so this choice is worth more than any feature.

This keeps scope achievable while still showing:

- asynchronous background execution
- structured memory
- agent identity and responsibility boundaries
- auditable workflow state
- policy and review gates
- production-style Google Cloud deployment

## Target User

Primary user: a creative producer or brand content lead.

They receive a campaign or film brief and must coordinate multiple people,
documents, and approvals before production can begin.

Pain points:

- Briefs are incomplete or ambiguous.
- Shot lists, assets, prompts, risks, and approvals live in separate documents.
- Generative AI output drifts in style, continuity, and brand safety.
- Managers cannot quickly see which part of a project is blocked.
- It is hard to audit why a creative decision was made.

## MVP Workflow

```text
1. Intake
   User creates a project from a rough creative brief.

2. Clarify
   Intake Agent asks for missing constraints and turns answers into a structured
   project spec.

3. Plan
   Planning Agent creates a production workflow and task graph.

4. Execute
   Shot Agent, Asset Agent, and Prompt Agent generate artifacts in the
   background.

5. Review
   Critic Agent checks continuity, brand safety, missing shots, and weak
   production logic.

6. Approve
   Human reviewer approves, rejects, or requests revision.

7. Deliver
   System emits a production packet and an audit timeline.
```

## Core Objects

```text
Project
The top-level creative project.

Brief
The original and structured creative requirement.

Workflow
The ordered task graph produced by the Planning Agent.

Task
An asynchronous unit of agent work.

Artifact
Generated deliverables: shot list, asset manifest, prompt pack, risk report,
approval checklist, and production packet.

AuditEvent
A timestamped record of agent activity, state changes, user approvals, errors,
and artifact versions.
```

## Task States

Use one state model across all agents:

```text
queued
running
completed
needs_review
revision_requested
approved
failed
```

This state machine is central to the demo. The project should visibly behave
like a workflow system, not a single request/response app.

## Agent Network

### Root Orchestrator

Owns the workflow state, dispatches tasks, enforces dependencies, and decides
when to request human review.

### Intake Agent

Input: rough brief.

Output:

- structured creative brief
- missing fields
- clarifying questions
- constraints and success criteria

### Planning Agent

Input: structured brief.

Output:

- scene breakdown
- production milestones
- task graph
- expected artifacts

### Shot Agent

Input: scene breakdown.

Output:

- shot list
- camera direction
- visual intent
- timing notes

### Asset Agent

Input: structured brief, scenes, and shots.

Output:

- character list
- location list
- props
- sound and music needs
- visual effects needs
- generated-media prompt requirements

### Prompt Agent

Input: shot list and asset manifest.

Output:

- image prompts
- video prompts
- negative prompts
- per-shot style constraints

### Critic Agent

Input: all current artifacts.

Output:

- continuity issues
- missing product or brand requirements
- weak CTA or unclear story beats
- compliance and risk notes
- revision requests

### Policy Gate

Deterministic guardrail layer, not necessarily an LLM agent.

Checks:

- missing required fields
- sensitive or disallowed content
- human approval requirements
- artifact schema validity

### Audit Logger

Records:

- task creation
- task status changes
- agent input and output summaries
- error messages
- artifact versions
- approval decisions

## Proposed Google Cloud Architecture

```text
Web Dashboard
  |
  v
Cloud Run API
  |
  v
Workflow Orchestrator
  |
  +--> Firestore
  |      - projects
  |      - briefs
  |      - tasks
  |      - artifacts
  |      - audit events
  |
  +--> Pub/Sub
  |      - task dispatch
  |      - revision jobs
  |
  +--> Cloud Run Worker
         |
         v
       Google ADK / GenAI SDK + Gemini
         |
         v
       Cloud Storage
         - production packets
         - generated previews
         - exported files

Cloud Logging / Trace captures runtime proof for the demo.
Secret Manager stores model and service credentials.
```

## Technology Choices

Preferred stack:

- Frontend: Next.js or the existing app frontend if one is added later.
- Backend: FastAPI or Node.js API.
- Agent framework: Google ADK first; GenAI SDK acceptable for narrow worker calls.
- Model: Gemini 3.5 or later through Gemini API or Vertex AI.
- Deployment: Cloud Run.
- State: Firestore.
- Async: Pub/Sub or Cloud Tasks.
- Artifacts: Cloud Storage.
- Secrets: Secret Manager.
- Observability: Cloud Logging and trace IDs stored on audit events.

## MVP Pages

### Dashboard

Shows projects and status.

### Project Workspace

Shows:

- original brief
- structured brief
- workflow timeline
- current tasks
- generated artifacts

### Review Queue

Shows Critic Agent findings and lets a human approve, reject, or request
revision.

### Production Packet

Shows final deliverables:

- executive summary
- structured creative brief
- scene breakdown
- shot list
- asset manifest
- prompt pack
- continuity report
- brand/compliance risk report
- approval checklist
- audit timeline

## Demo Scenario

Use a brief that is visual, constrained, and easy to understand quickly:

```text
Create a 30-second launch film for a premium canned coffee brand entering the
Tokyo night market.

Audience:
Young urban professionals.

Style:
Neon realism, cinematic, energetic.

Constraints:
- Show the product in the first 5 seconds.
- Avoid health claims.
- Include a clear CTA.
- Deliver for Instagram Reels.
```

## Four-Minute Demo Script

```text
0:00 - 0:25
Problem: creative teams lose time converting messy briefs into production plans.

0:25 - 0:55
Create a new project from the Tokyo canned coffee brief.

0:55 - 1:25
Intake Agent asks clarifying questions and creates a structured brief.

1:25 - 2:05
Planning Agent creates the task graph. Specialist agents run asynchronously.

2:05 - 2:55
Artifacts appear: scene breakdown, shot list, asset manifest, prompt pack.

2:55 - 3:25
Critic Agent flags issues: product appears too late, CTA is weak, one visual
motif drifts from the brand style.

3:25 - 3:45
Human requests revision. The affected tasks rerun and the audit log updates.

3:45 - 4:00
Show final production packet and Google Cloud evidence: Cloud Run, Firestore,
Pub/Sub/logs, and architecture diagram.
```

## Devpost Submission Checklist

- Hosted project URL, preferably Cloud Run.
- Public code repository.
- README with local setup and cloud deployment instructions.
- Architecture diagram.
- Four-minute demo video.
- Clear proof that the backend ran on Google Cloud.
- Project description with:
  - problem
  - value proposition
  - features
  - technology stack
  - data sources
  - learnings
- Optional public build post or social post with
  `#AllThingsAgenticHackathon`.

## Build Plan

### Phase 1: Product Skeleton

- Create README and product spec.
- Define project, task, artifact, and audit schemas.
- Build static demo data for one project.
- Implement basic dashboard and project workspace.

### Phase 2: Agent Workflow

- Implement Intake, Planning, Shot, Asset, Prompt, and Critic prompts.
- Add schema validation for all agent outputs.
- Add local async execution first.
- Store task and artifact state.

### Phase 3: Enterprise Layer

- Add review queue.
- Add approval and revision flow.
- Add audit events.
- Add policy checks.
- Add trace IDs or request IDs per workflow run.

### Phase 4: Google Cloud Proof

- Deploy API and worker on Cloud Run.
- Store state in Firestore.
- Dispatch tasks through Pub/Sub or Cloud Tasks.
- Store packets in Cloud Storage.
- Capture Cloud Logging screenshots or video segments.

### Phase 5: Submission Polish

- Finalize architecture diagram.
- Write Devpost copy.
- Record demo video.
- Add public social or blog post for bonus credit.

## Scope Guardrails

Build the workflow system first. Do not let the project collapse into a video
generator.

Keep:

- task graph
- async execution
- artifact generation
- review queue
- audit log
- cloud proof

Cut first if needed:

- real video generation
- complex collaboration roles
- advanced permissions
- PDF export
- multiple project templates
- visual asset generation

Never cut:

- working demo
- README
- architecture diagram
- Google Cloud evidence
- human approval loop

