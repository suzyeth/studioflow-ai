# StudioFlow AI Data Model

This document defines the MVP objects used by the static prototype and the
future API/Firestore implementation.

## Project

```json
{
  "id": "proj_tokyo_coffee",
  "title": "Tokyo Night Market Coffee",
  "status": "draft | running | needs_review | approved | failed",
  "track": "The Collaborative Partner",
  "created_at": "2026-08-10T00:00:00Z",
  "updated_at": "2026-08-10T00:00:00Z"
}
```

## Brief

```json
{
  "project_id": "proj_tokyo_coffee",
  "raw_text": "Create a 30-second launch film...",
  "structured": {
    "goal": "30-second launch film",
    "audience": "Young urban professionals",
    "platform": "Instagram Reels",
    "style": "Neon realism, cinematic, energetic",
    "constraints": [
      "Product visible in first 5 seconds",
      "No health claims",
      "Clear CTA"
    ]
  },
  "clarifying_questions": []
}
```

## Task

```json
{
  "id": "task_intake",
  "project_id": "proj_tokyo_coffee",
  "agent_id": "intake_agent",
  "title": "Clarify creative requirements",
  "state": "queued | running | completed | needs_review | revision_requested | approved | failed",
  "depends_on": [],
  "artifact_ids": ["artifact_structured_brief_v1"],
  "created_at": "2026-08-10T00:00:00Z",
  "updated_at": "2026-08-10T00:00:00Z"
}
```

## Agent

```json
{
  "id": "intake_agent",
  "name": "Intake Agent",
  "responsibility": "Convert raw creative input into a structured brief.",
  "model": "gemini-3.5-flash-or-newer",
  "framework": "google-adk"
}
```

## Artifact

```json
{
  "id": "artifact_shot_list_v1",
  "project_id": "proj_tokyo_coffee",
  "task_id": "task_shots",
  "type": "shot_list",
  "version": 1,
  "title": "Shot List",
  "summary": "Eight timed shots covering product reveal and CTA.",
  "content_markdown": "- 0:00-0:03 Product can...",
  "storage_uri": "gs://studioflow-packets/proj_tokyo_coffee/shot-list-v1.md"
}
```

## Review Item

```json
{
  "id": "review_product_window",
  "project_id": "proj_tokyo_coffee",
  "source_agent_id": "critic_agent",
  "severity": "medium",
  "title": "Product visibility risk",
  "body": "The product hero shot lands at 5.8 seconds.",
  "state": "open | approved | revision_requested | closed",
  "target_task_ids": ["task_shots", "task_prompts"]
}
```

## Audit Event

```json
{
  "id": "audit_001",
  "project_id": "proj_tokyo_coffee",
  "actor_type": "agent | user | system",
  "actor_id": "critic_agent",
  "event_type": "task_started | task_completed | review_opened | revision_requested | artifact_created",
  "message": "Critic Agent routed 3 findings to human review.",
  "trace_id": "run-2026-08-10-001",
  "created_at": "2026-08-10T00:00:00Z"
}
```

## Firestore Collection Sketch

```text
projects/{projectId}
projects/{projectId}/briefs/{briefId}
projects/{projectId}/tasks/{taskId}
projects/{projectId}/artifacts/{artifactId}
projects/{projectId}/reviews/{reviewId}
projects/{projectId}/audit_events/{auditEventId}
agents/{agentId}
```

The static prototype keeps these objects in `data.js`; the cloud version should
preserve the same shapes so UI and demo copy remain stable.

## API Shape

```text
GET  /api/health
GET  /api/demo
POST /api/workflow/run
GET  /api/workflow/:traceId
POST /api/workflow/:traceId/reviews/:reviewId
```

Review action request:

```json
{
  "action": "approve | revise"
}
```

The local server stores runs in memory. The Cloud Run version should persist the
same run shape in Firestore and use `trace_id` as the visible demo correlation
key across tasks, audit events, and Cloud Logging.
