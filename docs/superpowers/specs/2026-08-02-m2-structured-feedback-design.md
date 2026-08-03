# Structured Feedback (M2) — Design Spec

**Date:** 2026-08-02
**Status:** design approved, implementation plan not yet written
**Depends on:** M1.5 (review-and-edit step), M3 (persistence spine), M7 slice 1 (pause profile)
**Feeds:** M4 (error ledger + spaced repetition)

---

## 1. Context

M2 is the milestone the rest of the project was ordered around. Everything through M1.5 exists to
produce a transcript the learner has confirmed, because grammar-checking an unconfirmed ASR transcript
grades the recognizer rather than the learner.

Verified in code at `00091fb`:

- `server/src/prompts/coach-system.js` instructs the model to keep the conversation flowing and
  explicitly **not** to correct. The level string is already `C1–C2`.
- `brain/` exposes `evaluateTurn(ctx) -> { coach_reply, xp }`. No structured feedback exists anywhere.
- `Turn.fluency` and `Turn.confidence` have existed since M0 and have never been written.
- `Turn.prosody` holds the per-turn silent-pause profile from M7 slice 1. Nothing reads it.
- `ErrorLedger.pattern` carries `@unique` — the upsert key is modelled, never used.
- `POST /turn` returns `sessionId` but not a turn id.

## 2. Goal & non-goals

### Goal

Every confirmed utterance produces, without interrupting the conversation: mechanical corrections,
one register/range upgrade, an honest hesitation signal, and a durable record in the error ledger.

### Non-goals (v1)

1. **No pronunciation feedback.** That is M7 and is scored separately.
2. **No spaced repetition.** `VocabItem` and its SM-2 scheduling are M4. M2 writes the ledger; it does
   not schedule from it.
3. **No adaptive difficulty.** The coach's pressure level is fixed by prompt, not driven by the
   measured metrics — see §3, decision D3.
4. **No per-turn fluency score.** See §6.2.
5. **No `Progress` table writes.** Daily aggregates are M4.

---

## 3. Locked decisions

| | Decision | Rejected alternative and why |
|---|---|---|
| **D1** | **Feedback is per-turn and deferred.** The coach replies immediately; feedback lands one to two seconds later, under the already-rendered user bubble | Inline-blocking (adds latency exactly where silence hurts most, before the coach speaks); end-of-session summary (arrives after the learner has lost the context that produced the error) |
| **D2** | **Harper runs server-side**, loaded once at boot in the Express process | Client-side WASM — with D1 the panel renders on an async server response anyway, so client-side buys no perceived latency and costs a fatter bundle, `vite build` fragility, and two sources of truth for one panel |
| **D3** | **The coach's conversational turn changes too.** New system prompt: C1-level output plus an explicit pressure policy — refuse three-word answers, demand elaboration, escalate topic abstraction | Feedback-layer-only (leaves an excellent corrector attached to a flat conversational partner; flat input is half the problem). Adaptive pressure driven by the metrics is deferred: coupling behaviour to metrics before knowing the metrics mean anything produces a system that changes for reasons that are not the learner |
| **D4** | **Metrics come from objective signals only.** No LLM-judged scores | LLM-judged 0–100 for fluency and confidence: a number with no reference, undefendable, untestable, drifting between calls |
| **D5** | **`confidence` is redefined as a hesitation index** and is never labelled "confidence" in the UI | Shipping the word "confidence" over a measurement that cannot support it |
| **D6** | **Hard cap: 2 corrections + 1 upgrade per turn**, prioritized by frequency in the learner's own history. Overflow is written to the ledger, not displayed | Uncapped output — complete, honest, and the reason people abandon grammar tools |
| **D7** | **Delivery via a second endpoint, `POST /feedback`** | SSE from `/turn` (concentrates complexity in `useConversation`, the most fragile module in the project, and forces stream mocking in jsdom); piggyback on the next turn (feedback arrives one turn late, which D1 rejected) |
| **D8** | **The two passes run in series**, Harper's findings inside the LLM prompt | Parallel execution saves milliseconds (Harper is sub-millisecond) and destroys the division of labour that justifies having two passes at all |

### 3.1 Why rule-based first — and how much it actually covers

Whatever rules *can* catch must not depend on a model's mood. Harper is deterministic, local,
sub-millisecond and free, so every finding it produces is one the LLM budget does not have to buy.

