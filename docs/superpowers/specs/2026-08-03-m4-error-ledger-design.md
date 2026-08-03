# Error Ledger Exploitation (M4) — Design Spec

**Date:** 2026-08-03
**Status:** design approved, implementation plan not yet written
**Depends on:** M2 (writes the ledger every turn), M3 (persistence spine)
**Feeds:** a later vocabulary/spaced-repetition milestone, which this spec deliberately does not cover

---

## 1. Context

M2 shipped the error ledger's write path. Every turn records every finding — including the ones the
display cap hides — keyed by a normalized `pattern` so the twelfth sighting is the same row with
`frequency: 12`.

Verified in code at `e152e0f`:

- `ErrorLedger` is written on every turn by `feedback/index.js` via `repo/ledger.js`.
- `ErrorLedger.status` (`active` | `improving` | `resolved`) has never transitioned. Every row is
  `active`.
- The ledger has exactly one reader: `getFrequencies`, used to rank which two corrections win the
  display slots.
- `VocabItem` and `Progress` are modelled and have never been written or read.
- The learner has never seen the ledger.

**The ledger is empty in practice.** M2 merged the same day this was designed, so no real session has
run. Every threshold in this spec is a starting value, not a measurement — see §11.

## 2. Goal & non-goals

### Goal

Turn the accumulated ledger from a ranking input into the thing that makes this a coach rather than a
corrector: the conversation adapts to the learner's own recurring mistakes, and the learner can see a
habit change state on evidence.

### Non-goals

1. **No vocabulary spaced repetition.** `VocabItem`, `nextReviewAt` and SM-2 are a later milestone.
   M4 does not write or read them.
2. **No drill surface.** Nothing in M4 can be practised, answered or scheduled from a screen. The
   moment a review screen appears, it is a different milestone — see D1.
3. **No `Progress` writes.** Daily aggregates, streaks and averages are out of scope.
4. **No adaptive difficulty beyond probing.** The coach probes; it does not change register, speed or
   topic complexity based on measured metrics.
5. **No CEFR classification.** Still absent, still not this milestone.

---

## 3. Locked decisions

| | Decision | Rejected alternative and why |
|---|---|---|
| **D1** | **Ledger exploitation only.** No vocabulary half, no drill screen | Full M4-as-listed (two subsystems in one spec, and the vocab half would be designed on zero data); drill-first (leaving the conversation to do flashcards is what the apps this project criticises do — it removes the time pressure that is the whole point) |
| **D2** | **The ledger changes the coach's behaviour, not only the panel's copy.** The coach receives the learner's top active patterns and creates natural openings where those constructions are needed, without announcing it | Display-only (showing "3rd time" is still measuring; eliciting is teaching, and the README's claim is that the ledger is what makes this teaching) |
| **D3** | **Status transitions are driven by deliberate elicitation.** The coach probes, and the outcome of the probed turn moves the status | Time-and-absence (a pattern going quiet may mean the learner avoided the construction — it produces the claim "you fixed this" without the evidence); true opportunity detection (correct but hard, and it is the thing D3 approximates) |
| **D4** | **The learner sees a compact, read-only patterns view** | Invisible machinery (a habit that resolves and is never seen resolving is a withheld reward, and this is the only reward this product can give that a generic XP counter cannot) |
| **D5** | **Probing is throttled to one per `PROBE_TURN_INTERVAL` turns** | Letting the model weave patterns in organically — given three patterns and freedom, a model uses all three every turn, and the result is an examiner with a syllabus rather than an attentive coach |
| **D6** | **The probe token is carried by the client between `/turn` and the next `/feedback`** | Server-side pending state plus a `Probe` table (a new model, a new lifecycle with dangling states, and a migration, buying traceability nobody will query at this scale) |
| **D7** | **`resolved` requires `PROBE_PASSES_TO_RESOLVE` consecutive passes** | A single pass (a learner can dodge one probe; dodging the same construction three times running while the coach insists is improbable) |

### 3.1 Why elicitation is the measurement, not just the pedagogy

D2 and D3 are the same mechanism seen twice. Steering the conversation toward a construction the
learner keeps failing is the teaching act; the learner's response to that steering is the only
evidence that would justify saying they have improved.

