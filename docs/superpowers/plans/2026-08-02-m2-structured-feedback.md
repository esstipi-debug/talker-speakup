# M2 Structured Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every confirmed utterance produces mechanical corrections, one register upgrade, an honest hesitation signal, and a durable ledger row — delivered after the coach has already replied, so the conversation never waits.

**Architecture:** A second endpoint `POST /feedback` runs two passes in series — Harper (rule-based, in-process WASM, sub-millisecond) then an LLM pass that receives Harper's findings and is told not to repeat them. Results are capped, prioritized by the learner's own error history, persisted on the turn row, and written to `ErrorLedger`. The client fires the call when `/turn` resolves and patches the already-rendered user message.

**Tech Stack:** Node 20+, Express 5, Prisma 6 + SQLite, `harper.js@2.7.0` (WASM), Vitest (node + jsdom), React 19.

**Spec:** [`docs/superpowers/specs/2026-08-02-m2-structured-feedback-design.md`](../specs/2026-08-02-m2-structured-feedback-design.md)

## Global Constraints

- **`harper.js` is pinned exactly**: `"harper.js": "2.7.0"` in `server/package.json`. No caret. Harper's message prose changes between versions; tests assert `lint_kind` and spans, never message text.
- **`lint()` MUST be called with `{ language: "plaintext" }`.** It defaults to `markdown`, which will parse a learner's speech as markup.
- **`Lint` objects are WASM handles.** Call `.free()` on every lint after translating it. This is a long-lived server process.
- **Only `server/src/feedback/harper.js` may import `harper.js`.** Same rule `micStream.js` follows for Web Audio.
- **Only `server/src/repo/*.js` may import Prisma.**
- **`metrics/delivery.js` does no I/O** — no Prisma, no fetch, no `Date.now()`.
- **The `utterance` sent to `/feedback` is byte-identical to the one sent to `/turn`.** Never trim, normalize, or lowercase it in the request path.
- **Caps are hard:** max 2 corrections, max 1 upgrade in the response. Overflow still reaches the ledger.
- **No composite score, no 0–100 shown to the user, no raw milliseconds in UI copy.**
- **The UI never uses the word "confidence"** for the hesitation metric.
- **Degrade, never break:** a failure in any pass, in persistence, or in the whole endpoint costs the panel, never the conversation.
- **Commit after every task.** No CI exists; `pre-push` runs the full suite.

---

## Task 1: Persist feedback and expose the turn id

The `/feedback` endpoint needs a row to attach to and an idempotency key. Neither exists yet.

**Files:**
- Modify: `server/prisma/schema.prisma` (model `Turn`)
- Modify: `server/src/repo/session.js`
- Modify: `server/src/routes/turn.js:78-104` (`persistTurn` and its caller)
- Test: `server/test/turn-persistence.test.js` (existing file — add cases)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `recordTurn({ sessionId, role, text, xp?, prosody?, captureSettings?, feedback? })` → the created Prisma `Turn` row (unchanged shape plus `feedback`).
  - `getTurnFeedback(turnId)` → `Promise<object | null>` — decoded JSON, `null` when absent or unreadable.
  - `saveTurnFeedback(turnId, payload)` → `Promise<void>`.
  - `POST /turn` response gains `turnId: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/turn-persistence.test.js`:

```js
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { saveTurnFeedback, getTurnFeedback } from "../src/repo/session.js";

describe("turn id + feedback column", () => {
  it("returns a turnId for the user turn", async () => {
    const res = await request(app).post("/turn").send({ utterance: "hello there" });
    expect(res.status).toBe(200);
    expect(typeof res.body.turnId).toBe("string");
    expect(res.body.turnId.length).toBeGreaterThan(0);
  });

  it("round-trips a feedback payload on that turn", async () => {
    const res = await request(app).post("/turn").send({ utterance: "hello again" });
    await saveTurnFeedback(res.body.turnId, { corrections: [], upgrades: [] });
    expect(await getTurnFeedback(res.body.turnId)).toEqual({ corrections: [], upgrades: [] });
  });

  it("returns null for a turn with no feedback yet", async () => {
    const res = await request(app).post("/turn").send({ utterance: "nothing stored" });
    expect(await getTurnFeedback(res.body.turnId)).toBeNull();
  });
});
```

- [ ] **Step 2: Install supertest and run the test to verify it fails**

```bash
npm --prefix server install -D supertest
npm --prefix server test -- turn-persistence
```

Expected: FAIL — `saveTurnFeedback is not a function`.

- [ ] **Step 3: Add the column**

In `server/prisma/schema.prisma`, inside `model Turn`, after `captureSettings`:

```prisma
  // JSON-encoded M2 feedback payload. String rather than Json for the same
  // reason as prosody: the SQLite connector's Json capability stays out of the
  // migration path.
  feedback   String?
```

Then:

```bash
npm --prefix server run prisma:migrate -- --name add_turn_feedback
```

- [ ] **Step 4: Implement the repo functions**

In `server/src/repo/session.js`, add `feedback` to `recordTurn`'s destructured params and `data` object:

```js
export async function recordTurn({ sessionId, role, text, xp = null, prosody = null, captureSettings = null, feedback = null }) {
  return getPrisma().turn.create({
    data: {
      sessionId,
      role,
      text,
      xp,
      prosody: prosody ? JSON.stringify(prosody) : null,
      captureSettings: captureSettings ? JSON.stringify(captureSettings) : null,
      feedback: feedback ? JSON.stringify(feedback) : null,
    },
  });
}
```

Append to the same file:

```js
export async function saveTurnFeedback(turnId, payload) {
  await getPrisma().turn.update({
    where: { id: turnId },
    data: { feedback: JSON.stringify(payload) },
  });
}

export async function getTurnFeedback(turnId) {
  const turn = await getPrisma().turn.findUnique({
    where: { id: turnId },
    select: { feedback: true },
  });
  return parseJsonColumn(turn?.feedback, "feedback");
}
```

Add `feedback` to `decodeTurn`:

```js
function decodeTurn(turn) {
  return {
    ...turn,
    prosody: parseJsonColumn(turn.prosody, "prosody"),
    captureSettings: parseJsonColumn(turn.captureSettings, "captureSettings"),
    feedback: parseJsonColumn(turn.feedback, "feedback"),
  };
}
```

- [ ] **Step 5: Return the turn id from `/turn`**

In `server/src/routes/turn.js`, change `persistTurn` to return both ids and update its caller:

```js
async function persistTurn({ sessionId, utterance, prosody, captureSettings, result }) {
  let id = sessionId ?? null;
  let sessionUsable = false;
  let turnId = null;
  try {
    if (!id) id = (await startSession()).id;
    const userTurn = await recordTurn({
      sessionId: id,
      role: "user",
      text: utterance,
      prosody: prosody ?? null,
      captureSettings: captureSettings ?? null,
    });
    turnId = userTurn.id;
    sessionUsable = true;
    await recordTurn({ sessionId: id, role: "coach", text: result.coach_reply, xp: result.xp ?? null });
    return { sessionId: id, turnId };
  } catch (dbErr) {
    console.warn("[turn] persistence failed, continuing:", dbErr.message);
    // Never hand back an id we could not write to (see the M3 note above).
    // turnId is echoed when the user row itself landed: /feedback can still
    // attach to it even if the coach row failed.
    return { sessionId: sessionUsable ? id : null, turnId };
  }
}
```

And in the route handler:

```js
    const { sessionId: persistedId, turnId } = await persistTurn({ sessionId, utterance: utterance.trim(), prosody, captureSettings, result });
    return res.json({ ...result, sessionId: persistedId, turnId });
```

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
```

Expected: PASS, including the pre-existing persistence tests.

- [ ] **Step 7: Commit**

```bash
git add server/prisma server/src/repo/session.js server/src/routes/turn.js server/test server/package.json server/package-lock.json
git commit -m "feat(server): Turn.feedback column and turnId on the /turn response"
```

---

## Task 2: The Harper pass

**Files:**
- Create: `server/src/feedback/harper.js`
- Create: `server/test/feedback-harper.test.js`
- Modify: `server/package.json` (dependency + coverage tooling)
- Modify: `server/vitest.config.js` (coverage gate)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `setupHarper()` → `Promise<void>` — loads the WASM. Safe to call twice.
  - `harperStatus()` → `"ok" | "unavailable"` — `"unavailable"` once setup has failed.
  - `lintUtterance(text)` → `Promise<Finding[]>`, where
    `Finding = { span: [number, number], original: string, suggestion: string, message: string, lintKind: string, source: "harper" }`.
    Throws only if Harper itself throws; the caller decides what that means.

- [ ] **Step 1: Write the failing test**

Create `server/test/feedback-harper.test.js`:

```js
import { describe, it, expect, beforeAll } from "vitest";
import { setupHarper, lintUtterance, harperStatus } from "../src/feedback/harper.js";

