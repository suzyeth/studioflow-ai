# Demo script — 4 minutes, one take

Track: **The Collaborative Partner**. The demo has to show the agent *collaborating* —
asking, being answered, being corrected, and carrying the correction forward — not just
executing. It adapts to the user **twice** on camera, which is the whole thesis of the
track. Everything else is supporting evidence.

The rules require **unedited live execution** and proof the backend is running on
Google Cloud. That makes this a rehearsal sheet, not a storyboard: no cut can save a
step that hangs, so every step below is either instant or has a stated fallback.

Target **3:40**, hard ceiling 4:00. The margin is for speaking slower than you plan to.

Narration is ~560 words. At a deliberate 135 wpm that is 4:09 — **over the ceiling.**

It used to be that two ~10s model waits absorbed the overrun. Switching to
`gemini-3.5-flash-lite` cut those to ~4.5s each, which is better for the demo and
worse for the script: there are now only ~9 seconds of latency to speak over instead
of ~20. **The narration has to lose 25–40 words.** Read it aloud with a timer, and cut
from the second half of the Critic section (the "fifteen checks" lines) — never the
clarification loop or the revision, which are the track.

**Two four-second waits, both narrated.** Intake is the only step that calls a model,
it takes ~4.5s against `gemini-3.5-flash-lite`, and it runs twice: once on the first pass and
once when the clarifying answer reruns the workflow. Everything else finishes in
milliseconds. Those two gaps are budgeted as speaking time, not as pauses.

---

## Pre-flight — do all of this before you hit record

**The deployment**

- [ ] `gcloud run services update studioflow-ai --region us-central1 --min-instances=1`
      — a cold start mid-demo is the most likely way this take dies. **Set it back to
      `0` after recording.**
- [ ] Load the deployed URL once and run one full workflow, to warm the container and
      confirm the build actually works. Then reload for a clean state. **This also warms
      the model path** — the first call of the day is the slowest one.
- [ ] `curl <URL>/api/health` — confirm `"runtime": "cloud-run"` **and**
      `"intake_provider": "gemini"`. If the provider says `local`, the key is not
      reaching the container. Fix before recording.
- [ ] **Then run one workflow and check `parsed_by` on the result.** Health reports the
      *configured* provider, not a working one: a failing call degrades to the keyless
      parser silently while health still says `gemini`. That happened on the first
      deploy. `parsed_by: gemini` on an actual run is the only real confirmation.

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

**The audience line is missing on purpose.** That is what makes the agent ask, which is
the track's whole thesis. Do not improvise a different brief on camera — the timings
below depend on this one producing exactly one question and, after it is answered,
exactly two findings.

```text
Create a 30-second launch film for a premium canned coffee brand entering the Tokyo night market.
Style: Neon realism, cinematic, energetic.
Constraints: Show the product in the first 5 seconds, avoid health claims, include a clear CTA, deliver for Instagram Reels.
```

Verified behaviour, which the script narrates:

| | Questions | Findings |
| --- | --- | --- |
| First run | 1 — Audience | `hero-window`, `missing-cta`, **`open-questions`** |
| After answering `Young urban professionals` | 0 | `hero-window`, `missing-cta` |

The second answer to have ready, in a second clipboard slot or typed live (it is three
words): `Young urban professionals`

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

> StudioFlow AI is not a video generator. It is a collaborator: it reads the brief, asks
> for what is missing, produces a production packet, and shows you where the packet
> failed the brief — then takes your correction and carries it forward. This is running
> on Cloud Run — and the health endpoint proves both halves of that sentence at once.

**Point the cursor at these four lines in order:** `"runtime": "cloud-run"`,
`"revision"`, `"intake_provider": "gemini"`, `"intake_model"`. That one response is
the entire deployment claim. `runtime` and `revision` come from environment variables
only Cloud Run injects, which is what makes them evidence rather than a string
somebody typed.

> Running on Cloud Run, on this revision, backed by Gemini three-point-five
> Flash-Lite through the Google GenAI SDK.

### 0:45–1:15 · Paste the brief, watch the graph move