The alternative — declaring a pattern resolved because it stopped appearing — is an inference from
silence. A learner who has learned to avoid the perfect tense produces exactly the same signal as one
who has mastered it. Elicitation separates them.

---

## 4. Architecture

```
server/src/
├── coach/
│   └── probe.js         chooses which pattern to probe, builds the directive (pure)
├── ledger/
│   └── transitions.js   (status, probesPassed, outcome) → next state (pure)
├── repo/
│   └── ledger.js        + getProbeCandidates, applyProbeOutcome, listPatterns
│                        and getFrequencies widened to also return `status`,
│                        which §5.2's `recurrence` block needs
└── routes/
    ├── turn.js          returns `probe` on the response
    ├── feedback.js      accepts `probedPattern`, closes the loop
    └── patterns.js      GET /patterns
```

### 4.1 Load-bearing boundaries

**`ledger/transitions.js` does no I/O.** It takes the current state and an outcome and returns the
next state; `now` is a parameter, not a call. Same rule that makes `metrics/delivery.js` testable, and
it matters more here: this function decides whether the product tells someone they fixed a habit, so
it must be verifiable against constructed inputs with closed-form expectations.

**`coach/probe.js` does no I/O either.** It receives already-read candidates plus the turn index and
returns `{ pattern, directive } | null`. The *choice* is pure; the *read* lives in `repo/`. The
throttle policy is therefore testable without a database.

**`repo/ledger.js` remains the only module that talks to Prisma**, and now has three readers instead
of one. It still does not catch its own errors — wrapping failures is the caller's job, as decided in
M2.

**The probe directive is never concatenated into the coach's system prompt.** `coachSystemM2` stays
intact and the directive travels as a **second system message**, per turn. That keeps the base prompt
a single freezable, comparable artifact — which is what makes `COACH_PROMPT=m1` worth having — and
treats the directive as the ephemeral context it actually is.

### 4.2 Schema

`ErrorLedger` gains two columns and nothing else:

```prisma
  probesPassed  Int       @default(0)
  lastProbedAt  DateTime?
```

No new model. Promoting these to a `Probe` table stays available if real data later shows the probe
history is worth querying.

### 4.3 Client

`client/src/components/PatternsPanel.jsx`, read-only, reached from the header. In `useConversation`,
the probe token is a `useRef` carried across one turn — **no new member in the state machine**, the
same discipline M2 followed for the feedback payload.

---

## 5. The probe loop

```
Turn N    /turn ─────► coach reply (contains the elicitation)
                       + probe: { pattern: "grammar:i have # years" }
          client stores the token
          /feedback (turn N) ───► no probedPattern: the learner has not answered yet

Turn N+1  /turn ─────► reply, possibly carrying a NEW probe
          /feedback (turn N+1) with probedPattern = the token from turn N
                       └─► does that pattern appear among the new findings?
                           no → pass     yes → fail
```

### 5.1 The sequencing trap

`/turn` for turn N+1 resolves **before** its `/feedback` fires, so the new probe token arrives before
the pending one has been consumed. The pending token must be read and captured **before** the new one
is stored, or turn N's probe is silently dropped and never resolves.

This is the same class of defect as attach-by-position in M2. It gets its own test.

### 5.2 Contract

```jsonc
// POST /turn — added to the response
"probe": { "pattern": "grammar:i have # years" }   // or null

// POST /feedback — accepted in the body
"probedPattern": "grammar:i have # years"          // optional

// POST /feedback — added to the response
"probeResult": { "pattern": "...", "passed": true, "status": "resolved" },  // or null
"corrections": [{ ..., "recurrence": { "frequency": 4, "status": "active" } }]
```

`recurrence.frequency` is the all-time count, because that is what the ledger stores. Copy must not
say "this week" — there is no windowed count and inventing one would be a claim the data does not
support.

### 5.3 When a probe fires

Server-side, no client state:

- every `PROBE_TURN_INTERVAL` user turns in the session (default 3, **UNCALIBRATED**, mirroring
  `PAUSE_NOTE_TURN_INTERVAL` in `useConversation.js`);
- among patterns with `status` of `active` or `improving` and `frequency >= MIN_PROBE_FREQUENCY`
  (default 3, **UNCALIBRATED**) — never on an isolated slip;