**Measured, not assumed** (Harper 2.7.0, 12-sentence L1-Spanish sample, 2026-08-02): Harper catches
bare subject–verb disagreement (*"She go to school"*, *"he don't like"*), some collocation and usage
errors (*"discussed about"*, *"since 5 years"*), and nothing at all from the calque family that
dominates Spanish-speaker English — *"I have 30 years"*, *"I go to home yesterday"*, *"the people
is"*, *"I am agree with you"*, *"I am boring in this class"* all return zero findings.

An earlier draft of this spec claimed the rule-based pass handles "the boring 70%". **That claim was
wrong for this population and has been withdrawn.** The two-pass architecture survives the correction
intact — what Harper misses falls through to the LLM pass, which is exactly what the second pass is
for — but the division of labour is not the one originally described, and the consequences are real:

- The **$0, no-API-key path delivers less than first described.** It still delivers something real and
  deterministic; it does not deliver a competent grammar corrector for a Spanish speaker. The README
  must not imply otherwise.
- **Recogniser artefacts are filtered at the boundary.** Two of Harper's five hits in the sample were
  `Capitalization`. A speech transcript's capitalization and punctuation are authored by the
  recogniser, so `Capitalization`, `Punctuation`, `Formatting`, `Spelling` and `Typo` are dropped in
  `feedback/harper.js` and never become findings. Without that filter, ASR noise would consume the
  learner's two correction slots.

Whether to add a seq2seq third pass (`vennify/t5-base-grammar-correction`) is deferred to the hand
evaluation in §9.4 — twelve sentences justify withdrawing a claim, not adopting a model.

### 3.2 Why `upgrades` is the point

B2 → C1 is not driven by eliminating errors. A solid B2 speaker makes few errors; what they lack is
range. *"I have a problem with my computer"* is flawless English and unmistakably B1. A C1 speaker
says *"my laptop's been acting up"*.

A coach that ships only `corrections` caps the learner at "solid B2" permanently. This is the single
most important claim in the milestone, and it is why the payload has two channels.

---

## 4. Architecture

```
server/src/
├── feedback/
│   ├── index.js      orchestrates both passes, applies the cap, returns the payload
│   ├── harper.js     the ONLY file that imports harper.js (LocalLinter singleton)
│   ├── upgrades.js   the LLM pass: prompt, call, JSON parse and validation
│   └── pattern.js    normalizes a finding into the ledger's `pattern` key
├── metrics/
│   └── delivery.js   fluency + hesitation from objective signals (pure, no I/O)
├── repo/
│   └── ledger.js     the only module that reads or writes ErrorLedger
└── routes/
    └── feedback.js   POST /feedback
```

### 4.1 Load-bearing boundaries

**`feedback/harper.js` is the only file that imports `harper.js`.** Same rule `micStream.js` follows
for Web Audio. The WASM loads once at boot via `LocalLinter.setup()` — never lazily on first request,
or the learner's first turn pays for the WASM start. Harper's own types (`Lint`, `Span`, `Suggestion`)
do not escape this module; they are translated to the project's `Finding` shape at the boundary.

Confirmed against the published type definitions of `harper.js@2.7.0`: `LocalLinter` is the
implementation that works under Node — `WorkerLinter` explicitly does not. Surface used: `setup()`,
`lint(text) -> Lint[]`, and per lint `lint_kind()`, `message()`, `span()`, `suggestions()`,
`get_problem_text()`. Dialect is pinned to `Dialect.American`.

**`metrics/delivery.js` does no I/O.** It takes
`{ text, prosody, elapsedMs, sessionPhonationMs, sessionSyllables }` and returns
`{ hesitation, sessionFluency }`. No Prisma, no network, no clock of its own — arithmetic over data
that already exists, therefore testable against constructed inputs with closed-form expected values.

The session-level totals are accumulated by `feedback/index.js` from `repo/`, not by this module. That
keeps the accumulation in the one place allowed to read the database and keeps the arithmetic pure —
the same split that makes the pause detector testable.

**`feedback/pattern.js` is separate on purpose.** Normalizing a finding into an error signature is
M4's upsert key. Isolating it now means M4 changes the signature module, not the orchestrator.

