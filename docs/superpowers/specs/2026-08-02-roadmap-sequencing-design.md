# Roadmap sequencing: proactivity, floating window, visual support — Design Spec

- **Date:** 2026-08-02 (reconciled against shipped M2 on 2026-08-03)
- **Status:** Sequencing approved by the owner. M2 has since shipped on `main`; §4.2 and §5 record obligations it did **not** take on, which now belong to M8. See §10.
- **Owner:** SpeakUp (C:\talker)
- **Relates:** blocks nothing in M7 slices 1–3; creates M8 and a conditional M9. M2's own design lives in [`2026-08-02-m2-structured-feedback-design.md`](2026-08-02-m2-structured-feedback-design.md).

> **Reconciliation note.** This document was written before M2 was implemented and assumed M2 would
> absorb two obligations from it: the state-machine-aware feedback panel (§4.2) and the opening-seed
> seam (§5). Shipped M2 took neither. Rather than rewrite the reasoning — which still holds — §10
> records what is actually true in the tree and where each obligation went.

---

## 1. Context

Three capabilities were proposed together:

- **A. Sourced proactivity** — point the coach at a YouTube channel (or several sources) so it opens with something concrete from a recent video, asks for an opinion, and sustains an informed conversation instead of generic prompts.
- **B. Floating desktop window** — a small always-visible pane for live captions, links, images and other support.
- **C. Visual support for what is being said** — read the correct form of what you just said wrong, or the phrasing a native would have used, without stopping to look for it.

The question was the order relative to **M2 (structured feedback)**, which is designed but has zero lines of code.

This document decides the order and the seams. It deliberately does **not** design A or B.

---

## 2. Decision

```
M2  (structured feedback, with C folded in)   ← next, unchanged in priority
M8  (sourced proactivity = A)
M9  (floating window = B)                     ← conditional; may be cancelled by evidence
```

**C is not a milestone.** It is dissolved into M2. See §4.

---

## 3. Rationale

### 3.1 M2 first, because M2 is the instrument that tells you whether A worked

A's premise is pedagogical, not technical: *a topic I have opinions about makes me produce more language, and harder language, than "tell me about your day."* That is a falsifiable claim, and the signals that falsify it — words per turn, the hesitation index, the ratio of mid-phrase to clause-boundary pauses — are exactly what M2 and M7 slice 1 produce.

Building A before M2 means building it with no way to know it helped. Principle 5 (honesty of measurement) and M2's own locked decision — *first measure, then decide whether the signal is stable* — both point the same way.

This is the strongest argument of the three and it survives if the other two fail.

### 3.2 M2 has to cut the hole that A plugs into

M2's open case (a) — *if I open the app and say nothing, the coach speaks first with a concrete question, never "what do you want to talk about?"* — is precisely A's output slot. M2 must define that interface and fill it with something fixed. A then becomes one more provider behind it, with the same factory-plus-degraded-state shape as `brain/`, `tts/`, `stt/`, `pronunciation/`.

Designing the interface from the consumer side (M2, which knows what an opener has to be) is more likely to produce the right shape than designing it from the producer side (A, which knows what YouTube happens to return).

### 3.3 B is a surface with no content of its own

A floating window does nothing; it shows things. Its content is C's (which lives in M2) and A's links and images. Building it first is the textbook dispersion failure for a repo with eight open branches and one developer.

There is a better outcome than building it: after M2 ships with C folded in, the in-app panel may simply be enough, and M9 dies for lack of need. Sequencing it last maximises the chance it never gets built — which for a feature is a good result, not a failure.

---

## 4. C, dissolved into M2

### 4.1 Why it is not separate

The feedback panel under the bubble (already decided for M2) and "see the good version written down" are the same `corrections` / `upgrades` payload with a different presentation decision. Treating C as its own capability builds the same thing twice and gives two places for the same fact to disagree.

What is genuinely new in C is **when** the payload can be read without breaking the conversation. That is a UI decision inside M2, not a system.

### 4.2 What M2 must therefore add to its own scope

The feedback panel becomes **state-machine-aware**. `useConversation` already exposes `status` (`idle | listening | review | thinking | speaking`); the panel's behaviour is a function of it:

| Status | Behaviour | Why |
|---|---|---|
| `speaking` | Panel renders, silently. No motion, no `aria-live` announcement, no focus move. | You are listening to the coach. Text you *can* glance at is support; text that moves or announces itself is interruption. |
| `listening` | Panel stays rendered and frozen. Nothing new is inserted mid-utterance. | Inserting a correction while you are producing speech is the one thing guaranteed to increase hesitation — which M2 is trying to measure. Contaminating the instrument is worse than a late correction. |
| `review`, `idle`, `thinking` | Normal insertion under the bubble, with the `aria-live` announcement. | The conversation is not in flight. |

**Consequence for the M2 spec:** the deferred `/feedback` response arriving during `listening` must be queued, not dropped and not rendered. It is written to the DB on arrival regardless — the queue governs display only, the same way the hard cap of 2 corrections + 1 upgrade limits what is seen, never what is known.

**`aria-live` budget:** the polite region is owned by `VoiceStatus`; `PauseNote` is deliberately not a live region. The feedback panel must not become a second one — `aria-live` is inherited by descendants, and two polite regions announcing the same turn is the failure mode M7's spec §8.1 already guards against.

> Corrected 2026-08-02: this paragraph originally said `PauseNote` owned the polite region. Reading `PauseNote.jsx` shows the opposite — its comment states the exclusion explicitly. The constraint is unchanged; the owner is not.

### 4.3 The interpretation that was rejected

C could have meant **real-time visual support while speaking** — live captions of your own speech, the missing word surfacing as you hesitate. That is a different system: it feeds off the interim transcript, not the deferred feedback, and it contradicts M2's locked decision that feedback is deferred and per-turn.

The owner confirmed this is not what was wanted. If it ever becomes wanted, it is a new milestone and it reopens a locked M2 decision — which is the correct level of ceremony for a change that size.

---

## 5. The seam between M2 and M8

M2 must ship an **opening seed**: the concrete first thing the coach says when a session starts.

```
seed = { topic, sourceLabel?, sourceUrl? }
```

`topic` is a bounded digest injected into the coach's system prompt for the whole session. There is
deliberately **no `opener` field**: the coach writes its own opening line from `topic`, in its own
first turn (M8 spec, D4).