- taking the top `PROBE_POOL_SIZE` (default 3, **UNCALIBRATED**) of those by frequency, and probing
  whichever of them has the **oldest `lastProbedAt`**, nulls first.

Rotation by oldest-probed rather than a separate cooldown constant is deliberate: the timestamp the
schema already carries answers the question directly, so there is no second unit of time to keep
consistent with the turn counter. It also guarantees that a single stubborn pattern cannot monopolise
every probe, which is what a cooldown would have been for.

`resolved` patterns are not candidates. They stop being provoked and change only on relapse.

---

## 6. Status transitions

| Event | Result |
|---|---|
| Probe **passed** | `probesPassed + 1`; `improving`, or `resolved` on reaching `PROBE_PASSES_TO_RESOLVE` (default 3, **UNCALIBRATED**) |
| Probe **failed** | `active`, `probesPassed = 0` |
| **Ordinary sighting** in free conversation | `active`, `probesPassed = 0` |

The third row changes M2 code: `recordFindings` currently only increments `frequency` and refreshes
`lastSeenAt`; it must now also reset `status` and `probesPassed`. A relapse is a relapse — making the
mistake in free conversation means it is not fixed, regardless of how many probes were passed before.
A `resolved` pattern that reappears returns to `active`.

`probesPassed` is capped at `PROBE_PASSES_TO_RESOLVE` so it cannot grow without bound.

---

## 7. The patterns view

`GET /patterns` returns rows ordered by status then frequency, carrying `example`, `frequency`,
`status`, `probesPassed`, `lastSeenAt` and `lastProbedAt`.

**The `pattern` key is never displayed.** `grammar:i have # years` is an internal normalized key — the
digit fold, the type prefix and the four-token truncation are implementation. What the learner sees is
`example`: the sentence they actually said. The key is how the system groups; the example is how the
learner recognises it. The API may return the key for React reconciliation; the UI must not render it.

**Status is shown with its evidence beside it, as visible text** — *"clean · passed 3 checks · last
slip 24 days ago"* — never a bare label, and never in a `title` attribute. This is M2's accessibility
lesson applied to a stronger claim: telling someone they fixed a habit is exactly the kind of
assertion that must carry its evidence where everyone can reach it.

The empty state must not read as failure: with no rows, the panel says nothing has been recorded yet
and to keep talking.

---

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Ledger read fails while choosing a probe | No probe this turn. The conversation is unaffected — the rule `safeFrequencies` established in M2 |
| The token never comes back (reload, closed tab, `/feedback` down) | The probe goes **unresolved and transitions nothing**. `lastProbedAt` was already written, so that pattern moves to the back of the rotation rather than being probed again immediately |
| An unknown `probedPattern` arrives | `applyProbeOutcome` finds no row, no-ops, logs. A probe never creates a ledger row |
| Empty ledger | The view shows a first-run state that does not read as failure |
| `GET /patterns` fails | The panel shows its own error; the conversation never learns about it |

### 8.1 The idempotency seam

`POST /feedback` is already idempotent by `turnId` — a retry returns the stored payload without
recomputing — and additionally de-duplicates concurrent requests in flight.

If the probe transition were applied **outside** that path, a retry would apply it twice:
`probesPassed` would jump from 1 to 3 on a single real probe, and the product would tell the learner
they had fixed a habit that is intact.

**`applyProbeOutcome` therefore runs inside `computeAndPersist`, behind both gates, never before it.**
This is the same inflation the `turnId` gate exists to prevent arriving through a different door —
which is precisely how the double-count that M2's whole-branch review caught got in.

### 8.2 What has no technical mitigation

We cannot verify that the coach obeyed the directive. If the model ignores the probe and asks
something else, `lastProbedAt` is written, the learner never had the opportunity, and a "pass" is
unearned. Checking would cost another model call to have it grade itself — expensive and unreliable.

What the design does instead is refuse to let a single pass mean anything: D7's three-consecutive-pass
rule absorbs the occasional skipped probe.

---

## 9. Testing

Almost everything that matters here is pure, so almost everything is verified in closed form.

### 9.1 Server (Vitest, node environment)