**`upgrades.js` does not use `brain/`.** They share a provider and an API key, not an interface:
`brain/` has a conversational contract (`evaluateTurn -> coach_reply`), this pass has an analytical one
(text -> structured JSON). Merging them turns two simple modules into one with a flag.

**`repo/ledger.js`, not `repo/session.js`.** `repo/` remains the only module that talks to Prisma.

### 4.2 Client

One new component, `client/src/components/FeedbackPanel.jsx`, rendered under the user's bubble.

In `useConversation`: **one async side effect, no new state-machine member.** Feedback is not a
`status` — it is a field that fills in late on an already-rendered message. That distinction is what
keeps the existing 40 hook tests intact.

---

## 5. The contract

```
POST /feedback
body: { utterance, turnId, sessionId?, history?, prosody?, elapsedMs? }
```

```jsonc
{
  "corrections": [                      // max 2
    { "span": [12, 19], "original": "have 30 years", "suggestion": "am 30",
      "message": "Age takes 'be', not 'have'.", "kind": "grammar",
      "pattern": "have-age", "source": "harper" }
  ],
  "upgrades": [                         // max 1
    { "original": "I have a problem with my computer",
      "upgraded": "my laptop's been acting up",
      "why": "Native speakers reach for a phrasal verb here; 'have a problem with' is correct but flat.",
      "pattern": "plain-have-problem" }
  ],
  "hesitation": { "band": "some", "basis": "audio",
                  "midPhrasePauses": 3, "fillers": 2, "selfRepairs": 1 },
  "sessionFluency": null,               // see §6.2 — null until ≥5 s of phonation
  "passes": { "mechanical": "ok", "pedagogical": "skipped" }
}
```

`sessionFluency` is the session-level value described in §6.2, carried on the per-turn response purely
so `StatHeader` has a delivery route without a second endpoint or a poll. It is `null` — and the meter
is absent, not zeroed — until the session has accumulated ≥5 s of phonation. A meter that reads zero
because there is not yet enough data is indistinguishable from a meter that reads zero because the
learner is doing badly.

`passes.mechanical`: `ok` | `failed` (Harper threw on this input) | `unavailable` (WASM never loaded).
`passes.pedagogical`: `ok` | `skipped` (no API key) | `failed` (network, 429, timeout, invalid JSON).
`hesitation.band`: `steady` | `some` | `effortful`. `hesitation.basis`: `audio` | `text-only`.

### 5.1 Why `passes` is explicit

When the LLM pass does not run, the client must say so. Returning fewer findings in silence renders a
panel that reads as "you had nothing to improve" — lying by omission, and the exact failure mode the
project's own honesty rules exist to prevent.

### 5.2 The byte-identity invariant

**The `utterance` sent to `/feedback` MUST be byte-identical to the one sent to `/turn`.** Spans are
offsets into that string. M1.5's review-and-edit step already guarantees a confirmed text, so this is
free — but any trimming or normalization introduced later in the path makes the offsets point at the
wrong word, silently. A test asserts the invariant explicitly rather than trusting it.

### 5.3 No composite score in the payload

There is no overall grade, no 0–100, and no letter. The panel shows what was found and what it means.
A single headline number invites comparison against other learners, which none of these measurements
support.

---

## 6. Metrics

### 6.1 Hesitation — per turn

Computed from signals that are arithmetic, not judgement:

| Signal | Source |
|---|---|
| Mid-phrase vs clause-boundary pause ratio | `Turn.prosody`, already classified by M7 slice 1 |
| Filler density (`um`, `you know`, `I think maybe`) | text |
| Self-repair and false-start rate | text |

Pausing before a subordinate clause is planning. Pausing between an article and its noun is losing the
word. That distinction is the hesitation signature, and the classifier that produces it already ships.

When there is no microphone — the text-input path, which is first-class in this project — the
pause term cannot be computed. The band is still emitted from the text signals, and
`hesitation.basis` reports `text-only`. The UI says so.

### 6.2 Fluency — session level only, never per turn

**Articulation rate is computed over ≥5 s of accumulated phonation, at session level.** This follows
the M7 design spec §5.2, which established it from de Jong & Wempe: a one-syllable miscount on a short
spurt swings a per-turn rate enormously. A per-turn fluency meter would be a progress bar fed with
noise.

Scoring is **curvilinear** — both directions are penalized. L1-Spanish speakers characteristically run
fast, not slow.