- **M2 ships one provider:** a fixed seed, or a small rotation drawn from what the DB already knows (an `ErrorLedger` pattern due for review, the previous session's `summary`). No network, no new dependency.
- **M8 ships a second provider** behind the same interface, fed by external sources.
- **Degraded state is a first-class citizen, as everywhere else:** no network, no configured sources, or a stale cache past its tolerance → fall back to M2's provider. A dead YouTube feed must never cost a session.
- `sourceLabel` / `sourceUrl` are in the shape from day one but unused by M2's provider. They are the reason M9 might exist (a link is a thing worth floating); adding them later would mean changing a shipped interface, and they cost nothing now.

This is the entire contract. M2 owes M8 nothing else.

---

## 6. M8 — sourced proactivity

**Designed.** See [`2026-08-02-sourced-proactivity-design.md`](2026-08-02-sourced-proactivity-design.md), which resolves the open questions this section previously listed. Summary of its six locked decisions:

1. RSS metadata only — no transcripts.
2. Topic source, not shared reference: the coach never assumes the learner watched anything.
3. The topic governs the whole session, as gravity rather than a rail.
4. The coach writes its own opener from the system prompt; no separate generation step.
5. `SOURCE_FEEDS` env var holding feed URLs, zero UI.
6. Cache-first, background refresh, no expiry logic.

The obligation it places back on **M2**: build `seed/index.js` + `seed/local.js`, add the `Session.seedProvider` / `Session.topicId` columns, and expose a path where the coach takes a turn with no `utterance`.

**Pedagogical risk to hold onto:** a coach that raises a subject from your subscriptions is a topic generator. It might make the app feel smarter without making the practice harder. M2's metrics are how that gets checked, and checking it is the point of the ordering — see that spec's §12.

---

## 7. M9 — floating window (conditional)

### 7.1 Kill criteria, defined before building

M9 is cancelled if, after M2 has been in daily use, **the in-app panel turns out to be enough** — that is, if practice sessions are conducted with SpeakUp in the foreground and nothing is ever needed from another window.

The real justification for M9 is a use case that has not yet been established: practising while doing something else on screen, or wanting prompts visible during a conversation with a real person. If that use case is not real, M9 is decoration.

### 7.2 Document Picture-in-Picture over Electron/Tauri

The owner's suspicion is correct, and the reason is sharper than "packaging cost."

`documentPictureInPicture.requestWindow()` opens a real always-on-top OS window whose DOM lives in a *separate* document — but in the **same JavaScript context**. The consequence that matters: `micStream.js` and `speech.js` keep running untouched in the opener document. The `AudioContext`, the worklet, and the recogniser never move. React reaches the new window with `createPortal`.

Electron or Tauri costs far more than packaging: it means `micStream.js` stops being the only file that touches Web Audio, and that boundary is explicitly load-bearing — it is what keeps `useConversation` testable under jsdom, which has no Web Audio at all. Paying for a desktop shell means paying in the project's most valuable architectural invariant. It needs a much better reason than "a small window."

Known costs of the Document PiP path, to be honest about at design time:

- Chromium-only (Chrome 116+). Already true of the project via Web Speech — not a new constraint.
- Requires a user gesture to open; cannot be opened automatically at session start.
- One such window at a time, shared with video PiP.
- Stylesheets are **not** inherited by the new document; Tailwind v4's output has to be cloned into it explicitly, and that clone is a real maintenance edge.
- The window dies with its opener document.

### 7.3 Spike K5 — blocking, and cheap

**Does the voice loop survive a backgrounded opener tab?**

The entire use case for M9 requires the SpeakUp tab to be hidden behind another window. Chrome throttles background tabs aggressively; tabs holding an active mic capture are normally exempt from freezing, but "normally exempt" is not a measurement, and `useConversation` depends on timers (`MAX_LISTEN_MS`, the `playCoach` fallback timer, the deferred `setTimeout(…, 0)` restart in `handleRecognizerEnd`) whose throttling behaviour under a hidden document is unverified.

If the loop degrades when hidden, **M9 does not work at all** regardless of how the window is built — and Electron would not save it either, since the constraint is the recogniser, not the shell.

Run K5 before any M9 design work. It is an afternoon, and it can cancel the milestone outright.

---

## 8. What this document does not decide

- Anything internal to M2 beyond §4.2 and §5. M2's own spec is still unwritten — its decisions currently live only in a chat prompt, which is a documentation gap worth closing before implementation.
- M8's ingestion, storage, or prompt shape.
- M9's layout or content.
- Anything about M4, M5, M6, or M7 slices 4–8. The two M7 spikes (K1, K3) remain unrun and are untouched by this ordering.

---

## 9. Next artifacts, in order

1. ~~M2 spec, plan and implementation~~ — shipped on `main`.
2. **M8 implementation plan** — the spec is written, and M8 now owns the seam M2 did not build (§10).
3. **Spike K5**, then a go/no-go on M9.

---

## 10. Reconciliation with shipped M2 (2026-08-03)

M2 shipped while this document still described it as forthcoming. Verified against `main` at `ebbd732`:

| This document assumed | What shipped | Consequence |
|---|---|---|
| §4.2 — the feedback panel freezes during `listening` and queues arriving payloads | `FeedbackPanel.jsx` exists with both channels and attaches feedback **by message id** (a sturdier fix than the position-based approach this document worried about), but there is **no queueing**: a payload landing mid-utterance renders immediately | **Open.** The reasoning in §4.2 stands and is untouched by how the attachment works. It is now a change against shipped M2, not a requirement on unbuilt M2. |
| §5 — M2 builds `seed/index.js` + `seed/local.js`, adds `Session.seedProvider` / `topicId`, and exposes a coach turn with no `utterance` | None of it. There is no `seed/` module, no `POST /turn/open`, and the client still opens from a hardcoded `GREETING` constant in `useConversation.js` | **Moved to M8.** M8 owns the whole seam now, including the `local` provider it was going to inherit. |
| §4.3 — capability C is fully dissolved into M2 | Partially. The two-channel panel shipped; the presentation rule did not | C is **mostly** delivered. What remains is the §4.2 row above — one rule, not a system. The decision to not build C as a separate milestone was still correct. |

**The sequencing argument is unaffected.** M2 shipped first and its metrics exist, which is the whole basis of §3.1: M8 can now be judged rather than merely believed. The two obligations that slipped are additive work for M8, not a reason to reorder anything.

**One thing to note for M8's plan:** because M2 did not add `Session.seedProvider` / `topicId`, the measurement hook that justifies M8's position in the order is now M8's own first migration. If it gets cut for being "just instrumentation", the ordering argument goes with it.