| Module | Approach |
|---|---|
| `ledger/transitions.js` | Table-driven: all three rules, the exact boundary at the third pass, and the relapse path `resolved` → sighting → `active` with the counter zeroed |
| `coach/probe.js` | Pure policy: fires on the interval, respects the cooldown, ignores low frequency, ignores `resolved`, returns `null` with no candidates |
| `repo/ledger.js` | Candidate ordering and filtering; `applyProbeOutcome` persists; and a **regression test on `recordFindings`**, which M4 changes to reset status and counter |
| `routes/turn.js` | The probe appears at the right cadence and is absent otherwise |
| `routes/feedback.js` | The outcome transitions; **and the most important test in M4**: two requests with the same `turnId` and `probedPattern` apply the transition exactly once, asserted as `probesPassed` incremented by exactly 1 |
| `routes/patterns.js` | Shape, ordering, empty state |

### 9.2 Client

The sharp test is the cross-turn token: a probe issued at turn N is sent with turn N+1's feedback,
**and a new probe issued at N+1 does not clobber the pending one before it is read** (§5.1). Like M2's
attach-by-id race, it will not be reproduced by hand.

`PatternsPanel`: renders `example` and never the key, the empty state does not read as failure, status
evidence is visible text rather than an attribute, and `jest-axe` is clean.

`getPatterns` in `client/src/lib/api.js` follows `postFeedback`'s contract: returns `null` on any
failure, never throws.

### 9.3 Coverage gate

`server/vitest.config.js`'s `coverage.include` is extended with `src/coach/**` and `src/ledger/**` in
the same commit that creates them.

### 9.4 What tests cannot establish

They verify the loop closes, not that probing teaches. No test says whether the coach's elicitations
**sound natural** or whether they turn the conversation into an interrogation — the risk accepted in
D2 — nor whether three consecutive passes mean anything.

**Human evaluation, once:** a 20-turn session read by hand, marking how many probes are recognisable
as probes and how many pass as ordinary conversation. If they are conspicuous, the throttle or the
directive's phrasing is wrong. This is worth discovering before weeks of transitions accumulate on
probes the learner was deliberately dodging. Recorded in
`docs/superpowers/plans/voice-io-verification-checklist.md` alongside M2's outstanding evaluation.

---

## 10. What can honestly be claimed

**Can be claimed:**

- A pattern's status changed because the learner was given a deliberate opportunity to repeat a
  mistake and did or did not take it — not because the mistake went quiet.
- `resolved` required three consecutive passes, and any single relapse in free conversation revokes
  it.
- The learner can see which habits are changing, with the evidence for each claim beside it.

**Cannot be claimed:**

- That a passed probe proves the learner used the construction correctly. It proves they did not make
  that mistake in that turn; they may have avoided the construction. §8.2.
- That the coach actually probed. The directive is an instruction to a model, not a guarantee.
- That the thresholds mean anything yet. Every constant in this spec is **UNCALIBRATED** — see §11.
- Anything about vocabulary retention. That is not in this milestone.

---

## 11. Calibration debt

The ledger was empty when this was designed. `PROBE_TURN_INTERVAL`, `MIN_PROBE_FREQUENCY`,
`PROBE_POOL_SIZE` and `PROBE_PASSES_TO_RESOLVE` are starting values chosen for plausibility, not
measured. Each ships as a named constant marked `UNCALIBRATED`, following the convention
`PAUSE_NOTE_TURN_INTERVAL` established.

They should be revisited once real sessions exist. The specific question worth answering first is
whether probes fire often enough to move any status at all in a typical week: with a probe every three
turns, a rotation pool of three patterns, and three passes required, a given pattern needs roughly
nine turns per pass and about twenty-seven to resolve. A short daily session may never resolve
anything — and if nothing ever resolves, the reward D4 exists to deliver never arrives, which would
make D4 pointless rather than merely slow.

## 12. Deferred to the implementation plan

1. **The directive's wording.** Prompt text is iterated against real conversation, not designed on
   paper. The plan pins a starting version and the evaluation in §9.4 judges it.
2. **The exact ordering in `GET /patterns`** beyond "status then frequency" — whether resolved rows
   appear at all, and how many rows the view caps at.
3. **How the header reaches the panel** — the affordance's placement and whether it shows a count.
