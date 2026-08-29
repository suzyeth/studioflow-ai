# Demo script — 4 minutes, one take

Track: **The Collaborative Partner**. The demo has to show the agent *collaborating* —
asking, being answered, being corrected, and carrying the correction forward — not just
executing. It adapts to the user **twice** on camera, which is the whole thesis of the
track. Everything else is supporting evidence.

The rules require **unedited live execution** and proof the backend is running on
Google Cloud. That makes this a rehearsal sheet, not a storyboard: no cut can save a
step that hangs, so every step below is either instant, or has narration sized to
cover it, or has a stated fallback.

Target **3:45**, hard ceiling 4:00. Narration is ~500 words; at a deliberate 135 wpm
that is 3:42, leaving the margin for pauses rather than for extra sentences. **If you
are running long, cut from the Cloud proof section — never from the clarification loop
or the revision.**

## The one piece of choreography that matters

The Veo render takes **60–90 seconds**. You do not wait for it. You start it, then go
and do the delivered-cut audit and the Cloud proof while it runs in the background, and
come back to it. That is not a workaround — background execution is this hackathon's
entire theme, and a demo that shows a real 90-second job being tracked while you do
something else is worth more than one that shows a fast result.

---

## Pre-flight — do all of this before you hit record

**The deployment**

- [ ] `gcloud run services update studioflow-ai --region us-central1 --min-instances=1`
      — a cold start mid-demo is the most likely way this take dies. **Set it back to
      `0` after recording.**
- [ ] Run one full workflow on the deployed URL, including a render, to warm the
      container and the model path. Then reload for a clean state.
- [ ] `curl <URL>/api/health` — confirm `"runtime": "cloud-run"`,
      `"intake_provider": "gemini"`, `"store": {"mirror": "firestore"}`, and
      `"render": {"enabled": true}`. If the provider says `local`, **stop and fix it**;
      the central claim is not demonstrable.
- [ ] **Then run one workflow and check `parsed_by` on the result.** Health reports the
      *configured* provider, not a working one: a failing call degrades to the keyless
      parser silently while health still says `gemini`. `parsed_by: gemini` on an actual
      run is the only real confirmation.

**The screen**

- [ ] Browser zoom ~125%. The task graph, the review queue and the verdict lists have
      to be readable at video resolution.
- [ ] Tabs, pre-opened, in this order: **1** the app · **2** `/api/health` · **3** Cloud
      Run console (service detail) · **4** Cloud Logging, query already typed and run ·
      **5** the app again, showing a **completed render from your rehearsal run** — this
      is the fallback if the live render is slow. Do not type a query on camera.
- [ ] The brief below already in the clipboard, and `Young urban professionals` in a
      second clipboard slot.
- [ ] **A video file on the desktop for the delivered-cut upload**, renamed to something
      that reads on camera, e.g. `final-cut-v3.mp4`. Any of the clips this system has
      rendered works. Under 15MB.
- [ ] Close notifications, other windows, and anything with a personal name in it.

**Rehearse the whole thing twice.** The point is not the words, it is knowing how long
each step actually takes so you are never narrating into silence.

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

---

## The script

### 0:00–0:18 · Problem

**Screen:** the app, idle, on the deployed URL. **The URL bar must be visible.**

> A brief arrives as prose. Buried in it are constraints — product in five seconds, no
> health claims, a clear call to action. What costs money is one of them quietly not
> surviving into the shot list, the prompts, and the final cut. Nobody notices until
> the edit.

### 0:18–0:32 · Proof it is live

**Screen:** tab 2, `/api/health`. Let the JSON sit for three seconds.

**Point the cursor at these in order:** `"runtime": "cloud-run"`, `"revision"`,
`"intake_provider": "gemini"`, `"store": {"mirror": "firestore"}`.

> Cloud Run, this revision, Gemini through the Google GenAI SDK, every run mirrored to
> Firestore. Runtime and revision come from variables only Cloud Run injects —
> evidence, not a string I typed.

### 0:32–1:00 · Paste the brief, watch the graph move

**Screen:** tab 1. Paste. Click **Run Workflow**.

⚠️ **Intake takes ~4.5 seconds** on `gemini-3.5-flash-lite`. Start speaking as you
click, not after.

> The API returns immediately with everything queued — the work runs in the background
> and the client polls. Two of the six agents call a model: Intake structures the brief,
> the Shot Agent writes the descriptions. The other four are deterministic on purpose —
> the Critic's checks have to be exact, not plausible.

**Let the last tasks land in silence.** They finish in milliseconds and the contrast is
worth seeing.

### 1:00–1:28 · It asks. You answer. It adapts. *(never cut this)*

**Screen:** the clarifying question.

> The brief never said who this is for. Rather than invent an audience, it asked — and
> it names the field the answer fills and why it blocks planning.

**Answer `Young urban professionals`. Submit.** ⚠️ Second ~4.5s wait — cover it:

> The answer folds back in as a labelled line, so intake reads it the way it read the
> original prose, and the whole workflow reruns.

**Screen:** the queue is now two findings.

> Three findings became two. The one that vanished is the one I resolved.

