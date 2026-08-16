# Demo script — 4 minutes, one take

The rules require **unedited live execution** and proof the backend is running on
Google Cloud. That makes this a rehearsal sheet, not a storyboard: no cut can save a
step that hangs, so every step below is either instant or has a stated fallback.

Target **3:40**, hard ceiling 4:00. The margin is for speaking slower than you plan to.

Narration is ~470 words. At a deliberate 135 wpm that is 3:29 of talking, which is the
budget. If you are running long, the artifact tour (1:15–1:45) is the only section that
can be cut on the fly without losing a scoring criterion.

---

## Pre-flight — do all of this before you hit record

**The deployment**

- [ ] `gcloud run services update studioflow-ai --region us-central1 --min-instances=1`
      — a cold start mid-demo is the most likely way this take dies. **Set it back to
      `0` after recording.**
- [ ] Load the deployed URL once and run one full workflow, to warm the container and
      confirm the build actually works. Then reload for a clean state.
- [ ] `curl <URL>/api/health` — confirm `"intake_provider": "gemini"`. If it says
      `local`, the key is not reaching the container and the "powered by Gemini" claim
      is not demonstrable. Fix before recording.

**The screen**

- [ ] Browser zoom ~125%. The task graph and the review queue have to be readable at
      video resolution — this is the single most common reason a good demo scores badly
      on presentation.
- [ ] Tabs, pre-opened, in this order: **1** the app · **2** `/api/health` · **3** Cloud
      Run console (service detail page) · **4** Cloud Logging, query already typed and
      run, filtered by the service. Do not type a query on camera.
- [ ] The brief text below already in the clipboard. Do not type it on camera — typing
      30 seconds of prose is 30 seconds of nothing happening.
- [ ] Close notifications, other windows, and anything with a personal name in it.

**Rehearse the whole thing twice.** The point of rehearsal is not the words, it is
knowing how long the run actually takes so you are not narrating into silence.

---

## The brief (clipboard)

Verified to produce exactly two findings — one `high`, one `medium` — which is what the
script below depends on. Do not improvise a different brief on camera.

```text
Create a 30-second launch film for a premium canned coffee brand entering the Tokyo night market.
Audience: Young urban professionals.
Style: Neon realism, cinematic, energetic.
Constraints: Show the product in the first 5 seconds, avoid health claims, include a clear CTA, deliver for Instagram Reels.
```

---

## The script

### 0:00–0:25 · Problem

**Screen:** the app, idle, on the deployed URL. **The URL bar must be visible and legible.**

> A creative brief arrives as a paragraph of prose. Somewhere inside it are constraints:
> show the product in the first five seconds, avoid health claims, include a call to
> action. Turning that into a shot list, an asset plan and a prompt pack takes a
> producer days — and the part that actually goes wrong is that a stated constraint
> quietly fails to survive the process. Nobody notices until the edit.

### 0:25–0:45 · What this is, and proof it is live

**Screen:** switch to tab 2, `/api/health`. Let the JSON sit on screen for three seconds.

> StudioFlow AI is not a video generator. It is a workflow system that produces a
> production packet in which every stated constraint has been checked — and every failed
> check is traceable to the agent that caused it and the rerun that fixed it. This is
> running on Cloud Run, and the health endpoint reports which model is actually live:
> Gemini three-point-six Flash, through the Google GenAI SDK.

**Point at `"intake_provider": "gemini"` with the cursor.** That single field is the
"powered by Gemini" claim, evidenced rather than asserted.

### 0:45–1:15 · Paste the brief, watch the graph move

**Screen:** back to tab 1. Paste. Click **Run Workflow**.

> I paste the brief and start the run. The API returns immediately with every task
> queued — the work happens in the background, and the client polls. Watch the task
> graph: Intake, Planning, Shot, Asset, Prompt, Critic, one at a time.

**Say nothing for the ~3 seconds the graph is advancing. Let it be watched.**