**Screen:** back to tab 1. Paste. Click **Run Workflow**.

> I paste the brief and start the run. The API returns immediately with every task
> queued — the work happens in the background, and the client polls.

⚠️ **Intake takes about four and a half seconds on the deployed service** (measured
4.1–4.7s across 8 runs on `gemini-3.5-flash-lite`), against under three for the whole graph on the keyless path. Do
not wait it out in silence — five seconds of dead air is still a long time on camera, and
there is no cut available to hide it. **Talk through it.** The lines below are written
to fill exactly that gap, so deliver them while Intake is spinning:

> Intake is the only step that calls a model, and it is working now — turning a
> paragraph of prose into a structured brief with typed fields, validated against a
> schema before it is allowed to become an artifact.
>
> The four production agents behind it are deterministic generators, and that is a
> deliberate choice rather than a shortcut. I would rather the checking be trustworthy
> than the prose be pretty — and it is why I can tell you exactly what the model did
> and did not decide.

**By now the graph should be moving.** Let the last few tasks land while you stop
talking — they finish in milliseconds, and that contrast is worth seeing.

### 1:15–1:50 · It asks. You answer. It adapts. *(the track's thesis — never cut this)*

**Screen:** the clarifying question, then the review queue showing three findings.

> It did the work — six artifacts, each generated from this brief, each carrying where
> it came from. But notice what else it did. The brief never said who this is for, and
> rather than quietly inventing an audience, it asked — and it says which field the
> answer fills and why it blocks planning. Its own Critic then flagged the run as
> proceeding on incomplete information.

**Answer the question: `Young urban professionals`. Submit.**

⚠️ **This is the second four-second wait.** Answering reruns the whole workflow, which
means Intake calls the model again. The lines below are sized to cover it — start
speaking as soon as you submit, not after.

> I answer, and the answer is folded back into the brief as a labelled line, so intake
> reads it exactly the way it read the original prose. The whole workflow reruns,
> because everything downstream of intake depends on it — you cannot plan shots for an
> audience you learned about after the shots were planned.

**Screen:** the queue is now two findings.

> Three findings became two. The one that disappeared is the one I just resolved.

### 1:50–2:25 · The Critic — what a single prompt cannot do

**Screen:** the review queue, both remaining findings visible.

> The two that remain are real. The brief demanded the product inside five seconds, and
> the reveal landed at ten. It found that by reading the generated shot list, not by
> restating the brief back to me — and it names the agents responsible.
>
> It matters just as much that this queue is short. Fifteen checks ran against these
> artifacts. Thirteen found nothing, because this brief gave them nothing to check. A review
> queue is only worth reading if everything in it is real.

*(Fifteen is `CHECKS.length` in `critic-checks.js` — a judge can count them. Do not
confuse it with the number of finding types; these are the checks that ran.)*

### 2:25–3:00 · Revise — the artifact actually changes

**Screen:** click **Revise** on "Subject appears too late". Then show the shot list again.

> I request a revision. The finding carries the constraint that fixes it, so the system
> reruns only the two agents it named, with that constraint enforced.
>
> The shot list is now version two — and the first shot is the product, at zero seconds,
> unobstructed. The content changed, not just the version number.
>
> And the correction is kept. It is not applied once and forgotten — it is held as state
> and carried into every later rerun, so the system does not need to be told the same
> thing twice. That is the second time in four minutes it adapted to me: once from a
> question I answered, once from a correction I made.

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
| The run hangs past ~20 seconds | Intake against a real model is ~4.5s, so do not panic early. Past twenty, say "the container is waking up" and wait. It resolves or it does not; if it does not, stop and restart the take. Do not narrate over a frozen screen for 30 seconds. |
| `/api/health` says `local` | **Stop. Do not record.** The central claim is not demonstrable. Fix the secret binding first. |
| The first run shows no clarifying question | You pasted a brief that has the audience line. Stop, restore the exact text above, restart — the middle of the script depends on being asked. |
| The first run shows more than one question | Same cause, different direction: the brief lost more than the audience line. |
| Findings are not three then two | You changed the brief. Stop, restore, restart. |
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