describe("lintUtterance", () => {
  beforeAll(async () => { await setupHarper(); }, 60000);

  it("reports the linter as available after setup", () => {
    expect(harperStatus()).toBe("ok");
  });

  it("finds an agreement error and points its span at the real text", async () => {
    const text = "the people is very nice";
    const findings = await lintUtterance(text);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      // The span must address the string we passed in, not a reparsed copy.
      expect(text.slice(f.span[0], f.span[1])).toBe(f.original);
      expect(f.source).toBe("harper");
      expect(typeof f.lintKind).toBe("string");
    }
  });

  it("returns an empty array for clean text", async () => {
    expect(await lintUtterance("I went to the shop yesterday.")).toEqual([]);
  });

  it("does not treat the utterance as markdown", async () => {
    // Bare '#' and '*' are ordinary speech artefacts, not headings/emphasis.
    const findings = await lintUtterance("I paid # 5 for it * twice");
    for (const f of findings) expect(f.lintKind).not.toBe("Formatting");
  });
});
```

- [ ] **Step 2: Install and run to verify it fails**

```bash
npm --prefix server install harper.js@2.7.0 --save-exact
npm --prefix server install -D @vitest/coverage-v8
npm --prefix server test -- feedback-harper
```

Expected: FAIL — cannot resolve `../src/feedback/harper.js`.

- [ ] **Step 3: Implement**

Create `server/src/feedback/harper.js`:

```js
import { LocalLinter, Dialect } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";

/**
 * The ONLY file allowed to import harper.js — same boundary micStream.js holds
 * for Web Audio. Harper's own types (Lint, Span, Suggestion) never escape this
 * module; they are translated to the project's Finding shape at the border.
 *
 * The binary is the inlined build: it carries the WASM as a data URL, so there
 * is no asset path to resolve and nothing for a bundler to lose.
 */
let linter = null;
let status = "unavailable";

export async function setupHarper() {
  if (linter) return;
  try {
    const candidate = new LocalLinter({ binary: binaryInlined, dialect: Dialect.American });
    // Load the WASM now, at boot — never lazily, or the learner's first turn
    // pays for it.
    await candidate.setup();
    linter = candidate;
    status = "ok";
  } catch (err) {
    console.warn("[feedback] Harper failed to load — mechanical pass unavailable:", err.message);
    status = "unavailable";
  }
}

export function harperStatus() {
  return status;
}

export async function lintUtterance(text) {
  if (!linter) return [];
  // language:'plaintext' is mandatory. Harper defaults to markdown, which
  // would parse spoken '#' and '*' as markup.
  const lints = await linter.lint(text, { language: "plaintext", dedup: true });
  try {
    return lints.map((lint) => translate(lint));
  } finally {
    // Lints are WASM handles. This process is long-lived.
    for (const lint of lints) lint.free();
  }
}