### 1:28–1:55 · The Critic, and a revision that actually changes something

**Screen:** review queue. Then click **Revise** on "Subject appears too late".

> The two that remain are real. The brief demanded the product inside five seconds; the
> reveal landed at ten — found by reading the generated shot list. Fifteen checks ran;
> thirteen found nothing, because this brief gave them nothing to check.
>
> I request a revision. It reruns only the agents the finding names, with that
> constraint enforced — shot list version two, product at zero seconds. The content
> changed, not just the number. And the correction is kept as state for every later
> rerun.

### 1:55–2:10 · Approve, and start the render

**Screen:** approve the second finding → packet appears. Scroll to **Hero Shot Render**
and click **Render with Veo**.

> Approved, packet regenerated. And the packet is not just a deliverable, it is the
> instruction: I render its hero shot with Veo, using the packet's own prompt and the
> negative prompts inherited from the brief. Nothing renders before approval — the
> button does not exist until the queue is empty.

**The clock is now running. Do not wait. Move on.**

### 2:10–2:55 · While it renders: audit a delivered cut

**Screen:** scroll to **Audit a Delivered Cut**. Choose `final-cut-v3.mp4`. Click
**Audit with Gemini**.

> That render is a real ninety-second job running in the background. While it works —
> the editor's delivered cut comes back, and it gets checked twice.

**Wait for the verdicts (~15–40s), then read from the screen:**

> Against the brief: the same constraints judged from footage, each with evidence — and
> *cannot tell* where the picture genuinely cannot answer.
>
> Then against the shot list I approved. Not the model's taste — the six shots a human
> signed off on. It found one, and names what it expected and did not see for the rest.
> An unapproved shot would be listed too.

### 2:55–3:15 · Google Cloud proof *(cut this first if long)*

**Screen:** tab 3, Cloud Run service page. Then tab 4, Cloud Logging, already filtered.

> Every task, artifact and audit event carries a trace ID, so one run is a single filter
> away — and runs survive a restart, because the store is mirrored to Firestore.

**Scroll the log list once, slowly. Do not click into an entry.**

### 3:15–3:40 · Back to the render

**Screen:** tab 1, scroll to the render panel.

**Plan A — it finished:**

> And here it is — rendered from the approved packet, then audited in turn: the clip
> against the checks a single shot can fairly answer, with the ones it cannot listed
> explicitly. A silently skipped check reads exactly like one that passed.

**Plan B — still rendering (this is not a failure, say it with confidence):**

> Still working — a real ninety-second job. The operation id lives on the run record,
> mirrored to Firestore, so it survives me closing this tab. Here is the same step from
> a run I made a few minutes ago —

**switch to tab 5** and read the Plan A lines off that screen. Say plainly that it is an
earlier run. An honest cutaway costs nothing; pretending costs everything.

### 3:40–3:50 · Close

**Screen:** back to the packet.

> A brief in, a checked packet out, a rendered shot checked against it, and a delivered
> cut checked against the shot list that was approved. Every step on the record.

---

## If something goes wrong mid-take

You cannot cut, so decide these now rather than freezing on camera.

| What happens | What you do |
| --- | --- |
| `/api/health` says `local` | **Stop. Do not record.** The central claim is not demonstrable. Fix the secret binding first. |
| The run hangs past ~20 seconds | Intake is ~4.5s, so do not panic early. Past twenty, say "the container is waking up" and wait. If it does not resolve, stop and restart the take. |
| No clarifying question on the first run | You pasted a brief containing the audience line. Stop, restore the exact text above, restart — the middle of the script depends on being asked. |
| Findings are not three then two | You changed the brief. Stop, restore, restart. |
| The render button is missing | The queue is not empty. Rendering is gated on approval by design — close the remaining item. |
| The render fails or is filtered | Say what the screen says. A safety-filtered clip is a real outcome the system reports honestly; do not talk over it. Then go to tab 5. |
| The upload audit is skipped | Read the reason aloud. "It could not audit, and it says why" is a better look than pretending it did. |
| A poll 404s | You are on more than one instance. `--max-instances=1` was not applied. Stop and fix. |
| You fluff a sentence | Keep going. It is a technical demo, not a performance. |

---

## Things not to say

The video is a claim, and everything in it has to survive a judge opening the repo.

- **Do not say Pub/Sub or Cloud Storage.** Neither is wired up; the job queue is
  in-process and the architecture diagram draws them dashed for exactly this reason.
  (Firestore *is* wired up now — say it.)
- **Do not call Planning, Asset, Prompt or Critic "AI agents"** in a way that implies
  they call a model. They do not, and saying so out loud is a strength — it is what
  makes the Gemini claim credible.
- **Do not claim frame-accurate cut detection.** The conformance audit matches by
  content, its statuses are coarse on purpose, and it reports timing without failing it.
  The UI says so; the narration must not contradict the UI.
- **Do not describe a verdict as a decision.** Every audit is advisory — a fail marks
  footage, it never blocks or deletes it. The human decides.
- **Do not promise the roadmap.** Nobody is scoring what you plan to build.