`Turn.fluency` stores the session-level value current at that turn, so the trend stays queryable for
M4 without inventing a per-turn metric that cannot be defended. It reaches the client as
`sessionFluency` on the `/feedback` response (§5) and is displayed in `StatHeader`, never in the
feedback panel — the panel is about this utterance, and this is not a fact about this utterance.

### 6.3 Measurement ethics

Everything is **within-learner trend against the learner's own baseline**. Never distance-from-native.
This is inherited from the M7 spec §5.4 and applies unchanged.

---

## 7. Data flow

```
TranscriptReview (confirmed text)
        │
        ├──► POST /turn ──► coach_reply + audio + sessionId + turnId
        │                    └─► coach bubble + speech starts
        │
        └──► POST /feedback   (fired when /turn resolves, same text)
                   │
                   ├─ 1. Harper           in-process, sub-ms   → Finding[]
                   ├─ 2. LLM pass         network, ~1–2 s      → upgrades
                   ├─ 3. metrics/delivery pure                 → hesitation
                   ├─ 4. prioritize + apply the cap
                   └─ 5. persist
                          └─► panel under the user's bubble
```

### 7.1 Persistence

Three changes, all small:

1. **`Turn` gains `feedback String?`** — JSON-encoded. String rather than `Json`, for the same reason
   `prosody` and `captureSettings` are strings: the SQLite connector's Json capability stays out of the
   migration path. Precedent already set in M3, not a new decision.
2. **`POST /turn` starts returning `turnId`** alongside `sessionId`. One line in `persistTurn`. This is
   what lets `/feedback` attach to the right row.
3. **`ErrorLedger` is written in M2**, though M4 is what exploits it. The ledger's value is
   longitudinal: shipping M2 without writes means M4 starts from zero history and shows nothing for
   weeks. The write is an upsert on `pattern`, already modelled with `@unique` since M0.

**Overflow beyond the cap is written to the ledger, not displayed.** This is what makes D6 safe: the
cap limits what the learner sees, not what the system knows.

The ledger is therefore bidirectional within one request — read to prioritize (the pattern you repeat
most wins the slot), written on completion.

### 7.2 Idempotency

A client retry would inflate `frequency` and teach the ledger that the learner fails more than they do.

**Guard:** `/feedback` is keyed by `turnId`. If that turn already has persisted feedback, the stored
payload is returned without recomputation. This makes the endpoint idempotent and yields caching for
free — a page reload does not pay for the LLM call again.

### 7.3 Persistence failure

A persistence failure never fails the response. It costs a row, never the feedback. Identical to the
rule `/turn` has followed since M3.

---

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Harper WASM fails to load at boot | Server still boots. `passes.mechanical: "unavailable"`. `GET /health` gains a `feedback` field beside `brain`/`tts`/`stt`/`pron`; the UI already renders those pills |
| LLM pass fails — no key, network, 429, 8 s timeout | `pedagogical: "skipped" \| "failed"`. **Corrections still ship.** This is the $0 path: with no API key at all, the learner gets real, local, deterministic grammar corrections |
| LLM returns invalid JSON | `response_format: json_object` is requested, the result is schema-validated, and an invalid result is **discarded without retry**. A retry doubles cost and latency for a panel nobody is blocked on |
| LLM quotes text the learner never said | **`original` must be a literal substring of `utterance`.** Anything else is dropped at the boundary and logged. An upgrade quoting words that were never spoken destroys trust in the whole panel, irrecoverably |
| No microphone (text input path) | `hesitation.basis: "text-only"`, pause term omitted, UI states it |
| Next turn sent before feedback lands | The panel attaches by `turnId`, never to "the last message" |
| `/feedback` fails entirely | No panel. The conversation is unaffected. Same rule TTS has followed since M1 |

**Health probe asymmetry, stated deliberately:** M2 *does* probe Harper at boot, while `pron/`
deliberately has none. The difference is that the WASM loads in-process exactly once, so its state is
known and cannot change mid-session. `pron/` talks to an external container that can be started
mid-session, which is why its reachability is whatever the score call returns.

**Cost:** M2 takes the project from 1 to **2 LLM calls per turn**. On `mistral-small-latest` this is
cents, but it is a doubling and belongs in the spec rather than in the bill.

---

## 9. Testing