function translate(lint) {
  const span = lint.span();
  const suggestions = lint.suggestions();
  try {
    return {
      span: [span.start, span.end],
      original: lint.get_problem_text(),
      suggestion: suggestions[0]?.get_replacement_text() ?? "",
      message: lint.message(),
      lintKind: lint.lint_kind(),
      source: "harper",
    };
  } finally {
    span.free();
    for (const s of suggestions) s.free();
  }
}
```

- [ ] **Step 4: Add the server coverage gate**

Replace the `test` block in `server/vitest.config.js` with the same block plus:

```js
    coverage: {
      provider: "v8",
      // Globs, not file lists: later tasks add modules to these directories
      // and are covered the moment they land.
      include: ["src/feedback/**/*.js", "src/metrics/**/*.js"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
```

Add to `server/package.json` scripts:

```json
    "test:coverage": "vitest run --coverage",
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix server test -- feedback-harper
```

Expected: PASS, all four cases.

- [ ] **Step 6: Commit**

```bash
git add server/src/feedback/harper.js server/test/feedback-harper.test.js server/package.json server/package-lock.json server/vitest.config.js
git commit -m "feat(server): Harper pass behind a single-import boundary"
```

---

## Task 3: Pattern normalization

The `ErrorLedger` upsert key. Over-merging and under-merging are distinct bugs; both are tested.

**Files:**
- Create: `server/src/feedback/pattern.js`
- Create: `server/test/feedback-pattern.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `toPattern(type, text)` → `string`. `type` is one of `"grammar" | "vocab" | "register" | "pronunciation"`.

- [ ] **Step 1: Write the failing test**

Create `server/test/feedback-pattern.test.js`:

```js
import { describe, it, expect } from "vitest";
import { toPattern } from "../src/feedback/pattern.js";

describe("toPattern", () => {
  // Under-merging: the same mistake must not fragment into many ledger rows.
  it.each([
    ["I have 30 years", "I have 25 years"],
    ["I have 30 years", "i have 40 years!"],
    ["I have a problem with my computer", "I have a problem with my phone"],
    ["  the people   is  ", "The people is"],
  ])("merges %j and %j", (a, b) => {
    expect(toPattern("grammar", a)).toBe(toPattern("grammar", b));
  });

  // Over-merging: genuinely different mistakes must not collide.
  it.each([
    ["I have 30 years", "I am 30 years old"],
    ["the people is", "the news are"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(toPattern("grammar", a)).not.toBe(toPattern("grammar", b));
  });

  it("keeps the same text apart across types", () => {
    expect(toPattern("grammar", "make a party")).not.toBe(toPattern("vocab", "make a party"));
  });

  it("is prefixed by the type", () => {
    expect(toPattern("register", "very good")).toMatch(/^register:/);
  });

  it("survives empty and punctuation-only input", () => {
    expect(toPattern("grammar", "")).toBe("grammar:");
    expect(toPattern("grammar", "!!!")).toBe("grammar:");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- feedback-pattern
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/feedback/pattern.js`:

```js
/**
 * Normalizes a finding into the ErrorLedger's upsert key.
 *
 * Two failure modes, both bugs, pulling in opposite directions:
 *   - fragmentation: "I have 30 years" and "I have 25 years" landing in
 *     separate rows, so frequency never climbs and the ledger never notices a
 *     habit;
 *   - collision: unrelated mistakes sharing a row, so the ledger reports a
 *     habit that does not exist.
 *
 * The compromise: strip everything that varies without changing the mistake
 * (case, punctuation, specific numbers, whitespace), then keep the first
 * PATTERN_TOKENS tokens — the head of an utterance is what carries the
 * construction, and an unbounded key would fragment on every trailing word.
 */
const PATTERN_TOKENS = 4;

export function toPattern(type, text) {
  const key = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, PATTERN_TOKENS)
    .join(" ");
  return `${type}:${key}`;
}
```

- [ ] **Step 4: Run the tests**

```bash
npm --prefix server test -- feedback-pattern
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/feedback/pattern.js server/test/feedback-pattern.test.js
git commit -m "feat(server): normalize findings into ledger pattern keys"
```

---

## Task 4: Delivery metrics

Pure arithmetic. No I/O, no clock.

**Files:**
- Create: `server/src/metrics/delivery.js`
- Create: `server/test/metrics-delivery.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeDelivery({ text, prosody, sessionPhonationMs, sessionSyllables })` →
  `{ hesitation: { band, basis, midPhrasePauses, fillers, selfRepairs }, sessionFluency: number | null }`.
  `band` is `"steady" | "some" | "effortful"`. `basis` is `"audio" | "text-only"`.
  `prosody` is the M7 slice-1 shape `{ total, internal, boundary, unknown }` or `null`.

- [ ] **Step 1: Write the failing test**

Create `server/test/metrics-delivery.test.js`:

```js
import { describe, it, expect } from "vitest";
import { computeDelivery } from "../src/metrics/delivery.js";

const clean = "I went to the market and bought some vegetables for dinner tonight";

describe("computeDelivery — hesitation", () => {
  it("is steady on clean text with only boundary pauses", () => {
    const out = computeDelivery({
      text: clean,
      prosody: { total: 2, internal: 0, boundary: 2, unknown: 0 },
    });
    expect(out.hesitation.band).toBe("steady");
    expect(out.hesitation.basis).toBe("audio");
    expect(out.hesitation.midPhrasePauses).toBe(0);
  });

  it("counts fillers and self-repairs from the text", () => {
    const out = computeDelivery({
      text: "I um went to the uh market, I mean the shop, you know",
      prosody: null,
    });
    expect(out.hesitation.fillers).toBe(3); // um, uh, you know
    expect(out.hesitation.selfRepairs).toBe(1); // I mean
  });

  it("reports text-only basis when there is no prosody", () => {
    expect(computeDelivery({ text: clean, prosody: null }).hesitation.basis).toBe("text-only");
  });

  it("escalates to effortful when mid-phrase pauses dominate", () => {
    const out = computeDelivery({
      text: "I wanted to go but",
      prosody: { total: 6, internal: 5, boundary: 1, unknown: 0 },
    });
    expect(out.hesitation.band).toBe("effortful");
  });
});

describe("computeDelivery — sessionFluency", () => {
  it("is null below the phonation floor", () => {
    const out = computeDelivery({ text: clean, prosody: null, sessionPhonationMs: 4999, sessionSyllables: 20 });
    expect(out.sessionFluency).toBeNull();
  });

  it("is a number at or above the floor", () => {
    const out = computeDelivery({ text: clean, prosody: null, sessionPhonationMs: 6000, sessionSyllables: 27 });
    expect(typeof out.sessionFluency).toBe("number");
    expect(out.sessionFluency).toBeGreaterThanOrEqual(0);
    expect(out.sessionFluency).toBeLessThanOrEqual(100);
  });

  it("penalises both directions — the target band scores higher than fast or slow", () => {
    const score = (syll, ms) => computeDelivery({ text: clean, prosody: null, sessionPhonationMs: ms, sessionSyllables: syll }).sessionFluency;
    const onTarget = score(40, 10000); // 4.0 syll/s
    const tooFast = score(85, 10000);  // 8.5 syll/s
    const tooSlow = score(15, 10000);  // 1.5 syll/s
    expect(onTarget).toBeGreaterThan(tooFast);
    expect(onTarget).toBeGreaterThan(tooSlow);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- metrics-delivery
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/metrics/delivery.js`:

```js
/**
 * Objective delivery signals. No LLM judgement, no I/O, no clock — arithmetic
 * over data that already exists, so it can be tested against constructed
 * inputs with closed-form expectations (spec §6).
 */

/**
 * Spoken hesitation markers. "I mean" is deliberately NOT here — it is a
 * repair marker and lives in SELF_REPAIRS. Listing it in both would
 * double-count the same three words against the learner.
 */
const FILLERS = [
  /\byou know\b/gi, /\bsort of\b/gi, /\bkind of\b/gi,
  /\bum+\b/gi, /\buh+\b/gi, /\ber+\b/gi, /\bhmm+\b/gi, /\blike\b/gi,
];
/** Explicit self-repair markers — the learner audibly restarting. */
const SELF_REPAIRS = [/\bi mean\b/gi, /\bsorry,? no\b/gi, /\bno wait\b/gi, /\bthat is\b/gi];

/** de Jong & Wempe: below this, a per-turn rate is noise (spec §6.2). */
const MIN_PHONATION_MS = 5000;
/** Centre of the English articulation-rate band, syllables per second. */
const TARGET_SYLL_PER_SEC = 4.4;
/** Distance from target, in syll/s, at which the score reaches 0. */
const FLUENCY_HALF_WIDTH = 3.2;

/**
 * UNCALIBRATED — spec §11.1. Band edges on mid-phrase pauses + fillers +
 * self-repairs per 10 words. These are starting values, to be re-fitted
 * against the learner's own first sessions rather than defended as measured.
 * Same convention as PAUSE_NOTE_TURN_INTERVAL in useConversation.js.
 */
const SOME_PER_10W = 1.0;
const EFFORTFUL_PER_10W = 2.5;

export function computeDelivery({ text, prosody = null, sessionPhonationMs = 0, sessionSyllables = 0 }) {
  const words = countWords(text);
  const fillers = countMatches(text, FILLERS);
  const selfRepairs = countMatches(text, SELF_REPAIRS);
  const midPhrasePauses = prosody ? prosody.internal : 0;

  const per10w = words === 0 ? 0 : ((midPhrasePauses + fillers + selfRepairs) / words) * 10;
  const band = per10w >= EFFORTFUL_PER_10W ? "effortful" : per10w >= SOME_PER_10W ? "some" : "steady";

  return {
    hesitation: {
      band,
      basis: prosody ? "audio" : "text-only",
      midPhrasePauses,
      fillers,
      selfRepairs,
    },
    sessionFluency: articulationScore(sessionPhonationMs, sessionSyllables),
  };
}

function countWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function countMatches(text, patterns) {
  const source = String(text ?? "");
  return patterns.reduce((n, re) => n + (source.match(re)?.length ?? 0), 0);
}

/**
 * Curvilinear: both directions are penalised. L1-Spanish speakers
 * characteristically run fast, so "faster is better" would reward the error.
 * Returns null below the phonation floor — the meter is absent, not zero,
 * because zero-for-lack-of-data is indistinguishable from zero-for-poor.
 */
function articulationScore(phonationMs, syllables) {
  if (phonationMs < MIN_PHONATION_MS || syllables <= 0) return null;
  const rate = syllables / (phonationMs / 1000);
  const distance = Math.abs(rate - TARGET_SYLL_PER_SEC);
  const score = 100 * (1 - distance / FLUENCY_HALF_WIDTH);
  return Math.round(Math.max(0, Math.min(100, score)));
}
```

- [ ] **Step 4: Run the tests**

```bash
npm --prefix server test -- metrics-delivery
```

Expected: PASS. If `fillers` comes out as 4 rather than 3, `/\bi mean\b/` has been left in `FILLERS` as well as `SELF_REPAIRS` — it belongs only in the latter.

- [ ] **Step 5: Commit**

```bash
git add server/src/metrics/delivery.js server/test/metrics-delivery.test.js
git commit -m "feat(server): objective delivery metrics — hesitation band and session fluency"
```

---

## Task 5: The ledger repository

**Files:**
- Create: `server/src/repo/ledger.js`
- Create: `server/test/ledger-repo.test.js`

**Interfaces:**
- Consumes: `toPattern` (Task 3) — used by callers, not by this module.
- Produces:
  - `getFrequencies(patterns)` → `Promise<Map<string, number>>` — missing patterns are absent from the map.
  - `recordFindings(entries)` → `Promise<void>`, where
    `entries: { pattern, type, example, explanation }[]`. Upserts: increments `frequency` and refreshes `lastSeenAt` on an existing row, creates with `frequency: 1` otherwise.

- [ ] **Step 1: Write the failing test**

Create `server/test/ledger-repo.test.js`:

```js
import { describe, it, expect } from "vitest";
import { recordFindings, getFrequencies } from "../src/repo/ledger.js";

const entry = (pattern) => ({ pattern, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." });

describe("ledger repo", () => {
  it("creates a row at frequency 1 and increments on the second sighting", async () => {
    const p = `grammar:test-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toBe(1);
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toBe(2);
  });

  it("omits unseen patterns from the map rather than returning zero", async () => {
    const freqs = await getFrequencies(["grammar:never-seen-at-all"]);
    expect(freqs.has("grammar:never-seen-at-all")).toBe(false);
  });

  it("accepts an empty batch without touching the database", async () => {
    await expect(recordFindings([])).resolves.toBeUndefined();
    expect((await getFrequencies([])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- ledger-repo
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/repo/ledger.js`:

```js
import { getPrisma } from "../db.js";

/**
 * The only module that reads or writes ErrorLedger. `pattern` carries @unique
 * since M0, which is what makes the twelfth sighting the same row rather than
 * a new one.
 *
 * M2 writes it; M4 is what schedules from it. Shipping M2 without the writes
 * would leave M4 starting from zero history.
 */

export async function getFrequencies(patterns) {
  if (!patterns.length) return new Map();
  const rows = await getPrisma().errorLedger.findMany({
    where: { pattern: { in: patterns } },
    select: { pattern: true, frequency: true },
  });
  return new Map(rows.map((r) => [r.pattern, r.frequency]));
}

export async function recordFindings(entries) {
  for (const { pattern, type, example, explanation } of entries) {
    await getPrisma().errorLedger.upsert({
      where: { pattern },
      update: { frequency: { increment: 1 }, lastSeenAt: new Date(), example, explanation },
      create: { pattern, type, example, explanation },
    });
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm --prefix server test -- ledger-repo
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo/ledger.js server/test/ledger-repo.test.js
git commit -m "feat(server): ErrorLedger repository with frequency upserts"
```

---

## Task 6: The LLM pass

**Files:**
- Create: `server/src/feedback/upgrades.js`
- Create: `server/test/feedback-upgrades.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `requestUpgrades({ utterance, history, harperFindings })` →
  `Promise<{ status: "ok" | "skipped" | "failed", upgrades: Upgrade[], extraCorrections: Correction[] }>`
  where `Upgrade = { original, upgraded, why }` and `Correction = { original, suggestion, message }`.
  Never throws. `skipped` means no API key.

- [ ] **Step 1: Write the failing test**

Create `server/test/feedback-upgrades.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestUpgrades } from "../src/feedback/upgrades.js";

const UTTERANCE = "I have a problem with my computer";

function mockLLM(payload, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    text: async () => "error body",
  });
}

describe("requestUpgrades", () => {
  beforeEach(() => { process.env.MISTRAL_API_KEY = "test-key"; });
  afterEach(() => { delete process.env.MISTRAL_API_KEY; vi.unstubAllGlobals(); });

  it("skips without an API key", async () => {
    delete process.env.MISTRAL_API_KEY;
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out).toEqual({ status: "skipped", upgrades: [], extraCorrections: [] });
  });

  it("returns a valid upgrade", async () => {
    vi.stubGlobal("fetch", mockLLM({
      upgrades: [{ original: "I have a problem with my computer", upgraded: "my laptop's been acting up", why: "Phrasal verb is more idiomatic." }],
      corrections: [],
    }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("ok");
    expect(out.upgrades).toHaveLength(1);
    expect(out.upgrades[0].upgraded).toBe("my laptop's been acting up");
  });

  it("DROPS an upgrade quoting text the learner never said", async () => {
    vi.stubGlobal("fetch", mockLLM({
      upgrades: [{ original: "I got a issue with my laptop", upgraded: "my laptop's playing up", why: "..." }],
      corrections: [],
    }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("ok");
    expect(out.upgrades).toEqual([]);
  });

  it("fails closed on invalid JSON, without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails on a 429 without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out).toEqual({ status: "failed", upgrades: [], extraCorrections: [] });
  });

  it("tells the model not to repeat Harper's findings", async () => {
    const fetchMock = mockLLM({ upgrades: [], corrections: [] });
    vi.stubGlobal("fetch", fetchMock);
    await requestUpgrades({
      utterance: UTTERANCE, history: [],
      harperFindings: [{ original: "a problem", message: "Use 'an issue'." }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prompt = body.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("a problem");
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- feedback-upgrades
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/feedback/upgrades.js`:

```js
const MISTRAL_BASE = "https://api.mistral.ai/v1";
const TIMEOUT_MS = 8000;

/**
 * The pedagogical pass. Deliberately NOT built on brain/: they share a
 * provider and a key, not an interface. brain/ has a conversational contract
 * (evaluateTurn -> coach_reply); this has an analytical one (text -> JSON).
 *
 * Never throws. A failure here costs the upgrades channel, never the turn.
 */
export async function requestUpgrades({ utterance, history = [], harperFindings = [] }) {
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) return { status: "skipped", upgrades: [], extraCorrections: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${MISTRAL_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.MISTRAL_MODEL?.trim() || "mistral-small-latest",
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt(utterance, history, harperFindings) },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[feedback] upgrades pass HTTP ${res.status}`);
      return { status: "failed", upgrades: [], extraCorrections: [] };
    }

    const data = await res.json();
    const parsed = parseStrict(data?.choices?.[0]?.message?.content);
    if (!parsed) return { status: "failed", upgrades: [], extraCorrections: [] };

    return {
      status: "ok",
      // The quoting guard is the load-bearing validation here (spec §8).
      upgrades: (parsed.upgrades ?? []).filter((u) => quotesTheLearner(u, utterance)).map(cleanUpgrade),
      extraCorrections: (parsed.corrections ?? []).filter((c) => quotesTheLearner(c, utterance)).map(cleanCorrection),
    };
  } catch (err) {
    console.warn("[feedback] upgrades pass failed:", err.message);
    return { status: "failed", upgrades: [], extraCorrections: [] };
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM = `You are a C1–C2 English coach analysing one utterance from a Spanish-speaking adult learner.

Return ONLY JSON of this exact shape:
{"upgrades":[{"original":"...","upgraded":"...","why":"..."}],"corrections":[{"original":"...","suggestion":"...","message":"..."}]}

"upgrades" is the important channel: language that is already CORRECT but plain, and what a C1 speaker would have reached for instead — collocation, phrasal verb, register, naturalness. At most 2.
"corrections" is only for real errors that rule-based checking would miss (register, collocation, word choice). At most 2.

HARD RULE: every "original" MUST be copied verbatim, character for character, from the learner's utterance. Never paraphrase it, never correct it, never invent it. If you cannot quote it exactly, omit the item.
Do not comment on pronunciation. Do not add fields.`;

function userPrompt(utterance, history, harperFindings) {
  const context = history.slice(-4).map((m) => `${m.role}: ${m.text}`).join("\n") || "(none)";
  const covered = harperFindings.length
    ? harperFindings.map((f) => `- "${f.original}": ${f.message}`).join("\n")
    : "(none)";
  return `Recent conversation:\n${context}\n\nLearner's utterance:\n${utterance}\n\nAlready covered by rule-based checking — do NOT repeat these:\n${covered}`;
}

function parseStrict(content) {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.upgrades && !Array.isArray(parsed.upgrades)) return null;
    if (parsed.corrections && !Array.isArray(parsed.corrections)) return null;
    return parsed;
  } catch {
    // No retry: it doubles cost and latency for a panel nobody is blocked on.
    return null;
  }
}

/**
 * An item quoting words the learner never said destroys trust in the whole
 * panel, irrecoverably. Substring check against the exact utterance.
 */
function quotesTheLearner(item, utterance) {
  const original = item?.original;
  if (typeof original !== "string" || !original.trim()) return false;
  const kept = utterance.includes(original);
  if (!kept) console.warn(`[feedback] dropped hallucinated quote: ${JSON.stringify(original)}`);
  return kept;
}

function cleanUpgrade(u) {
  return { original: u.original, upgraded: String(u.upgraded ?? ""), why: String(u.why ?? "") };
}

function cleanCorrection(c) {
  return { original: c.original, suggestion: String(c.suggestion ?? ""), message: String(c.message ?? "") };
}
```

- [ ] **Step 4: Run the tests**

```bash
npm --prefix server test -- feedback-upgrades
```

Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/feedback/upgrades.js server/test/feedback-upgrades.test.js
git commit -m "feat(server): LLM upgrades pass with a hallucinated-quote guard"
```

---

## Task 7: Orchestration

**Files:**
- Create: `server/src/feedback/index.js`
- Create: `server/test/feedback-orchestration.test.js`

**Interfaces:**
- Consumes: `lintUtterance`, `harperStatus` (T2); `toPattern` (T3); `computeDelivery` (T4); `getFrequencies`, `recordFindings` (T5); `requestUpgrades` (T6).
- Produces: `buildFeedback({ utterance, history, prosody, sessionPhonationMs, sessionSyllables })` →
  `Promise<FeedbackPayload>` matching spec §5. Never throws.

- [ ] **Step 1: Write the failing test**

Create `server/test/feedback-orchestration.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/feedback/harper.js", () => ({
  lintUtterance: vi.fn(),
  harperStatus: vi.fn(() => "ok"),
  setupHarper: vi.fn(),
}));
vi.mock("../src/feedback/upgrades.js", () => ({ requestUpgrades: vi.fn() }));
vi.mock("../src/repo/ledger.js", () => ({ getFrequencies: vi.fn(), recordFindings: vi.fn() }));

const { lintUtterance, harperStatus } = await import("../src/feedback/harper.js");
const { requestUpgrades } = await import("../src/feedback/upgrades.js");
const { getFrequencies, recordFindings } = await import("../src/repo/ledger.js");
const { buildFeedback } = await import("../src/feedback/index.js");

const UTTERANCE = "I have 30 years and the people is nice and I make a party";

const finding = (original, lintKind = "Agreement") => ({
  span: [UTTERANCE.indexOf(original), UTTERANCE.indexOf(original) + original.length],
  original, suggestion: "x", message: "m", lintKind, source: "harper",
});

beforeEach(() => {
  vi.clearAllMocks();
  getFrequencies.mockResolvedValue(new Map());
  recordFindings.mockResolvedValue(undefined);
  requestUpgrades.mockResolvedValue({ status: "ok", upgrades: [], extraCorrections: [] });
  harperStatus.mockReturnValue("ok");
});

describe("buildFeedback", () => {
  it("caps corrections at 2 and upgrades at 1", async () => {
    lintUtterance.mockResolvedValue([finding("I have 30 years"), finding("the people is"), finding("I make a party")]);
    requestUpgrades.mockResolvedValue({
      status: "ok",
      upgrades: [
        { original: "I have 30 years", upgraded: "I'm 30", why: "a" },
        { original: "the people is nice", upgraded: "everyone's lovely", why: "b" },
      ],
      extraCorrections: [],
    });
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections).toHaveLength(2);
    expect(out.upgrades).toHaveLength(1);
  });

  it("still writes the overflow to the ledger", async () => {
    lintUtterance.mockResolvedValue([finding("I have 30 years"), finding("the people is"), finding("I make a party")]);
    await buildFeedback({ utterance: UTTERANCE });
    expect(recordFindings).toHaveBeenCalledTimes(1);
    expect(recordFindings.mock.calls[0][0]).toHaveLength(3); // all three, not the capped two
  });

  it("orders by the learner's historical frequency, not by discovery order", async () => {
    lintUtterance.mockResolvedValue([finding("the people is"), finding("I have 30 years")]);
    const { toPattern } = await import("../src/feedback/pattern.js");
    getFrequencies.mockResolvedValue(new Map([[toPattern("grammar", "I have 30 years"), 9]]));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections[0].original).toBe("I have 30 years");
  });

  it("reports pass status honestly", async () => {
    lintUtterance.mockResolvedValue([]);
    requestUpgrades.mockResolvedValue({ status: "skipped", upgrades: [], extraCorrections: [] });
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.passes).toEqual({ mechanical: "ok", pedagogical: "skipped" });
  });

  it("marks the mechanical pass failed when Harper throws, and still returns", async () => {
    lintUtterance.mockRejectedValue(new Error("wasm exploded"));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.passes.mechanical).toBe("failed");
    expect(out.corrections).toEqual([]);
  });

  it("marks it unavailable when Harper never loaded", async () => {
    harperStatus.mockReturnValue("unavailable");
    lintUtterance.mockResolvedValue([]);
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.passes.mechanical).toBe("unavailable");
  });

  it("survives a ledger failure", async () => {
    lintUtterance.mockResolvedValue([finding("I have 30 years")]);
    recordFindings.mockRejectedValue(new Error("db down"));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections).toHaveLength(1);
  });

  it("carries the hesitation block and a null sessionFluency below the floor", async () => {
    lintUtterance.mockResolvedValue([]);
    const out = await buildFeedback({ utterance: UTTERANCE, sessionPhonationMs: 1000, sessionSyllables: 5 });
    expect(out.hesitation.band).toBeDefined();
    expect(out.sessionFluency).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- feedback-orchestration
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/feedback/index.js`:

```js
import { lintUtterance, harperStatus } from "./harper.js";
import { requestUpgrades } from "./upgrades.js";
import { toPattern } from "./pattern.js";
import { computeDelivery } from "../metrics/delivery.js";
import { getFrequencies, recordFindings } from "../repo/ledger.js";

const MAX_CORRECTIONS = 2;
const MAX_UPGRADES = 1;

/**
 * Runs both passes IN SERIES (spec D8): Harper's findings go into the LLM
 * prompt so the model is not spending its budget re-reporting articles.
 * Parallelising would save microseconds and destroy the division of labour
 * that justifies having two passes.
 *
 * Never throws. Every sub-failure degrades one channel, never the response.
 */
export async function buildFeedback({ utterance, history = [], prosody = null, sessionPhonationMs = 0, sessionSyllables = 0 }) {
  let mechanical = harperStatus();
  let harperFindings = [];
  if (mechanical === "ok") {
    try {
      harperFindings = await lintUtterance(utterance);
    } catch (err) {
      console.warn("[feedback] Harper threw on this input:", err.message);
      mechanical = "failed";
    }
  }

  const llm = await requestUpgrades({ utterance, history, harperFindings });

  const corrections = [
    ...harperFindings.map((f) => ({
      span: f.span,
      original: f.original,
      suggestion: f.suggestion,
      message: f.message,
      kind: kindFor(f.lintKind),
      source: "harper",
    })),
    ...llm.extraCorrections.map((c) => ({
      span: spanOf(utterance, c.original),
      original: c.original,
      suggestion: c.suggestion,
      message: c.message,
      kind: "register",
      source: "llm",
    })),
  ].map((c) => ({ ...c, pattern: toPattern(c.kind, c.original) }));

  const upgrades = llm.upgrades.map((u) => ({ ...u, pattern: toPattern("vocab", u.original) }));

  const frequencies = await safeFrequencies([...corrections, ...upgrades].map((x) => x.pattern));
  const byFrequency = (a, b) => (frequencies.get(b.pattern) ?? 0) - (frequencies.get(a.pattern) ?? 0);
  corrections.sort(byFrequency);
  upgrades.sort(byFrequency);

  // Everything found is written, including what the cap hides. The cap limits
  // what the learner sees, not what the system knows.
  await safeRecord([
    ...corrections.map((c) => ({ pattern: c.pattern, type: c.kind, example: c.original, explanation: c.message })),
    ...upgrades.map((u) => ({ pattern: u.pattern, type: "vocab", example: u.original, explanation: u.why })),
  ]);

  const { hesitation, sessionFluency } = computeDelivery({ text: utterance, prosody, sessionPhonationMs, sessionSyllables });

  return {
    corrections: corrections.slice(0, MAX_CORRECTIONS),
    upgrades: upgrades.slice(0, MAX_UPGRADES),
    hesitation,
    sessionFluency,
    passes: { mechanical, pedagogical: llm.status },
  };
}

/** Harper's documented LintKind inventory, mapped onto the ledger's types. */
const VOCAB_KINDS = new Set(["WordChoice", "Malapropism", "Eggcorn", "Spelling", "Typo"]);
const REGISTER_KINDS = new Set(["Style", "Enhancement", "Redundancy", "Readability", "Regionalism"]);

function kindFor(lintKind) {
  if (VOCAB_KINDS.has(lintKind)) return "vocab";
  if (REGISTER_KINDS.has(lintKind)) return "register";
  return "grammar";
}

/** The LLM pass has no offsets; recover them from the verified quote. */
function spanOf(utterance, original) {
  const start = utterance.indexOf(original);
  return start < 0 ? null : [start, start + original.length];
}

async function safeFrequencies(patterns) {
  try {
    return await getFrequencies(patterns);
  } catch (err) {
    console.warn("[feedback] ledger read failed, falling back to discovery order:", err.message);
    return new Map();
  }
}

async function safeRecord(entries) {
  if (!entries.length) return;
  try {
    await recordFindings(entries);
  } catch (err) {
    console.warn("[feedback] ledger write failed, continuing:", err.message);
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm --prefix server test -- feedback-orchestration
```

Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/feedback/index.js server/test/feedback-orchestration.test.js
git commit -m "feat(server): orchestrate both feedback passes with caps and frequency ordering"
```

---

## Task 8: The endpoint

**Files:**
- Create: `server/src/routes/feedback.js`
- Create: `server/test/feedback-route.test.js`
- Modify: `server/src/app.js`
- Modify: `server/src/index.js`

**Interfaces:**
- Consumes: `buildFeedback` (T7); `saveTurnFeedback`, `getTurnFeedback` (T1); `harperStatus`, `setupHarper` (T2).
- Produces: `POST /feedback`; `GET /health` gains `feedback: "ok" | "unavailable"`.

- [ ] **Step 1: Write the failing test**

Create `server/test/feedback-route.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../src/feedback/index.js", () => ({ buildFeedback: vi.fn() }));

const { buildFeedback } = await import("../src/feedback/index.js");
const { app } = await import("../src/app.js");

const PAYLOAD = {
  corrections: [], upgrades: [],
  hesitation: { band: "steady", basis: "text-only", midPhrasePauses: 0, fillers: 0, selfRepairs: 0 },
  sessionFluency: null,
  passes: { mechanical: "ok", pedagogical: "ok" },
};

beforeEach(() => {
  vi.clearAllMocks();
  buildFeedback.mockResolvedValue(PAYLOAD);
});

async function makeTurn(utterance) {
  const res = await request(app).post("/turn").send({ utterance });
  return res.body.turnId;
}

describe("POST /feedback", () => {
  it("400s without an utterance", async () => {
    const res = await request(app).post("/feedback").send({ turnId: "x" });
    expect(res.status).toBe(400);
  });

  it("returns the payload", async () => {
    const turnId = await makeTurn("I have 30 years");
    const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(res.status).toBe(200);
    expect(res.body.passes).toEqual({ mechanical: "ok", pedagogical: "ok" });
  });

  it("is idempotent: a second call returns the stored payload without recomputing", async () => {
    const turnId = await makeTurn("I have 30 years");
    await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    const second = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(second.status).toBe(200);
    expect(buildFeedback).toHaveBeenCalledTimes(1);
  });

  it("still answers when there is no turnId to persist against", async () => {
    const res = await request(app).post("/feedback").send({ utterance: "no turn id here" });
    expect(res.status).toBe(200);
    expect(res.body.passes.mechanical).toBe("ok");
  });

  it("502s when the whole build fails", async () => {
    buildFeedback.mockRejectedValue(new Error("everything is on fire"));
    const res = await request(app).post("/feedback").send({ utterance: "boom" });
    expect(res.status).toBe(502);
  });

  it("reports the mechanical pass in /health", async () => {
    const res = await request(app).get("/health");
    expect(["ok", "unavailable"]).toContain(res.body.feedback);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- feedback-route
```

Expected: FAIL — 404 on `/feedback`.

- [ ] **Step 3: Implement the route**

Create `server/src/routes/feedback.js`:

```js
import { Router } from "express";
import { buildFeedback } from "../feedback/index.js";
import { saveTurnFeedback, getTurnFeedback } from "../repo/session.js";

const router = Router();

/**
 * POST /feedback
 * body: { utterance, turnId?, sessionId?, history?, prosody?,
 *         sessionPhonationMs?, sessionSyllables? }
 *
 * Deferred, per-turn structured feedback (spec D1/D7). The coach has already
 * replied by the time this runs — nothing is blocked on it.
 *
 * `utterance` MUST be byte-identical to the one sent to /turn: the correction
 * spans are offsets into it.
 */
router.post("/", async (req, res) => {
  const { utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  // Idempotency (spec §7.2): a retry must not inflate ledger frequencies.
  // Also yields caching for free — a reload does not re-pay the LLM call.
  if (turnId) {
    const stored = await getTurnFeedback(turnId).catch(() => null);
    if (stored) return res.json(stored);
  }

  let payload;
  try {
    payload = await buildFeedback({
      utterance,
      history: Array.isArray(history) ? history : [],
      prosody: prosody ?? null,
      sessionPhonationMs: Number(sessionPhonationMs) || 0,
      sessionSyllables: Number(sessionSyllables) || 0,
    });
  } catch (err) {
    console.error("[feedback] build failed:", err);
    return res.status(502).json({ error: "Feedback could not be generated.", detail: String(err?.message ?? err) });
  }

  // Persistence must never cost the payload — the rule /turn has followed
  // since M3.
  if (turnId) {
    try {
      await saveTurnFeedback(turnId, payload);
    } catch (dbErr) {
      console.warn("[feedback] persistence failed, continuing:", dbErr.message);
    }
  }

  return res.json(payload);
});

export default router;
```

- [ ] **Step 4: Mount it and extend `/health`**

In `server/src/app.js`, add the imports:

```js
import feedbackRouter from "./routes/feedback.js";
import { harperStatus } from "./feedback/harper.js";
```

Add `feedback: harperStatus(),` to the `/health` response object, and mount the router beside `/turn`:

```js
app.use("/feedback", feedbackRouter);
```

In `server/src/index.js`, load the WASM before listening — never lazily, or the learner's first turn pays for it. Add the import and await it around the existing `app.listen` call:

```js
import { setupHarper } from "./feedback/harper.js";

await setupHarper();
```

- [ ] **Step 5: Run the whole server suite**

```bash
npm --prefix server test
npm --prefix server run test:coverage
```

Expected: PASS, and coverage ≥80% on all four metrics for `src/feedback/**` and `src/metrics/**`.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/feedback.js server/src/app.js server/src/index.js server/test/feedback-route.test.js
git commit -m "feat(server): POST /feedback with turn-keyed idempotency"
```

---

## Task 9: The coach pushes back

Spec D3. Prompt-only, no new calls, no new latency.

**Files:**
- Modify: `server/src/prompts/coach-system.js`
- Create: `server/test/coach-prompt.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `coachSystemM1` (kept, frozen), `coachSystemM2` (new default), and
  `selectCoachPrompt()` → the active prompt string, resolved from
  `COACH_PROMPT` (`"m1" | "m2"`, default `"m2"`). `server/src/brain/mistral.js`
  calls the selector rather than importing a constant.

**Why the M1 prompt survives:** it is the only baseline against which "the
pushier coach is actually better" can be checked, and that comparison cannot be
made from a diff — it needs both prompts runnable. An unused export would be
deleted as dead code on the next sweep, so it goes behind an env switch, the
same way `brain`, `tts`, `stt` and `pron` already work.

- [ ] **Step 1: Write the failing test**

Create `server/test/coach-prompt.test.js`:

```js
import { describe, it, expect, afterEach } from "vitest";
import { coachSystemM1, coachSystemM2, selectCoachPrompt } from "../src/prompts/coach-system.js";

afterEach(() => { delete process.env.COACH_PROMPT; });

describe("coach system prompt", () => {
  it("targets C1–C2", () => {
    expect(coachSystemM2).toContain("C1–C2");
  });

  it("no longer forbids correction as a blanket rule", () => {
    expect(coachSystemM2).not.toContain("Do NOT correct grammar yet");
  });

  it("still forbids inline correction in the spoken line", () => {
    // Corrections belong in the panel, not in the coach's voice.
    expect(coachSystemM2.toLowerCase()).toContain("do not correct");
  });

  it("carries an explicit pressure policy", () => {
    for (const cue of ["elaborate", "one-word", "abstract"]) {
      expect(coachSystemM2.toLowerCase()).toContain(cue);
    }
  });
});

describe("selectCoachPrompt", () => {
  it("defaults to M2", () => {
    expect(selectCoachPrompt()).toBe(coachSystemM2);
  });

  it("returns the frozen M1 baseline when asked", () => {
    process.env.COACH_PROMPT = "m1";
    expect(selectCoachPrompt()).toBe(coachSystemM1);
  });

  it("falls back to M2 on an unknown value rather than throwing", () => {
    process.env.COACH_PROMPT = "banana";
    expect(selectCoachPrompt()).toBe(coachSystemM2);
  });

  it("keeps the M1 baseline byte-frozen", () => {
    // If this ever needs updating, the baseline has stopped being a baseline.
    expect(coachSystemM1).toContain("level C1–C2");
    expect(coachSystemM1).toContain("Do NOT correct grammar yet");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix server test -- coach-prompt
```

Expected: FAIL — `coachSystemM2` is not exported.

- [ ] **Step 3: Implement**

Replace the contents of `server/src/prompts/coach-system.js`. Keep the M1
constant **exactly as it is today** — copy it, do not retype it, and do not
"improve" it. Its whole value is being the unchanged baseline:

```js
/**
 * M1 system prompt — FROZEN BASELINE. Kept so the M2 pressure policy can be
 * A/B'd against the prompt that shipped before it. Do not edit: the moment
 * this changes, it stops being a baseline. Select it with COACH_PROMPT=m1.
 */
export const coachSystemM1 = `You are SpeakUp, a warm and encouraging English conversation coach for a Spanish-speaking adult (level C1–C2).
Keep the conversation flowing naturally. Reply with ONE short, friendly turn — a question or a response — to keep them talking.
Speak only in English. Do NOT correct grammar yet, and do NOT add notes, labels, or translations. Output only your spoken line.`;

/**
 * M2 system prompt. Two jobs, both in the spoken line:
 *
 *   1. INPUT — the coach's own English is the teaching instrument. A coach
 *      that speaks flat English gives flat input, and the learner copies it.
 *   2. PRESSURE — production under time pressure is the thing reading apps
 *      cannot provide and the only condition under which speaking improves.
 *
 * Corrections do NOT belong here. They are the feedback panel's job
 * (POST /feedback), which is why the ban on correcting mid-conversation
 * survives from M1 even though M2 is the correction milestone.
 */
export const coachSystemM2 = `You are SpeakUp, a warm but demanding English conversation coach for a Spanish-speaking adult at level C1–C2.

YOUR ENGLISH IS THE LESSON. Speak the way an educated native speaker actually speaks: collocations, phrasal verbs, hedging, contractions, varied register. Never simplify your English for them — they are C1–C2 and flat input teaches flat output.

KEEP THE PRESSURE ON:
- Never accept a one-word or three-word answer. Ask them to elaborate.
- Follow up on the interesting half of what they said, not the safe half.
- When they sound comfortable, make the topic more abstract — from what happened to why it matters, from concrete to hypothetical.
- Ask questions that cannot be answered with yes or no.

Reply with ONE short spoken turn. Speak only in English. Do not correct their grammar, do not add notes, labels, or translations. Output only your spoken line.`;

/**
 * Resolved per call, not cached at module load, so flipping COACH_PROMPT and
 * restarting is the whole workflow — and so the tests can set the env var
 * without module mocking. Unknown values fall back to M2 rather than throwing:
 * a typo in .env should not take the coach offline.
 */
export function selectCoachPrompt() {
  return process.env.COACH_PROMPT?.trim().toLowerCase() === "m1" ? coachSystemM1 : coachSystemM2;
}
```

- [ ] **Step 4: Update the importer**

In `server/src/brain/mistral.js`, change both the import and the usage:

```js
import { selectCoachPrompt } from "../prompts/coach-system.js";
```

```js
      { role: "system", content: selectCoachPrompt() },
```

- [ ] **Step 5: Report it at boot**

`server/src/index.js` already reports the active providers at startup. Add the
prompt beside them so an A/B run cannot be misread later:

```js
console.log(`[brain] coach prompt = ${process.env.COACH_PROMPT?.trim().toLowerCase() === "m1" ? "m1 (baseline)" : "m2"}`);
```

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
```

Expected: PASS, including the four `selectCoachPrompt` cases.

- [ ] **Step 7: Commit**

```bash
git add server/src/prompts/coach-system.js server/src/brain/mistral.js server/src/index.js server/test/coach-prompt.test.js
git commit -m "feat(server): pushier C1-C2 coach prompt, with M1 kept as a switchable baseline"
```

---

## Task 10: Client transport

**Files:**
- Modify: `client/src/lib/api.js`
- Modify: `client/vite.config.js`

**Interfaces:**
- Consumes: `POST /feedback` (T8).
- Produces: `postFeedback({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables })` → `Promise<payload | null>`. **Returns `null` on any failure — never throws.** A missing panel must not surface as a conversation error.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/api.test.js`:

```js
import { describe, it, expect, vi, afterEach } from "vitest";
import { postFeedback } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("postFeedback", () => {
  it("returns the payload on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ corrections: [], upgrades: [], passes: { mechanical: "ok", pedagogical: "ok" } }),
    }));
    const out = await postFeedback({ utterance: "hi", turnId: "t1" });
    expect(out.passes.mechanical).toBe("ok");
  });

  it("returns null on a server error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });

  it("returns null when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix client test -- api
```

Expected: FAIL — `postFeedback` is not exported.

- [ ] **Step 3: Implement**

Append to `client/src/lib/api.js`:

```js
/**
 * Deferred structured feedback. Never throws: a missing panel is a degraded
 * view, not a conversation error, and must not surface as one.
 */
export async function postFeedback({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables }) {
  try {
    const res = await fetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add the dev proxy**

In `client/vite.config.js`, add to `server.proxy`:

```js
      "/feedback": "http://localhost:3001",
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix client test -- api
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api.js client/src/lib/api.test.js client/vite.config.js
git commit -m "feat(client): postFeedback transport that degrades to null"
```

---

## Task 11: The panel

**Files:**
- Create: `client/src/components/FeedbackPanel.jsx`
- Create: `client/src/components/FeedbackPanel.test.jsx`
- Modify: `client/src/components/__a11y__.test.jsx`

**Interfaces:**
- Consumes: the payload shape from T8.
- Produces: `<FeedbackPanel feedback={payload | null} />`. Renders nothing when `feedback` is `null`.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/FeedbackPanel.test.jsx`:

```jsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import FeedbackPanel from "./FeedbackPanel.jsx";

const base = {
  corrections: [], upgrades: [],
  hesitation: { band: "steady", basis: "audio", midPhrasePauses: 0, fillers: 0, selfRepairs: 0 },
  sessionFluency: null,
  passes: { mechanical: "ok", pedagogical: "ok" },
};

describe("FeedbackPanel", () => {
  it("renders nothing without feedback", () => {
    const { container } = render(<FeedbackPanel feedback={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a correction and its suggestion", () => {
    render(<FeedbackPanel feedback={{ ...base, corrections: [
      { span: [0, 13], original: "I have 30 years", suggestion: "I'm 30", message: "Age takes 'be'.", kind: "grammar", pattern: "p", source: "harper" },
    ] }} />);
    expect(screen.getByText(/I have 30 years/)).toBeInTheDocument();
    expect(screen.getByText(/I'm 30/)).toBeInTheDocument();
    expect(screen.getByText(/Age takes/)).toBeInTheDocument();
  });

  it("renders an upgrade", () => {
    render(<FeedbackPanel feedback={{ ...base, upgrades: [
      { original: "I have a problem", upgraded: "my laptop's been acting up", why: "More idiomatic.", pattern: "p" },
    ] }} />);
    expect(screen.getByText(/acting up/)).toBeInTheDocument();
  });

  it("says so when the pedagogical pass did not run", () => {
    render(<FeedbackPanel feedback={{ ...base, passes: { mechanical: "ok", pedagogical: "skipped" } }} />);
    expect(screen.getByText(/no api key/i)).toBeInTheDocument();
  });

  it("says so when the mechanical pass is unavailable", () => {
    render(<FeedbackPanel feedback={{ ...base, passes: { mechanical: "unavailable", pedagogical: "ok" } }} />);
    expect(screen.getByText(/grammar checker/i)).toBeInTheDocument();
  });

  it("never uses the word confidence", () => {
    const { container } = render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, band: "effortful" } }} />);
    expect(container.textContent.toLowerCase()).not.toContain("confidence");
  });

  it("flags a text-only measurement basis", () => {
    render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, basis: "text-only" } }} />);
    expect(screen.getByText(/typed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix client test -- FeedbackPanel
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `client/src/components/FeedbackPanel.jsx`:

```jsx
/**
 * The M2 feedback panel: at most 2 corrections and 1 upgrade (the cap is
 * enforced server-side; this component renders whatever it is given).
 *
 * The two channels are visually distinct on purpose. `corrections` is "you
 * said something wrong". `upgrades` is "you said something correct and grey" —
 * conflating them teaches the learner that plain English is an error.
 *
 * The hesitation band is NEVER labelled "confidence": it measures pausing and
 * self-repair, and the copy says only what the signal supports.
 */
const BAND_COPY = {
  steady: "Steady delivery",
  some: "Some hesitation",
  effortful: "Effortful delivery",
};

export default function FeedbackPanel({ feedback }) {
  if (!feedback) return null;
  const { corrections = [], upgrades = [], hesitation, passes } = feedback;

  return (
    <section
      aria-label="Feedback on your last turn"
      className="mt-2 ml-auto max-w-lg rounded-2xl border border-line/70 bg-ink-2/60 p-3 text-sm"
    >
      {corrections.map((c) => (
        <div key={c.pattern} className="mb-2 last:mb-0">
          <p className="leading-snug">
            <span className="line-through text-muted">{c.original}</span>
            <span aria-hidden="true" className="mx-2 text-muted">→</span>
            <span className="font-semibold text-user">{c.suggestion}</span>
          </p>
          <p className="text-[12px] text-muted mt-0.5">{c.message}</p>
        </div>
      ))}

      {upgrades.map((u) => (
        <div key={u.pattern} className="mb-2 last:mb-0 border-l-2 border-accent/60 pl-2">
          <p className="text-[11px] uppercase tracking-wide text-accent">Say it like a native</p>
          <p className="leading-snug">
            <span className="text-muted">{u.original}</span>
            <span aria-hidden="true" className="mx-2 text-muted">→</span>
            <span className="font-semibold text-accent">{u.upgraded}</span>
          </p>
          <p className="text-[12px] text-muted mt-0.5">{u.why}</p>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-muted">
        {hesitation && (
          <span title={`${hesitation.midPhrasePauses} mid-phrase pauses · ${hesitation.fillers} fillers · ${hesitation.selfRepairs} self-repairs`}>
            {BAND_COPY[hesitation.band]}
          </span>
        )}
        {hesitation?.basis === "text-only" && <span>· measured from typed text only</span>}
        {passes?.pedagogical === "skipped" && <span>· no API key, so no upgrades this turn</span>}
        {passes?.pedagogical === "failed" && <span>· the upgrade pass failed this turn</span>}
        {passes?.mechanical === "unavailable" && <span>· the grammar checker did not load</span>}
        {passes?.mechanical === "failed" && <span>· the grammar checker failed on this turn</span>}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add it to the accessibility suite**

Add the import to `client/src/components/__a11y__.test.jsx`:

```jsx
import FeedbackPanel from "./FeedbackPanel.jsx";
```

and this case alongside the existing ones (match the surrounding file's `it`/`axe` style — it already imports `axe` and `render`):

```jsx
  it("FeedbackPanel has no violations", async () => {
    const { container } = render(
      <FeedbackPanel
        feedback={{
          corrections: [
            { span: [0, 15], original: "I have 30 years", suggestion: "I'm 30", message: "Age takes 'be'.", kind: "grammar", pattern: "grammar:i have # years", source: "harper" },
          ],
          upgrades: [
            { original: "I have a problem", upgraded: "my laptop's been acting up", why: "More idiomatic.", pattern: "vocab:i have a problem" },
          ],
          hesitation: { band: "some", basis: "audio", midPhrasePauses: 2, fillers: 1, selfRepairs: 0 },
          sessionFluency: 72,
          passes: { mechanical: "ok", pedagogical: "ok" },
        }}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix client test -- FeedbackPanel __a11y__
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/FeedbackPanel.jsx client/src/components/FeedbackPanel.test.jsx client/src/components/__a11y__.test.jsx
git commit -m "feat(client): FeedbackPanel with distinct corrections and upgrades channels"
```

---

## Task 12: Wire it into the conversation

The race in spec §8: feedback must land on the message that produced it, never on "the last message".

**Files:**
- Modify: `client/src/hooks/useConversation.js`
- Modify: `client/src/hooks/useConversation.test.js`
- Modify: `client/src/App.jsx`

**Interfaces:**
- Consumes: `postFeedback` (T10), `<FeedbackPanel />` (T11).
- Produces: each user message in `messages` gains `id: number` and `feedback: object | null`. The hook additionally returns `sessionFluency: number | null`.

- [ ] **Step 1: Write the failing test**

First extend the existing `../lib/api.js` mock at the top of
`client/src/hooks/useConversation.test.js`:

```js
vi.mock("../lib/api.js", () => ({
  postTurn: vi.fn(),
  postFeedback: vi.fn(),
  getHealth: vi.fn(),
}));
```

Note the public API is `submitText`, not `sendText` — check the hook's return
object if a name looks wrong. Then add these three cases:

```js
  it("attaches feedback to the message that produced it, not the newest one", async () => {
    const { postTurn, postFeedback } = await import("../lib/api.js");
    let resolveFirst;
    postFeedback
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ corrections: [], upgrades: [], passes: { mechanical: "ok", pedagogical: "ok" } });
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });

    const { result } = renderHook(() => useConversation());

    await act(async () => { await result.current.submitText("first utterance"); });
    await act(async () => { await result.current.submitText("second utterance"); });

    // The first turn's feedback arrives only now, after a second turn exists.
    await act(async () => {
      resolveFirst({
        corrections: [{ span: [0, 5], original: "first", suggestion: "1st", message: "m", kind: "grammar", pattern: "p", source: "harper" }],
        upgrades: [],
        passes: { mechanical: "ok", pedagogical: "ok" },
      });
    });

    const userMessages = result.current.messages.filter((m) => m.role === "user");
    expect(userMessages[0].feedback.corrections).toHaveLength(1);
    expect(userMessages[1].feedback).toBeNull();
  });

  // Spec §5.2: correction spans are offsets into this exact string.
  it("sends /feedback the byte-identical utterance it sent /turn", async () => {
    const { postTurn, postFeedback } = await import("../lib/api.js");
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const messy = "  I have 30 years, y'know...  ";
    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText(messy); });

    const sentToTurn = postTurn.mock.calls[0][0].utterance;
    const sentToFeedback = postFeedback.mock.calls[0][0].utterance;
    expect(sentToFeedback).toBe(sentToTurn);
  });

  it("leaves the conversation intact when feedback fails", async () => {
    const { postTurn, postFeedback } = await import("../lib/api.js");
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText("hello there"); });

    expect(result.current.error).toBeNull();
    expect(result.current.messages.filter((m) => m.role === "user")[0].feedback).toBeNull();
  });
```

If `submitText` trims before calling `runTurn`, the byte-identity test will
still pass as long as **the same trimmed string** reaches both calls — that is
the invariant. What it forbids is one path trimming and the other not.

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix client test -- useConversation
```

Expected: FAIL — `postFeedback` is not a function on the mock, and messages have no `feedback` field.

- [ ] **Step 3: Implement**

In `client/src/hooks/useConversation.js`:

Add to the import from `../lib/api.js`:

```js
import { postTurn, postFeedback, getHealth } from "../lib/api.js";
```

**Every message gets an id, not only user messages.** `App.jsx` currently keys
its list on the array index, which is the same class of bug as attaching
feedback by position. Change the initial state and every `setMessages` push to
carry one:

```js
  const [messages, setMessages] = useState([{ id: 0, role: "coach", text: GREETING }]);
```

Add two refs beside the existing ones (`nextMsgIdRef` starts at 1 because the
greeting took 0):

```js
  // Monotonic local ids. The client keys feedback by localId; the SERVER keys
  // idempotency by turnId. Different keys for different jobs: the client's id
  // exists before the server has replied.
  const nextMsgIdRef = useRef(1);
  const sessionPhonationRef = useRef(0);
```

The coach push in `runTurn` gains one too:

```js
      setMessages((prev) => [...prev, { id: nextMsgIdRef.current++, role: "coach", text: coach_reply, audio, audioFormat }]);
```

In `runTurn`, give the user message an id and a feedback slot:

```js
    const userMsg = { id: nextMsgIdRef.current++, role: "user", text: utterance, feedback: null };
```

After `setMessages((prev) => [...prev, { role: "coach", ... }]);` in the success path, add the deferred fetch. It is deliberately **not awaited** — the coach must start speaking now:

```js
      // Deferred feedback (spec D1): fire and forget. The panel fills in on an
      // already-rendered message; nothing here is allowed to block the voice.
      requestFeedback({ utterance, turnId, historyBefore, userMsg, prosody });
```

Destructure `turnId` from the `postTurn` result alongside `sessionId`.

Add the function below `runTurn`:

```js
  async function requestFeedback({ utterance, turnId, historyBefore, userMsg, prosody }) {
    const payload = await postFeedback({
      utterance,
      turnId,
      history: historyBefore,
      prosody,
      sessionPhonationMs: sessionPhonationRef.current,
      sessionSyllables: countSyllables(messagesRef.current),
    });
    if (!payload) return; // degraded view, not an error — never touch `error`

    // Match by the message's OWN id. Indexing off the end of the array would
    // attach this turn's feedback to whatever the learner said next.
    setMessages((prev) => prev.map((m) => (m.id === userMsg.id ? { ...m, feedback: payload } : m)));
    if (typeof payload.sessionFluency === "number") setSessionFluency(payload.sessionFluency);
  }
```

Add the state near the other `useState` calls:

```js
  const [sessionFluency, setSessionFluency] = useState(null);
```

Add a syllable estimate used only for the session-level rate (vowel-group counting is the standard cheap approximation):

```js
/** Cheap vowel-group syllable estimate — the session rate needs a count, not a phonetician. */
function countSyllables(messages) {
  return messages
    .filter((m) => m.role === "user")
    .reduce((n, m) => n + (m.text.toLowerCase().match(/[aeiouy]+/g)?.length ?? 0), 0);
}
```

Accumulate phonation where the pause profile is computed. In `computePauseProfile`, after `const counts = summarise(classified);`, add:

```js
    // Phonation = elapsed capture minus measured silence, the input the
    // session-level articulation rate needs (spec §6.2).
    sessionPhonationRef.current += Math.max(0, micNowMs() - (pauses.reduce((ms, p) => ms + p.durationMs, 0)));
```

Add `sessionFluency` to the hook's return object.

- [ ] **Step 4: Render the panel**

In `client/src/App.jsx`, add the import:

```jsx
import FeedbackPanel from "./components/FeedbackPanel.jsx";
```

Pass the new prop to the header:

```jsx
      <StatHeader
        totalXp={c.totalXp}
        turns={c.turns}
        sessionFluency={c.sessionFluency}
        brain={c.providers.brain}
        tts={c.providers.tts}
        stt={c.providers.stt}
      />
```

And replace the message list, keying on the message's own id now that it has
one:

```jsx
        {c.messages.map((m, i) => (
          <Fragment key={m.id}>
            <MessageBubble
              role={m.role}
              text={m.text}
              onReplay={m.role === "coach" && c.status === "idle" ? () => c.replay(m) : undefined}
            />
            {m.role === "user" && <FeedbackPanel feedback={m.feedback} />}
            {i === lastUserIndex && <PauseNote note={c.pauseNote} />}
          </Fragment>
        ))}
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix client test
npm --prefix client run test:coverage
```

Expected: PASS, all pre-existing hook tests included, coverage still ≥80%.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js client/src/App.jsx
git commit -m "feat(client): deferred feedback attached by message id, not position"
```

---

## Task 13: Session fluency in the header, and the docs

**Files:**
- Modify: `client/src/components/StatHeader.jsx`
- Modify: `client/src/components/__a11y__.test.jsx`
- Create: `client/src/components/StatHeader.test.jsx`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/voice-io-verification-checklist.md`
- Modify: `server/.env.example`

**Interfaces:**
- Consumes: `sessionFluency` from T12.
- Produces: `<StatHeader sessionFluency={number | null} … />` — the meter is absent, not zero, when `null`.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/StatHeader.test.jsx`:

```jsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import StatHeader from "./StatHeader.jsx";

describe("StatHeader session fluency", () => {
  it("shows no meter at all below the phonation floor", () => {
    render(<StatHeader totalXp={0} turns={0} sessionFluency={null} />);
    expect(screen.queryByLabelText(/delivery pace/i)).toBeNull();
  });

  it("shows the meter once there is a value", () => {
    render(<StatHeader totalXp={0} turns={0} sessionFluency={72} />);
    expect(screen.getByLabelText(/delivery pace/i)).toBeInTheDocument();
  });

  it("never prints a raw score or the word fluency as a number", () => {
    const { container } = render(<StatHeader totalXp={0} turns={0} sessionFluency={72} />);
    expect(container.textContent).not.toContain("72");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm --prefix client test -- StatHeader
```

Expected: FAIL — no such label.

- [ ] **Step 3: Implement**

In `client/src/components/StatHeader.jsx`, add `sessionFluency = null` to the props and render a bar inside the right-hand stat column, before `<Stat label="turns" … />`:

```jsx
      {sessionFluency !== null && (
        <div className="w-20" aria-label="delivery pace this session">
          <div className="h-1.5 rounded-full bg-ink-2 overflow-hidden ring-1 ring-line/60">
            <div
              className="h-full rounded-full bg-user transition-all duration-500"
              style={{ width: `${sessionFluency}%` }}
            />
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted mt-1">pace</div>
        </div>
      )}
```

The number is deliberately never printed: it is an internal index with no external calibration (spec §10).

- [ ] **Step 4: Add it to the accessibility suite**

In `client/src/components/__a11y__.test.jsx`, add `sessionFluency={72}` to the
props of the existing `StatHeader` render so the meter is exercised by `axe`:

```jsx
    const { container } = render(
      <StatHeader totalXp={120} turns={3} sessionFluency={72} brain="mistral" tts="kokoro" stt="none" />
    );
```

- [ ] **Step 5: Update the docs**

In `README.md`:
- Change the status badge from `M3 shipped · M7 in progress` to `M2 shipped · M7 in progress`.
- In the milestone table, change M2's state from `⏭️ next` to `✅ shipped 2026-08-02` and M4's to `⏭️ next`.
- In the "Grammar" section, remove the `Status: not shipped yet` blockquote and replace it with one sentence stating that both channels ship and pointing at the spec.
- Add `POST /feedback` to the endpoints table.
- Add a `feedback` row to the `GET /health` description.
- Update the test count after running the full suite.

In `docs/superpowers/plans/voice-io-verification-checklist.md`, append the human-evaluation item from spec §9.4: 20 recorded utterances, judged by hand once, checking whether `upgrades` are genuinely C1 and whether Harper's recall on L2 Spanish-speaker English is acceptable. Note the documented fallback (`vennify/t5-base-grammar-correction`) if recall proves poor.

In `server/.env.example`, add:

```bash
# M2 runs TWO LLM calls per turn: the coach's reply and the upgrades pass.
# Without a key, Harper still gives you real grammar corrections offline and
# free — only the `upgrades` channel goes quiet.
# MISTRAL_API_KEY=

# Which coach system prompt to run. m2 (default) pushes for elaboration and
# speaks C1-level English; m1 is the frozen pre-M2 baseline, kept so the two
# can be compared on real conversation. See the M2 spec §3 D3.
# COACH_PROMPT=m2
```

In `README.md`, add `COACH_PROMPT` to the provider/knob table alongside `brain`, `tts`, `stt` and `pron`.

- [ ] **Step 6: Run everything**

```bash
npm test
npm --prefix client run test:coverage
npm --prefix server run test:coverage
```

Expected: PASS on both suites, coverage ≥80% on all four metrics for both gated sets.

- [ ] **Step 7: Commit**

```bash
git add client/src/components README.md docs/superpowers/plans/voice-io-verification-checklist.md server/.env.example
git commit -m "feat(client): session pace meter, and make the docs true for M2"
```

---

## Verification debt (not automatable)

Per spec §9.4, one item must be done by hand and cannot be closed by this plan:

**20 recorded utterances, judged once.** For each: is the `upgrade` genuinely what a C1 speaker would say, or a paraphrase with airs? Did Harper miss errors a human would flag? Record the result in the verification checklist. If Harper's recall is poor on L2 Spanish-speaker English, the documented fallback is adding `vennify/t5-base-grammar-correction` as a third pass — a follow-up decision, not part of M2.