> Only Intake calls a model — it turns the prose into a structured brief. The four
> production agents are deterministic, which is deliberate: I would rather the checking
> be trustworthy than the prose be pretty.

### 1:15–1:45 · Artifacts *(cut this section first if running long)*

**Screen:** the artifact list. Open the shot list.

> Six artifacts, each generated from this brief — nothing here is canned. Each one
> carries where it came from, so provenance is visible rather than implied. The shot
> list opens on atmosphere and reveals the product at ten seconds.

**Leave the shot list open. The next section refers to it.**

### 1:45–2:25 · The Critic — this is the product

**Screen:** the review queue, both findings visible.

> The Critic checked the artifacts against the brief and stopped the run. Two findings.
> The first: the brief demanded the product inside five seconds, and the reveal landed
> at ten. It found that by reading the generated shot list, not by restating the brief
> back to me — and it names the two agents responsible.
>
> It is just as important that this queue is short. Twelve checks ran against these
> artifacts. Ten found nothing, because this brief gave them nothing to check. A review
> queue is only worth reading if everything in it is real.

*(Twelve is `CHECKS.length` in `critic-checks.js` — a judge can count them. Do not
round it up to the fifteen finding types the README table lists; those are the shapes a
finding can take, not the number of checks that ran.)*

### 2:25–3:00 · Revise — the artifact actually changes

**Screen:** click **Revise** on "Subject appears too late". Then show the shot list again.

> I request a revision. The finding carries the constraint that fixes it, so the system
> reruns only the two agents it named, with that constraint enforced.
>
> The shot list is now version two — and the first shot is the product, at zero seconds,
> unobstructed. The content changed, not just the version number. That is the difference
> between a review gate and a checkbox.

### 3:00–3:20 · Approve, packet, audit trail

**Screen:** approve the second finding. Show the packet, then the audit trail.

> I approve the second finding, the run closes, and the packet is regenerated. And the
> whole thing is on the record: agent actions and human decisions, distinguished, in
> order — who reran what, and why.

### 3:20–3:45 · Google Cloud proof

**Screen:** tab 3, Cloud Run service page — service name, region, revision, URL all
visible. Then tab 4, Cloud Logging, already filtered.

> Running on Cloud Run, built with Cloud Build from the repository. Every task, artifact
> and audit event carries a trace ID, so a single run is one filter away in Cloud
> Logging.

**Scroll the log list once, slowly. Do not click into an entry** — that is a page load
you cannot afford.

### 3:45–3:55 · Close

**Screen:** back to the packet.

> A brief in, a checked production packet out, with the reason for every change kept.
> StudioFlow AI.

---

## If something goes wrong mid-take

You cannot cut, so decide these now rather than freezing on camera.

| What happens | What you do |
| --- | --- |
| The run hangs past ~10 seconds | Say "the container is waking up" and wait. It resolves or it does not; if it does not, stop and restart the take. Do not narrate over a frozen screen for 30 seconds. |
| `/api/health` says `local` | **Stop. Do not record.** The central claim is not demonstrable. Fix the secret binding first. |
| Findings come back different from two | You changed the brief. Stop, restore the exact text above, restart. |
| A poll 404s | You are on more than one instance. `--max-instances=1` was not applied. Stop and fix. |
| You fluff a sentence | Keep going. It is a technical demo, not a performance. Restarting costs more than a stumble. |

---

## Things not to say

The video is a claim, and everything in it has to survive a judge opening the repo.

- **Do not say Firestore, Pub/Sub, or Cloud Storage.** None are wired up. The
  architecture diagram draws them dashed for exactly this reason.
- **Do not call the four production agents "AI agents"** in a way that implies they call
  a model. They do not. Saying so out loud, as the script does, is a strength — it is
  what makes the Gemini claim credible.
- **Do not describe the generated prose as good.** It is templated and a judge will see
  that. The script gets ahead of it by saying the checking is the point.
- **Do not promise the roadmap.** Nobody is scoring what you plan to build.