Unlike the prosody work, **a reference implementation exists here** — Harper itself. So the version is
**pinned exactly** (`harper.js@2.7.0`, not `^`) and assertions target **structure and spans, never
message prose**. Harper's wording changes between versions; its `lint_kind` values and offsets do not.

### 9.1 Server (Vitest, node environment)

| Module | Approach |
|---|---|
| `harper.js` | Real `LocalLinter` over sentences with known L1-Spanish errors — *"I have 30 years"*, *"I go to home yesterday"*, *"the people is"* |
| `pattern.js` | Table-driven: the same error phrased three ways yields **the same key**. Over-merging (collision) and under-merging (fragmentation) are distinct bugs; both are tested |
| `upgrades.js` | Mocked `fetch`: valid JSON, invalid JSON, **hallucinated `original` absent from the utterance**, 429, timeout |
| `index.js` | Orchestration: the cap is applied, overflow still reaches the ledger, ordering follows historical frequency |
| `delivery.js` | Constructed inputs, closed-form expected values — the discipline the pause detector established |
| `routes/feedback.js` | supertest: 400 without an utterance; **idempotency asserted by counting LLM mock calls (== 1 after two requests)**; a Prisma failure does not fail the response |

### 9.2 Client

`FeedbackPanel` renders both channels and the `pedagogical: skipped` state, with `jest-axe`.

In `useConversation`, the test that matters: **send a second turn before the first turn's feedback
arrives, and assert the panel lands on the correct message.** This is the §8 race. It will not be
reproduced by hand.

### 9.3 Coverage gate

`coverage.include` is extended with `server/src/feedback/**` and `server/src/metrics/**` **in the same
commit that adds them** — the condition M7 slice 1 wrote for itself, for the same reason.

There is no CI (M7 spec §12). The `pre-push` hook remains the only automatic enforcement.

### 9.4 What tests cannot establish

They verify plumbing, not pedagogy. No test says whether an upgrade is genuinely C1 or a paraphrase
with airs.

**Human evaluation, once:** a bank of 20 recorded utterances, judged by hand, recorded as verification
debt in `docs/superpowers/plans/voice-io-verification-checklist.md`. This is M2's real success
criterion and it is not automatable. Claiming otherwise would be the same error the M7 spec avoids by
refusing to ship a 61% F1 detector.

---

## 10. What can honestly be claimed

**Can be claimed:**

- Mechanical grammar errors in a confirmed transcript are detected deterministically, locally, and
  without an API key.
- The learner is shown at most three things per turn, chosen by what they repeat most.
- Every finding, shown or not, accumulates in a durable ledger keyed by a normalized signature.
- Hesitation is reported from measured signals, with the raw counts that justify the band.
- The measurement basis is stated when it degrades.

**Cannot be claimed:**

- That the `upgrades` channel is C1-calibrated. It is a good model with a good prompt, evaluated once
  by hand on 20 utterances. There is no CEFR classifier in this milestone.
- That the hesitation band correlates with any published construct of fluency or confidence. It is an
  internally-defined index, reported as within-learner trend only.
- That the rule-based pass gives a Spanish speaker broad grammar coverage. Measured, it does not:
  see §3.1. It catches a narrow band well and misses the calque family entirely. The honest
  description is "a free, deterministic first pass that catches some things", not "a grammar checker".
- That Harper's recall is *quantified*. Twelve sentences establish a direction, not a rate. The hand
  evaluation in §9.4 is what would produce a number, and the documented fallback if it is poor remains
  `vennify/t5-base-grammar-correction` as a third pass — a decision for M2's follow-up, not a
  pre-commitment.
- Anything about pronunciation. That is M7.

---

## 11. Deferred to the implementation plan

The following are real decisions that need data or code in front of them, and would be fiction if
pinned now:

1. **The exact band thresholds** for `hesitation`. They depend on what the learner's own first sessions
   look like; they are calibrated against real turns, not guessed, and the constants are named.
2. **The `pattern` normalization rules.** The table-driven test in §9.1 is written first and the rules
   are built to satisfy it.
3. **The pressure policy wording** in the new coach prompt (D3). Prompt text is iterated against real
   conversation, not designed on paper.
4. **Which Harper lint kinds map to `kind: "grammar"` vs `"vocab"` vs `"register"`.** Requires reading
   the actual `lint_kind` inventory of the pinned version.
