# M4 — Error Ledger Exploitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ErrorLedger from a display-ranking input into a teaching loop — the coach periodically steers the conversation toward a construction the learner keeps failing, records whether they repeated the mistake, and the learner can see a compact read-only view of which habits are changing.

**Architecture:** Two new pure modules (`ledger/transitions.js` for the status state machine, `coach/probe.js` for probe selection) sit behind the existing `repo/ledger.js` I/O boundary, which gains four new functions plus a widened `getFrequencies`. `routes/turn.js` picks a probe before calling the brain and returns its pattern; the client carries that pattern as a `useRef` token to the *next* `/feedback` call, which resolves the outcome inside its existing idempotency gate. A new `GET /patterns` route and `PatternsPanel.jsx` component are the only user-visible surface.

**Tech Stack:** Express 5, Prisma/SQLite, Vitest (server: node env, client: jsdom + Testing Library), React 19.

## Global Constraints

- Every threshold this milestone introduces is a starting value, not a measurement — name it `UNCALIBRATED` in a comment, exactly like `PAUSE_NOTE_TURN_INTERVAL` in `useConversation.js` and the constants in `metrics/delivery.js`. Do not add `.env` entries for them — they are in-code constants, matching that precedent.
- `ledger/transitions.js` and `coach/probe.js` do no I/O — no `getPrisma()` import, no `Date.now()`/`new Date()` call inside either file. Callers pass in whatever "now" or "current state" the function needs.
- `repo/ledger.js` remains the only module that imports `getPrisma()` for `ErrorLedger`. `repo/session.js` remains the only module that touches `Session`/`Turn`.
- The ledger's `pattern` key (e.g. `grammar:i have # years`) is never rendered in the UI and never appears in a coach-facing prompt. Directives and panel copy are built from `example` and `explanation` only.
- `applyProbeOutcome` (the write that can mark a habit "resolved") runs **only** inside `routes/feedback.js`'s existing `computeAndPersist`, behind both the stored-payload idempotency check and the in-flight de-dupe map — never before them, never from a second call site. A retry must apply a probe outcome exactly once.
- Coverage gate (`server/vitest.config.js`'s `coverage.include`) is extended with `src/coach/**/*.js` and `src/ledger/**/*.js` in the same commit that creates those directories (Task 2 and Task 3 respectively) — not deferred to a later cleanup task.
- `server/test/global-setup.js` already runs `prisma db push` against `test.db` before the suite — a schema change in Task 1 is picked up by the test run with no extra step. `DATABASE_URL` must be set when running `npx prisma migrate dev` by hand from `server/` (`file:./dev.db`) — the npm scripts already do this via `--env-file=.env`; a fresh worktree with no `.env` needs it passed inline.

---

## File Map

```
server/src/
├── coach/
│   └── probe.js              NEW — chooseProbe(), PROBE_TURN_INTERVAL, MIN_PROBE_FREQUENCY, PROBE_POOL_SIZE
├── ledger/
│   └── transitions.js        NEW — nextLedgerState(), PROBE_PASSES_TO_RESOLVE
├── repo/
│   ├── session.js            MODIFY — + countUserTurns(sessionId)
│   └── ledger.js             MODIFY — getFrequencies widened; recordFindings resets on relapse;
│                              + getProbeCandidates, markProbed, applyProbeOutcome, listPatterns
├── feedback/
│   └── index.js               MODIFY — buildFeedback's byFrequency comparator (widened shape) +
│                              two new internal-only return fields (recordedPatterns, frequenciesBeforeWrite)
├── brain/
│   └── mistral.js            MODIFY — evaluateTurn accepts probeDirective, sent as a 2nd system message
├── routes/
│   ├── turn.js                MODIFY — turnsSoFar, probe selection, probe field on response, markProbed
│   ├── feedback.js            MODIFY — accepts probedPattern, attaches recurrence, returns probeResult
│   └── patterns.js            NEW — GET /patterns
└── app.js                     MODIFY — wire patternsRouter

client/src/
├── lib/
│   └── api.js                 MODIFY — + getPatterns(); postFeedback accepts probedPattern
├── hooks/
│   └── useConversation.js     MODIFY — pendingProbeRef, threads probe/probedPattern
└── components/
    ├── PatternsPanel.jsx      NEW — read-only patterns view
    ├── StatHeader.jsx         MODIFY — + onTogglePatterns button
    └── App.jsx                MODIFY — showPatterns state, renders PatternsPanel
```

---

### Task 1: Schema — `ErrorLedger.probesPassed` / `ErrorLedger.lastProbedAt`

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/<timestamp>_m4_probe_columns/migration.sql` (generated)

**Interfaces:**
- Produces: `ErrorLedger` rows now carry `probesPassed: Int` (default `0`) and `lastProbedAt: DateTime | null`, consumed by every task after this one.

- [ ] **Step 1: Add the two columns to the schema**

In `server/prisma/schema.prisma`, the `ErrorLedger` model currently reads:

```prisma
model ErrorLedger {
  id          String   @id @default(cuid())
  type        String // "grammar" | "vocab" | "register" | "pronunciation"
  pattern     String   @unique // clave para upsert
  example     String?
  explanation String?
  frequency   Int      @default(1)
  status      String   @default("active") // "active" | "improving" | "resolved"
  lastSeenAt  DateTime @default(now())
  createdAt   DateTime @default(now())
}
```

Change it to:

```prisma
model ErrorLedger {
  id           String    @id @default(cuid())
  type         String // "grammar" | "vocab" | "register" | "pronunciation"
  pattern      String    @unique // clave para upsert
  example      String?
  explanation  String?
  frequency    Int       @default(1)
  status       String    @default("active") // "active" | "improving" | "resolved"
  // M4: how many consecutive probes this pattern has passed since its last
  // relapse. Capped at PROBE_PASSES_TO_RESOLVE by ledger/transitions.js.
  probesPassed Int       @default(0)
  lastSeenAt   DateTime  @default(now())
  // M4: when this pattern was last chosen as a probe (not when it was last
  // seen). Null means never probed. Drives oldest-first rotation (spec §5.3).
  lastProbedAt DateTime?
  createdAt    DateTime  @default(now())
}
```

- [ ] **Step 2: Generate and apply the migration**

Run from `server/`:

```bash
DATABASE_URL="file:./dev.db" npx prisma migrate dev --name m4_probe_columns
```

Expected: a new directory under `server/prisma/migrations/` containing a `migration.sql` with two `ALTER TABLE "ErrorLedger" ADD COLUMN` statements, and "Your database is now in sync with your schema."

- [ ] **Step 3: Verify the test suite still passes (schema-only change)**

Run: `npm --prefix server test`
Expected: PASS, same count as before this change — `global-setup.js`'s `prisma db push` picks up the new columns automatically.

- [ ] **Step 4: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat(server): add ErrorLedger.probesPassed and lastProbedAt (M4 schema)"
```

---

### Task 2: `ledger/transitions.js` — the pure status state machine

**Files:**
- Create: `server/src/ledger/transitions.js`
- Test: `server/test/ledger-transitions.test.js`
- Modify: `server/vitest.config.js:16` (coverage include)

**Interfaces:**
- Produces: `nextLedgerState(current, event)` where `current: { probesPassed: number } | null` and `event: "passed" | "failed" | "sighted"`, returning `{ status: "active"|"improving"|"resolved", probesPassed: number }`. `PROBE_PASSES_TO_RESOLVE` (named export, `UNCALIBRATED`, default `3`). Consumed by Task 5's `repo/ledger.js` (`recordFindings`, `applyProbeOutcome`).

- [ ] **Step 1: Write the failing tests**

Create `server/test/ledger-transitions.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { nextLedgerState, PROBE_PASSES_TO_RESOLVE } from "../src/ledger/transitions.js";

describe("ledger/transitions — nextLedgerState", () => {
  it("a passed probe increments probesPassed and moves to improving before the threshold", () => {
    const next = nextLedgerState({ probesPassed: 0 }, "passed");
    expect(next).toEqual({ status: "improving", probesPassed: 1 });
  });

  it("resolves exactly at PROBE_PASSES_TO_RESOLVE consecutive passes", () => {
    let state = { probesPassed: 0 };
    for (let i = 0; i < PROBE_PASSES_TO_RESOLVE - 1; i += 1) {
      state = nextLedgerState(state, "passed");
      expect(state.status).toBe("improving");
    }
    state = nextLedgerState(state, "passed");
    expect(state).toEqual({ status: "resolved", probesPassed: PROBE_PASSES_TO_RESOLVE });
  });

  it("does not grow probesPassed past the threshold on a defensive extra pass", () => {
    const state = nextLedgerState({ probesPassed: PROBE_PASSES_TO_RESOLVE }, "passed");
    expect(state.probesPassed).toBe(PROBE_PASSES_TO_RESOLVE);
    expect(state.status).toBe("resolved");
  });

  it("a failed probe resets to active with the counter zeroed, even mid-streak", () => {
    const next = nextLedgerState({ probesPassed: 2 }, "failed");
    expect(next).toEqual({ status: "active", probesPassed: 0 });
  });

  it("an ordinary sighting in free conversation resets to active with the counter zeroed", () => {
    const next = nextLedgerState({ probesPassed: 1 }, "sighted");
    expect(next).toEqual({ status: "active", probesPassed: 0 });
  });

  it("relapse path: resolved, then an ordinary sighting returns it to active at zero", () => {
    let state = { probesPassed: PROBE_PASSES_TO_RESOLVE };
    state = nextLedgerState(state, "passed"); // still resolved, capped
    expect(state.status).toBe("resolved");
    state = nextLedgerState(state, "sighted"); // the learner made the mistake again
    expect(state).toEqual({ status: "active", probesPassed: 0 });
  });

  it("current may be null for events that don't read it (failed/sighted)", () => {
    expect(nextLedgerState(null, "failed")).toEqual({ status: "active", probesPassed: 0 });
    expect(nextLedgerState(null, "sighted")).toEqual({ status: "active", probesPassed: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- ledger-transitions`
Expected: FAIL — `Cannot find module '../src/ledger/transitions.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/ledger/transitions.js`:

```javascript
/**
 * Pure state machine for ErrorLedger.status / probesPassed. No I/O, no
 * clock — `current` and `event` are both supplied by the caller, so this is
 * verifiable against constructed inputs with closed-form expectations
 * (spec §4.1, §9.1). This is the function that decides whether the product
 * tells someone they fixed a habit, so it has to be this boring.
 */

/**
 * UNCALIBRATED — spec §11. Starting value, not a measurement: the ledger was
 * empty when this was designed. Revisit once real probe outcomes exist.
 */
export const PROBE_PASSES_TO_RESOLVE = 3;

/**
 * @param {{ probesPassed: number } | null} current - ignored for "failed"/"sighted"
 * @param {"passed" | "failed" | "sighted"} event
 * @returns {{ status: "active" | "improving" | "resolved", probesPassed: number }}
 */
export function nextLedgerState(current, event) {
  if (event === "passed") {
    const probesPassed = Math.min((current?.probesPassed ?? 0) + 1, PROBE_PASSES_TO_RESOLVE);
    const status = probesPassed >= PROBE_PASSES_TO_RESOLVE ? "resolved" : "improving";
    return { status, probesPassed };
  }
  // "failed": a probed opportunity to repeat the mistake was taken.
  // "sighted": the mistake appeared in ordinary conversation, unprompted.
  // Both mean the habit is not fixed, and are indistinguishable in outcome:
  // any single relapse revokes a "resolved" status (spec §6, §10).
  return { status: "active", probesPassed: 0 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix server test -- ledger-transitions`
Expected: PASS, 7 tests

- [ ] **Step 5: Extend the coverage gate**

In `server/vitest.config.js`, the `coverage.include` array currently reads:

```javascript
      include: ["src/feedback/**/*.js", "src/metrics/**/*.js"],
```

Change to:

```javascript
      include: ["src/feedback/**/*.js", "src/metrics/**/*.js", "src/coach/**/*.js", "src/ledger/**/*.js"],
```

(`src/coach/**/*.js` is added here even though Task 3 creates that directory — one edit now avoids touching this line twice.)

- [ ] **Step 6: Commit**

```bash
git add server/src/ledger/transitions.js server/test/ledger-transitions.test.js server/vitest.config.js
git commit -m "feat(server): add the ledger status state machine (M4)"
```

---

### Task 3: `coach/probe.js` — the pure probe-selection policy

**Files:**
- Create: `server/src/coach/probe.js`
- Test: `server/test/coach-probe.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure, standalone).
- Produces: `chooseProbe({ candidates, turnsSoFar })` → `{ pattern: string, directive: string } | null`. `candidates: Array<{ pattern, example, explanation, frequency, status, lastProbedAt }>` (the shape Task 5's `getProbeCandidates()` returns, unfiltered). `PROBE_TURN_INTERVAL`, `MIN_PROBE_FREQUENCY`, `PROBE_POOL_SIZE` (named exports, `UNCALIBRATED`, defaults `3`, `3`, `3`). Consumed by Task 6's `routes/turn.js`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/coach-probe.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { chooseProbe, PROBE_TURN_INTERVAL, MIN_PROBE_FREQUENCY, PROBE_POOL_SIZE } from "../src/coach/probe.js";

const candidate = (overrides) => ({
  pattern: "grammar:i have # years",
  example: "I have 30 years",
  explanation: "Age takes 'be', not 'have'.",
  frequency: MIN_PROBE_FREQUENCY,
  status: "active",
  lastProbedAt: null,
  ...overrides,
});

describe("coach/probe — chooseProbe", () => {
  it("fires on the configured turn interval", () => {
    const result = chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result).not.toBeNull();
    expect(result.pattern).toBe("grammar:i have # years");
  });

  it("never fires on turnsSoFar === 0, even with eligible candidates", () => {
    expect(chooseProbe({ candidates: [candidate()], turnsSoFar: 0 })).toBeNull();
  });

  it("does not fire off the interval", () => {
    expect(chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL - 1 })).toBeNull();
    expect(chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL + 1 })).toBeNull();
  });

  it("returns null with no candidates", () => {
    expect(chooseProbe({ candidates: [], turnsSoFar: PROBE_TURN_INTERVAL })).toBeNull();
  });

  it("ignores candidates below the minimum frequency", () => {
    const low = candidate({ pattern: "p:low", frequency: MIN_PROBE_FREQUENCY - 1 });
    expect(chooseProbe({ candidates: [low], turnsSoFar: PROBE_TURN_INTERVAL })).toBeNull();
  });

  it("ignores resolved candidates", () => {
    const resolved = candidate({ pattern: "p:resolved", status: "resolved", frequency: 99 });
    expect(chooseProbe({ candidates: [resolved], turnsSoFar: PROBE_TURN_INTERVAL })).toBeNull();
  });

  it("includes improving candidates, not only active ones", () => {
    const improving = candidate({ pattern: "p:improving", status: "improving" });
    const result = chooseProbe({ candidates: [improving], turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result?.pattern).toBe("p:improving");
  });

  it("pools the top PROBE_POOL_SIZE by frequency and rotates to the oldest-probed of that pool", () => {
    const candidates = [
      candidate({ pattern: "p:1", frequency: 10, lastProbedAt: "2026-08-01T00:00:00Z" }),
      candidate({ pattern: "p:2", frequency: 9, lastProbedAt: "2026-07-01T00:00:00Z" }), // oldest in pool
      candidate({ pattern: "p:3", frequency: 8, lastProbedAt: "2026-08-02T00:00:00Z" }),
      // Outside the pool (pool size 3): its frequency is below the other three, so proper
      // top-N-by-frequency pooling excludes it despite it having the oldest lastProbedAt —
      // a broken implementation that skipped pooling and just picked oldest-overall would
      // wrongly pick this one instead.
      candidate({ pattern: "p:4", frequency: 5, lastProbedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(candidates.length).toBeGreaterThan(PROBE_POOL_SIZE);
    const result = chooseProbe({ candidates, turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result.pattern).toBe("p:2");
  });

  it("treats a never-probed candidate (null lastProbedAt) as older than any timestamp", () => {
    const candidates = [
      candidate({ pattern: "p:never", lastProbedAt: null }),
      candidate({ pattern: "p:old", lastProbedAt: "2020-01-01T00:00:00Z" }),
    ];
    const result = chooseProbe({ candidates, turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result.pattern).toBe("p:never");
  });

  it("the directive quotes the example and explanation, never the pattern key", () => {
    const result = chooseProbe({
      candidates: [candidate({ example: "I have 30 years", explanation: "Age takes 'be'." })],
      turnsSoFar: PROBE_TURN_INTERVAL,
    });
    expect(result.directive).toContain("I have 30 years");
    expect(result.directive).toContain("Age takes 'be'.");
    expect(result.directive).not.toContain("grammar:i have # years");
  });

  it("the directive never announces itself as a test", () => {
    const result = chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result.directive.toLowerCase()).not.toContain("this is a test");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- coach-probe`
Expected: FAIL — `Cannot find module '../src/coach/probe.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/coach/probe.js`:

```javascript
/**
 * Pure probe-selection policy. No I/O — `candidates` is already read by the
 * caller (repo/ledger.js's getProbeCandidates, unfiltered) and `turnsSoFar`
 * is already counted by the caller from the database (spec §4.1, §5.3).
 * Everything this function decides — whether to fire, which pattern, what
 * to say — is therefore testable without a database.
 */

/** UNCALIBRATED — spec §11. At most one probe every this many user turns. */
export const PROBE_TURN_INTERVAL = 3;
/** UNCALIBRATED — spec §11. Never probe on a single isolated slip. */
export const MIN_PROBE_FREQUENCY = 3;
/** UNCALIBRATED — spec §11. Rotation pool size, so one pattern can't monopolise every probe. */
export const PROBE_POOL_SIZE = 3;

/** Nulls sort as older than any real timestamp (spec §5.3: "nulls first"). */
function probedAtMs(candidate) {
  return candidate.lastProbedAt ? new Date(candidate.lastProbedAt).getTime() : -Infinity;
}

/**
 * @param {{ candidates: Array<{pattern:string, example:string, explanation:string|null, frequency:number, status:string, lastProbedAt:string|Date|null}>, turnsSoFar: number }} args
 * @returns {{ pattern: string, directive: string } | null}
 */
export function chooseProbe({ candidates, turnsSoFar }) {
  if (!turnsSoFar || turnsSoFar % PROBE_TURN_INTERVAL !== 0) return null;

  const pool = candidates
    .filter((c) => (c.status === "active" || c.status === "improving") && c.frequency >= MIN_PROBE_FREQUENCY)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, PROBE_POOL_SIZE);
  if (!pool.length) return null;

  const chosen = pool.reduce((oldest, c) => (probedAtMs(c) < probedAtMs(oldest) ? c : oldest));
  return { pattern: chosen.pattern, directive: buildDirective(chosen) };
}

/**
 * Built from `example` and `explanation` — never `pattern`, which is a
 * mangled lexical-prefix key that would tell the model nothing (spec §3.2,
 * §4.1). Starting wording (spec §12.1): iterate against real conversation.
 */
function buildDirective({ example, explanation }) {
  const why = explanation ? ` — ${explanation}` : "";
  return (
    `The learner has a recurring pattern worth revisiting. They previously said something like: ` +
    `"${example}"${why}. In your next reply, steer the conversation toward a natural opening where a ` +
    `sentence like that would come up again, so they get a chance to try it differently. Do not mention ` +
    `that this is a known mistake or that you are testing them — just create the opening naturally.`
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix server test -- coach-probe`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/coach/probe.js server/test/coach-probe.test.js
git commit -m "feat(server): add the pure probe-selection policy (M4)"
```

---

### Task 4: `repo/session.js` — `countUserTurns`

**Files:**
- Modify: `server/src/repo/session.js`
- Test: `server/test/session-repo.test.js` (append)

**Interfaces:**
- Produces: `countUserTurns(sessionId: string | null | undefined): Promise<number>`. Consumed by Task 6's `routes/turn.js`.

- [ ] **Step 1: Write the failing test**

Open `server/test/session-repo.test.js`, find its last `describe`/`it` block, and append this new `describe` block before the file's closing (mirror the existing file's import style — it already imports from `../src/repo/session.js`):

```javascript
import { countUserTurns } from "../src/repo/session.js";
```

(add this to the existing top-of-file import block from `../src/repo/session.js` rather than as a new import line, if that file already imports named exports from it — check the existing import line first and extend it.)

```javascript
describe("session repo — countUserTurns", () => {
  it("counts only user-role turns for the given session", async () => {
    const session = await startSession();
    await recordTurn({ sessionId: session.id, role: "coach", text: "hi" });
    await recordTurn({ sessionId: session.id, role: "user", text: "hello" });
    await recordTurn({ sessionId: session.id, role: "coach", text: "nice" });
    await recordTurn({ sessionId: session.id, role: "user", text: "how are you" });

    expect(await countUserTurns(session.id)).toBe(2);
  });

  it("returns 0 for a session with no turns yet", async () => {
    const session = await startSession();
    expect(await countUserTurns(session.id)).toBe(0);
  });

  it("returns 0 for a missing or falsy sessionId without querying", async () => {
    expect(await countUserTurns(null)).toBe(0);
    expect(await countUserTurns(undefined)).toBe(0);
    expect(await countUserTurns("")).toBe(0);
  });

  it("returns 0 for a sessionId that does not exist", async () => {
    expect(await countUserTurns("does-not-exist")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix server test -- session-repo`
Expected: FAIL — `countUserTurns is not a function` (or import error)

- [ ] **Step 3: Implement `countUserTurns`**

In `server/src/repo/session.js`, add this function (anywhere after `startSession`, e.g. directly below it):

```javascript
/**
 * The database is the source of truth for "how far into the session are
 * we" — the request body is not trusted for this (spec §5.3). Used to gate
 * probe eligibility: a fresh or unknown session must never probe.
 */
export async function countUserTurns(sessionId) {
  if (!sessionId) return 0;
  return getPrisma().turn.count({ where: { sessionId, role: "user" } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix server test -- session-repo`
Expected: PASS, all tests in the file including the 4 new ones

- [ ] **Step 5: Commit**

```bash
git add server/src/repo/session.js server/test/session-repo.test.js
git commit -m "feat(server): add countUserTurns for probe eligibility (M4)"
```

---

### Task 5: `repo/ledger.js` — widen `getFrequencies`, add the four M4 functions

**Files:**
- Modify: `server/src/repo/ledger.js`
- Modify: `server/src/feedback/index.js:63-64` (comparator, follows the widened shape)
- Modify: `server/test/ledger-repo.test.js`
- Test: `server/test/ledger-repo.test.js` (append)

**Interfaces:**
- Consumes: `nextLedgerState` from Task 2's `server/src/ledger/transitions.js`.
- Produces: `getFrequencies(patterns: string[]): Promise<Map<string, {frequency:number, status:string}>>` (widened — was `Map<string, number>`). `getProbeCandidates(): Promise<Array<{pattern, example, explanation, frequency, status, lastProbedAt}>>`. `markProbed(pattern: string): Promise<void>`. `applyProbeOutcome(pattern: string, passed: boolean): Promise<{pattern, passed, status} | null>`. `listPatterns(): Promise<Array<{pattern, example, frequency, status, probesPassed, lastSeenAt, lastProbedAt}>>`. Consumed by Task 6 (`getProbeCandidates`, `markProbed`), Task 7 (`applyProbeOutcome`, widened `getFrequencies`), Task 8 (`listPatterns`).

- [ ] **Step 1: Write the failing tests**

`server/test/ledger-repo.test.js` currently has this test (from the file you read earlier — locate it and replace it, since the widened shape breaks it):

```javascript
  it("creates a row at frequency 1 and increments on the second sighting", async () => {
    const p = `grammar:test-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toBe(1);
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toBe(2);
  });
```

Replace it with:

```javascript
  it("creates a row at frequency 1 and increments on the second sighting", async () => {
    const p = `grammar:test-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toEqual({ frequency: 1, status: "active" });
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toEqual({ frequency: 2, status: "active" });
  });
```

Then append these new `describe` blocks to the same file (extend the existing top import line `import { recordFindings, getFrequencies } from "../src/repo/ledger.js";` to also pull in the new functions):

```javascript
import {
  recordFindings,
  getFrequencies,
  getProbeCandidates,
  markProbed,
  applyProbeOutcome,
  listPatterns,
} from "../src/repo/ledger.js";
```

```javascript
describe("ledger repo — relapse resets status", () => {
  it("a fresh sighting on a resolved pattern returns it to active with the counter zeroed", async () => {
    const p = `grammar:relapse-${Math.random().toString(36).slice(2)}`;
    // Drive it to resolved via the real transition path this repo now uses.
    await recordFindings([entry(p)]);
    await applyProbeOutcome(p, true);
    await applyProbeOutcome(p, true);
    await applyProbeOutcome(p, true);
    const resolved = (await getFrequencies([p])).get(p);
    expect(resolved.status).toBe("resolved");

    await recordFindings([entry(p)]); // the mistake happened again, unprompted
    const relapsed = (await getFrequencies([p])).get(p);
    expect(relapsed.status).toBe("active");

    const candidates = await getProbeCandidates();
    const row = candidates.find((c) => c.pattern === p);
    expect(row.status).toBe("active");
  });
});

describe("ledger repo — getProbeCandidates", () => {
  it("returns rows with the shape coach/probe.js expects, unfiltered by status", async () => {
    const p = `grammar:candidate-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    const candidates = await getProbeCandidates();
    const row = candidates.find((c) => c.pattern === p);
    expect(row).toMatchObject({ pattern: p, frequency: 1, status: "active" });
    expect(row).toHaveProperty("example");
    expect(row).toHaveProperty("explanation");
    expect(row).toHaveProperty("lastProbedAt");
  });
});

describe("ledger repo — markProbed", () => {
  it("stamps lastProbedAt on the given pattern", async () => {
    const p = `grammar:probed-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    await markProbed(p);
    const candidates = await getProbeCandidates();
    const row = candidates.find((c) => c.pattern === p);
    expect(row.lastProbedAt).not.toBeNull();
  });
});

describe("ledger repo — applyProbeOutcome", () => {
  it("passing a probe moves the pattern toward improving", async () => {
    const p = `grammar:outcome-pass-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    const result = await applyProbeOutcome(p, true);
    expect(result).toEqual({ pattern: p, passed: true, status: "improving" });
  });

  it("failing a probe keeps the pattern active with the counter zeroed", async () => {
    const p = `grammar:outcome-fail-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    await applyProbeOutcome(p, true); // improving, probesPassed 1
    const result = await applyProbeOutcome(p, false);
    expect(result).toEqual({ pattern: p, passed: false, status: "active" });
  });

  it("an unknown pattern is a no-op that returns null, never creating a row", async () => {
    const p = `grammar:never-existed-${Math.random().toString(36).slice(2)}`;
    const result = await applyProbeOutcome(p, true);
    expect(result).toBeNull();
    expect((await getFrequencies([p])).has(p)).toBe(false);
  });
});

describe("ledger repo — listPatterns", () => {
  it("orders by status then frequency, and includes resolved rows", async () => {
    const suffix = Math.random().toString(36).slice(2);
    const low = `grammar:list-low-${suffix}`;
    const high = `grammar:list-high-${suffix}`;
    await recordFindings([entry(low)]);
    await recordFindings([entry(high)]);
    await recordFindings([entry(high)]); // frequency 2, higher than low's 1

    const rows = await listPatterns();
    const lowIndex = rows.findIndex((r) => r.pattern === low);
    const highIndex = rows.findIndex((r) => r.pattern === high);
    expect(lowIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeLessThan(lowIndex); // same status ("active"), higher frequency sorts first
  });

  it("carries the fields the patterns view needs, never a bare frequency-only shape", async () => {
    const p = `grammar:list-shape-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    const row = (await listPatterns()).find((r) => r.pattern === p);
    expect(row).toMatchObject({ pattern: p, frequency: 1, status: "active", probesPassed: 0 });
    expect(row).toHaveProperty("example");
    expect(row).toHaveProperty("lastSeenAt");
    expect(row).toHaveProperty("lastProbedAt");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- ledger-repo`
Expected: FAIL — the rewritten first test fails on the shape assertion; the new `describe` blocks fail with `getProbeCandidates is not a function` etc.

- [ ] **Step 3: Rewrite `server/src/repo/ledger.js`**

Replace the whole file:

```javascript
import { getPrisma } from "../db.js";
import { nextLedgerState } from "../ledger/transitions.js";

/**
 * The only module that reads or writes ErrorLedger. `pattern` carries @unique
 * since M0, which is what makes the twelfth sighting the same row rather than
 * a new one.
 *
 * M2 writes it; M4 is what schedules from it and reads it back for the
 * patterns view. `ledger/transitions.js` owns the status math; this module
 * owns the I/O around it.
 */

/** `{frequency, status}` — status is what §5.2's `recurrence` block needs (M4). */
export async function getFrequencies(patterns) {
  if (!patterns.length) return new Map();
  const rows = await getPrisma().errorLedger.findMany({
    where: { pattern: { in: patterns } },
    select: { pattern: true, frequency: true, status: true },
  });
  return new Map(rows.map((r) => [r.pattern, { frequency: r.frequency, status: r.status }]));
}

/**
 * `entries` must already be unique by `pattern` — buildFeedback de-duplicates
 * before calling. Two entries sharing a key here would increment the same row
 * twice for a single turn, which is not something this function can detect.
 *
 * M4: every sighting is an ordinary one from this function's point of view —
 * even the pattern's twelfth appearance resets status to active and zeroes
 * probesPassed. A relapse is a relapse, regardless of how many probes were
 * passed before it (spec §6).
 */
export async function recordFindings(entries) {
  const reset = nextLedgerState(null, "sighted");
  for (const { pattern, type, example, explanation } of entries) {
    await getPrisma().errorLedger.upsert({
      where: { pattern },
      update: { frequency: { increment: 1 }, lastSeenAt: new Date(), example, explanation, ...reset },
      create: { pattern, type, example, explanation },
    });
  }
}

/**
 * All rows, unfiltered by status or frequency — coach/probe.js's chooseProbe
 * owns that policy (spec §4.1: "the choice is pure; the read lives in repo").
 */
export async function getProbeCandidates() {
  return getPrisma().errorLedger.findMany({
    select: { pattern: true, example: true, explanation: true, frequency: true, status: true, lastProbedAt: true },
  });
}

/** Stamped the moment a probe is issued (routes/turn.js), not when its outcome resolves. */
export async function markProbed(pattern) {
  await getPrisma().errorLedger.update({ where: { pattern }, data: { lastProbedAt: new Date() } });
}

/**
 * Resolves a probe's outcome. An unknown pattern is a no-op (spec §8: "a
 * probe never creates a ledger row") — this can only ever transition a row
 * that recordFindings has already created.
 *
 * Idempotency is the CALLER's responsibility (spec §8.1) — routes/feedback.js
 * must only reach this from inside its existing turnId-gated computeAndPersist.
 */
export async function applyProbeOutcome(pattern, passed) {
  const row = await getPrisma().errorLedger.findUnique({ where: { pattern }, select: { probesPassed: true } });
  if (!row) return null;
  const next = nextLedgerState({ probesPassed: row.probesPassed }, passed ? "passed" : "failed");
  await getPrisma().errorLedger.update({ where: { pattern }, data: next });
  return { pattern, passed, status: next.status };
}

/** Ordered by status then frequency (spec §7) — resolved rows are the reward D4 exists to deliver, so they are included, not hidden. */
export async function listPatterns() {
  return getPrisma().errorLedger.findMany({
    orderBy: [{ status: "asc" }, { frequency: "desc" }],
    select: {
      pattern: true,
      example: true,
      frequency: true,
      status: true,
      probesPassed: true,
      lastSeenAt: true,
      lastProbedAt: true,
    },
  });
}
```

- [ ] **Step 4: Fix `feedback/index.js`'s comparator for the widened `getFrequencies` shape**

In `server/src/feedback/index.js:63-64`, this line currently reads:

```javascript
  const frequencies = await safeFrequencies([...corrections, ...upgrades].map((x) => x.pattern));
  const byFrequency = (a, b) => (frequencies.get(b.pattern) ?? 0) - (frequencies.get(a.pattern) ?? 0);
```

Change the second line to read through the new `{frequency, status}` shape:

```javascript
  const frequencies = await safeFrequencies([...corrections, ...upgrades].map((x) => x.pattern));
  const byFrequency = (a, b) => (frequencies.get(b.pattern)?.frequency ?? 0) - (frequencies.get(a.pattern)?.frequency ?? 0);
```

(`safeFrequencies`'s catch-path fallback is `new Map()`, which is unaffected — `.get(...)` still returns `undefined`, and `undefined?.frequency` is `undefined`, so `?? 0` still applies.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix server test`
Expected: PASS, full suite green — this step also proves `feedback/index.js`'s own existing tests (sorting, deduping) still pass with the widened shape.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo/ledger.js server/src/feedback/index.js server/test/ledger-repo.test.js
git commit -m "feat(server): widen getFrequencies, add probe read/write functions to repo/ledger.js (M4)"
```

---

### Task 6: `routes/turn.js` — choose and surface a probe; `brain/mistral.js` — carry the directive

**Files:**
- Modify: `server/src/routes/turn.js`
- Modify: `server/src/brain/mistral.js:17`
- Test: `server/test/turn-persistence.test.js` (append) or a new `server/test/turn-probe.test.js`

**Interfaces:**
- Consumes: `countUserTurns` (Task 4), `getProbeCandidates`/`markProbed` (Task 5), `chooseProbe` (Task 3).
- Produces: `POST /turn`'s response gains `probe: { pattern: string } | null`. `MistralBrain.evaluateTurn` accepts an optional `probeDirective` param.

- [ ] **Step 1: Write the failing tests**

Create `server/test/turn-probe.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { recordFindings, applyProbeOutcome } from "../src/repo/ledger.js";
import { MIN_PROBE_FREQUENCY, PROBE_TURN_INTERVAL } from "../src/coach/probe.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await getPrisma().$disconnect();
});

async function turn(body) {
  const res = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /turn — probe field", () => {
  it("is null with no sessionId (a fresh session cannot probe)", async () => {
    const { body } = await turn({ utterance: "hello there" });
    expect(body.probe).toBeNull();
  });

  it("is null before the turn interval is reached, even with an eligible pattern", async () => {
    const p = `grammar:probe-route-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < MIN_PROBE_FREQUENCY; i += 1) {
      await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    }
    let sessionId = null;
    for (let i = 0; i < PROBE_TURN_INTERVAL - 1; i += 1) {
      const { body } = await turn({ utterance: `turn ${i}`, sessionId });
      sessionId = body.sessionId;
      expect(body.probe).toBeNull();
    }
  });

  it("fires on the interval once an eligible pattern exists, and stamps lastProbedAt", async () => {
    const p = `grammar:probe-route-fire-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < MIN_PROBE_FREQUENCY; i += 1) {
      await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." }]);
    }
    let sessionId = null;
    let lastBody;
    // countUserTurns reflects turns already PERSISTED before this call, so
    // turnsSoFar over calls 1..N is 0, 1, 2, ... — reaching a value equal to
    // PROBE_TURN_INTERVAL takes PROBE_TURN_INTERVAL + 1 calls, not
    // PROBE_TURN_INTERVAL calls.
    for (let i = 0; i < PROBE_TURN_INTERVAL + 1; i += 1) {
      lastBody = (await turn({ utterance: `turn ${i}`, sessionId })).body;
      sessionId = lastBody.sessionId;
    }
    // We seeded one guaranteed-eligible pattern above, so the pool can never
    // be empty at this point — a probe must fire, even if it isn't
    // necessarily OUR pattern (other tests may have left eligible rows with
    // higher frequency in the same shared table).
    expect(lastBody.probe).not.toBeNull();
    expect(typeof lastBody.probe.pattern).toBe("string");
  });
});
```

Note the last test intentionally does not assert `lastBody.probe.pattern === p`: `getProbeCandidates()` reads the whole table (Task 5), so other tests' rows are live candidates too, and this suite runs after `ledger-repo.test.js` and `coach-probe.test.js` in the same shared `test.db` (per the environment notes — don't assert on table-wide state). Assert the mechanism fires (a probe is possible once the interval and an eligible row exist), not which exact pattern wins.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- turn-probe`
Expected: FAIL — `body.probe` is `undefined`, not `null`/an object, on every assertion.

- [ ] **Step 3: Wire probe selection into `routes/turn.js`**

In `server/src/routes/turn.js`, the imports at the top currently read:

```javascript
import { Router } from "express";
import multer from "multer";
import { getBrain } from "../brain/index.js";
import { getTTS, currentTTSProvider } from "../tts/index.js";
import { getSTT } from "../stt/index.js";
import { startSession, recordTurn, recordSeed } from "../repo/session.js";
import { nextSeed } from "../seed/index.js";
```

Change to:

```javascript
import { Router } from "express";
import multer from "multer";
import { getBrain } from "../brain/index.js";
import { getTTS, currentTTSProvider } from "../tts/index.js";
import { getSTT } from "../stt/index.js";
import { startSession, recordTurn, recordSeed, countUserTurns } from "../repo/session.js";
import { getProbeCandidates, markProbed } from "../repo/ledger.js";
import { chooseProbe } from "../coach/probe.js";
import { nextSeed } from "../seed/index.js";
```

The `runTurn` function currently reads:

```javascript
async function runTurn(utterance, history) {
  const window = Array.isArray(history) ? history.slice(-HISTORY_WINDOW) : [];

  const brain = getBrain();
  const result = await brain.evaluateTurn({
    userUtterance: utterance,
    history: window,
    scenario: null, // scenarios land in M5
  });
```

Change its signature and the `evaluateTurn` call:

```javascript
async function runTurn(utterance, history, probeDirective = null) {
  const window = Array.isArray(history) ? history.slice(-HISTORY_WINDOW) : [];

  const brain = getBrain();
  const result = await brain.evaluateTurn({
    userUtterance: utterance,
    history: window,
    scenario: null, // scenarios land in M5
    probeDirective,
  });
```

Add these two helpers directly below `runTurn` (before the `POST /` route handler):

```javascript
/**
 * The database is the source of truth for how far into the session we are
 * (spec §5.3) — a failing count means no probe this turn, not a broken turn.
 */
async function safeTurnsSoFar(sessionId) {
  try {
    return await countUserTurns(sessionId);
  } catch (err) {
    console.warn("[turn] turn count failed, no probe this turn:", err.message);
    return 0;
  }
}

/**
 * A fresh/unknown session (turnsSoFar 0) never probes — cheap short-circuit
 * that also avoids a DB read on the most common request (a session's first
 * turn). A ledger read failure degrades to no probe, never a broken turn
 * (spec §8).
 */
async function safeChooseProbe(turnsSoFar) {
  if (!turnsSoFar) return null;
  try {
    const candidates = await getProbeCandidates();
    return chooseProbe({ candidates, turnsSoFar });
  } catch (err) {
    console.warn("[turn] probe selection failed, continuing without one:", err.message);
    return null;
  }
}

/** A probe that never reached the learner (the brain call below failed) must not be marked probed. */
async function safeMarkProbed(pattern) {
  try {
    await markProbed(pattern);
  } catch (err) {
    console.warn("[turn] markProbed failed, pattern may be re-picked sooner than intended:", err.message);
  }
}
```

The `POST /` handler currently reads:

```javascript
router.post("/", async (req, res) => {
  const { utterance, history, sessionId, prosody, captureSettings } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  try {
    const result = await runTurn(utterance.trim(), history);
    // Persistence must never break the loop: a DB failure costs us a row,
    // not the learner's turn.
    const { sessionId: persistedId, turnId } = await persistTurn({ sessionId, utterance: utterance.trim(), prosody, captureSettings, result });
    return res.json({ ...result, sessionId: persistedId, turnId });
  } catch (err) {
    console.error("[turn] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }
});
```

Change to:

```javascript
router.post("/", async (req, res) => {
  const { utterance, history, sessionId, prosody, captureSettings } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  const turnsSoFar = await safeTurnsSoFar(sessionId);
  const probe = await safeChooseProbe(turnsSoFar);

  try {
    const result = await runTurn(utterance.trim(), history, probe?.directive ?? null);
    // Persistence must never break the loop: a DB failure costs us a row,
    // not the learner's turn.
    const { sessionId: persistedId, turnId } = await persistTurn({ sessionId, utterance: utterance.trim(), prosody, captureSettings, result });
    // Only stamp lastProbedAt once the brain call above has actually
    // succeeded — a probe that never reached the learner must not be pushed
    // to the back of the rotation for nothing.
    if (probe) await safeMarkProbed(probe.pattern);
    return res.json({ ...result, sessionId: persistedId, turnId, probe: probe ? { pattern: probe.pattern } : null });
  } catch (err) {
    console.error("[turn] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }
});
```

- [ ] **Step 4: Carry `probeDirective` as a second system message in `MistralBrain`**

In `server/src/brain/mistral.js:17`, `evaluateTurn` currently reads:

```javascript
  async evaluateTurn({ userUtterance, history = [] }) {
    const messages = [
      { role: "system", content: selectCoachPrompt() },
      ...history.map((m) => ({
        role: m.role === "coach" ? "assistant" : "user",
        content: m.text,
      })),
      { role: "user", content: userUtterance },
    ];
```

Change to:

```javascript
  async evaluateTurn({ userUtterance, history = [], probeDirective = null }) {
    const messages = [
      { role: "system", content: selectCoachPrompt() },
      // M4: a second system message, never concatenated into the base prompt
      // (spec §4.1) — coachSystemM2 stays a single freezable artifact, and
      // the directive is the ephemeral per-turn context it actually is.
      ...(probeDirective ? [{ role: "system", content: probeDirective }] : []),
      ...history.map((m) => ({
        role: m.role === "coach" ? "assistant" : "user",
        content: m.text,
      })),
      { role: "user", content: userUtterance },
    ];
```

(`MockBrain.evaluateTurn` needs no change — it destructures only `{ userUtterance, history = [] }`, so an extra `probeDirective` property on the passed object is simply ignored, matching how it already ignores `scenario`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix server test -- turn-probe`
Expected: PASS, 3 tests

Then run the full suite to confirm nothing else broke:

Run: `npm --prefix server test`
Expected: PASS, full suite green

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/turn.js server/src/brain/mistral.js server/test/turn-probe.test.js
git commit -m "feat(server): choose and surface a probe from POST /turn (M4)"
```

---

### Task 7: `feedback/index.js` + `routes/feedback.js` — resolve the probe outcome

**Files:**
- Modify: `server/src/feedback/index.js`
- Modify: `server/src/routes/feedback.js`
- Test: `server/test/feedback-route.test.js` (append) or a new `server/test/feedback-probe.test.js`

**Interfaces:**
- Consumes: `applyProbeOutcome` (Task 5).
- Produces: `buildFeedback(...)`'s return object gains two internal-only fields: `recordedPatterns: string[]` (every pattern written to the ledger this turn, pre-cap) and `frequenciesBeforeWrite: Record<string, {frequency:number,status:string}>` (the sort-time snapshot, JSON-safe — a plain object, not a `Map`). `POST /feedback` accepts `probedPattern?: string` in the body and returns `probeResult: {pattern, passed, status} | null`; each item in the returned `corrections` array gains `recurrence: {frequency, status}`. Neither `recordedPatterns` nor `frequenciesBeforeWrite` appears in the HTTP response or the persisted payload.

- [ ] **Step 1: Write the failing tests**

Create `server/test/feedback-probe.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { recordFindings } from "../src/repo/ledger.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await getPrisma().$disconnect();
});

async function feedback(body) {
  const res = await fetch(`${base}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A real, persisted Turn row — a fabricated turnId with no backing row
 * makes saveTurnFeedback's update fail (swallowed) and getTurnFeedback
 * always return null, so the idempotency gate never actually engages. */
async function makeTurn(utterance) {
  const res = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance }),
  });
  const body = await res.json();
  return body.turnId;
}

describe("POST /feedback — probe outcome", () => {
  it("returns null probeResult when no probedPattern is sent", async () => {
    const { body } = await feedback({ utterance: "I like pizza a lot" });
    expect(body.probeResult).toBeNull();
  });

  it("a probedPattern that does not reappear in this turn's findings is a pass", async () => {
    const p = `grammar:feedback-probe-pass-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    const { body } = await feedback({ utterance: "I like pizza a lot", probedPattern: p });
    expect(body.probeResult).toEqual({ pattern: p, passed: true, status: "improving" });
  });

  it("an unknown probedPattern resolves to a null probeResult, not an error", async () => {
    const { status, body } = await feedback({
      utterance: "I like pizza a lot",
      probedPattern: "grammar:never-existed-anywhere",
    });
    expect(status).toBe(200);
    expect(body.probeResult).toBeNull();
  });

  it("does not attach recurrence when there are no corrections", async () => {
    const { body } = await feedback({ utterance: "I like pizza a lot" });
    expect(body.corrections).toEqual([]);
  });

  it("never leaks internal recordedPatterns/frequenciesBeforeWrite fields onto the response", async () => {
    const { body } = await feedback({ utterance: "hello there" });
    expect(body).not.toHaveProperty("recordedPatterns");
    expect(body).not.toHaveProperty("frequenciesBeforeWrite");
  });

  // The most important test in M4 (spec §9.1): a retried request with the
  // same turnId + probedPattern must apply the outcome exactly once. Uses a
  // REAL turnId (via makeTurn) so the stored-payload gate can actually
  // engage on the third, sequential request — a fabricated id would make
  // saveTurnFeedback silently fail every time, masking a real double-apply.
  it("applies a probe outcome exactly once across duplicate requests with the same turnId", async () => {
    const p = `grammar:feedback-probe-idempotent-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    const turnId = await makeTurn("I like pizza a lot");

    const [first, second] = await Promise.all([
      feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p }),
      feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p }),
    ]);

    expect(first.body.probeResult).toEqual({ pattern: p, passed: true, status: "improving" });
    expect(second.body.probeResult).toEqual(first.body.probeResult);

    // Ground truth: read the ledger row directly. A second HTTP response
    // that merely *looks* the same as the first proves nothing — "improving"
    // is the status at both 1 and 2 passes when PROBE_PASSES_TO_RESOLVE > 2,
    // so only the row's actual probesPassed count can distinguish "applied
    // once" from "applied twice."
    const row = await getPrisma().errorLedger.findUnique({ where: { pattern: p } });
    expect(row.probesPassed).toBe(1);

    // A later, separate request for the same turnId must replay the stored
    // payload rather than recomputing — the row must still read 1.
    const third = await feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p });
    expect(third.body.probeResult).toEqual(first.body.probeResult);
    const rowAfterThird = await getPrisma().errorLedger.findUnique({ where: { pattern: p } });
    expect(rowAfterThird.probesPassed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- feedback-probe`
Expected: FAIL — `body.probeResult` is `undefined` on every assertion.

- [ ] **Step 3: Extend `buildFeedback`'s return value**

In `server/src/feedback/index.js`, the end of `buildFeedback` currently reads:

```javascript
  const { hesitation, sessionFluency } = computeDelivery({ text: utterance, prosody, sessionPhonationMs, sessionSyllables });

  return {
    corrections: uniqueCorrections.slice(0, MAX_CORRECTIONS),
    upgrades: uniqueUpgrades.slice(0, MAX_UPGRADES),
    hesitation,
    sessionFluency,
    passes: { mechanical, pedagogical: llm.status },
  };
}
```

Change to:

```javascript
  const { hesitation, sessionFluency } = computeDelivery({ text: utterance, prosody, sessionPhonationMs, sessionSyllables });

  return {
    corrections: uniqueCorrections.slice(0, MAX_CORRECTIONS),
    upgrades: uniqueUpgrades.slice(0, MAX_UPGRADES),
    hesitation,
    sessionFluency,
    passes: { mechanical, pedagogical: llm.status },
    // M4-internal only — routes/feedback.js reads these two fields and must
    // not let them reach the HTTP response or the persisted payload.
    // `recordedPatterns` is pre-cap (everything actually written to the
    // ledger this turn, spec §5: "does that pattern appear among the new
    // findings"), unlike the capped `corrections`/`upgrades` above.
    recordedPatterns: [...uniqueCorrections, ...uniqueUpgrades].map((x) => x.pattern),
    // Plain object, not the Map `frequencies` is — JSON-safe, and this is
    // the pre-write snapshot getFrequencies read before safeRecord ran, so a
    // reader must add 1 to get the count as of *this* sighting (spec §5.2).
    frequenciesBeforeWrite: Object.fromEntries(frequencies),
  };
}
```

- [ ] **Step 4: Wire `routes/feedback.js`**

In `server/src/routes/feedback.js`, the import line currently reads:

```javascript
import { Router } from "express";
import { buildFeedback } from "../feedback/index.js";
import { saveTurnFeedback, getTurnFeedback } from "../repo/session.js";
```

Change to:

```javascript
import { Router } from "express";
import { buildFeedback } from "../feedback/index.js";
import { saveTurnFeedback, getTurnFeedback } from "../repo/session.js";
import { applyProbeOutcome } from "../repo/ledger.js";
```

The `POST /` handler currently destructures the body as:

```javascript
  const { utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables } = req.body ?? {};
```

Change to:

```javascript
  const { utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables, probedPattern } = req.body ?? {};
```

`computeAndPersist` currently reads:

```javascript
  async function computeAndPersist() {
    const payload = await buildFeedback({
      utterance,
      history: Array.isArray(history) ? history : [],
      prosody: prosody ?? null,
      sessionPhonationMs: Number(sessionPhonationMs) || 0,
      sessionSyllables: Number(sessionSyllables) || 0,
    });

    // Persistence must never cost the payload — the rule /turn has followed
    // since M3.
    if (turnId) {
      try {
        // spec §6.2: the turn also carries the session-level fluency current
        // at that turn, so M4 can query the trend without a per-turn metric.
        // A null value leaves the column untouched rather than writing 0.
        await saveTurnFeedback(turnId, payload, payload?.sessionFluency);
      } catch (dbErr) {
        console.warn("[feedback] persistence failed, continuing:", dbErr.message);
      }
    }

    return payload;
  }
```

Change to:

```javascript
  async function computeAndPersist() {
    const raw = await buildFeedback({
      utterance,
      history: Array.isArray(history) ? history : [],
      prosody: prosody ?? null,
      sessionPhonationMs: Number(sessionPhonationMs) || 0,
      sessionSyllables: Number(sessionSyllables) || 0,
    });
    const { recordedPatterns, frequenciesBeforeWrite, ...publicFields } = raw;

    // M4: attach recurrence to each correction from the pre-write snapshot
    // buildFeedback already read, +1 for the sighting the write just
    // recorded (spec §5.2 — the raw snapshot is "as of the previous turn").
    // status is always "active", never the pre-write snapshot's value: every
    // correction here was just recorded by recordFindings above, which
    // unconditionally resets status to "active" on every sighting (spec §6).
    // Reporting the stale pre-write status (e.g. "resolved") would show a
    // false all-clear on the very turn a pattern relapsed — the opposite of
    // spec §10's rule that a relapse revokes those states.
    const corrections = publicFields.corrections.map((c) => {
      const prior = frequenciesBeforeWrite[c.pattern];
      return { ...c, recurrence: { frequency: (prior?.frequency ?? 0) + 1, status: "active" } };
    });

    // M4: resolve this turn's probe, if any. Reads recordedPatterns (pre-cap)
    // rather than the capped `corrections`/`upgrades` above, so a reappeared
    // pattern that got bumped out of the display cap is still scored
    // correctly. This MUST stay inside computeAndPersist, behind both the
    // stored-payload check above and the in-flight map below — see the
    // Global Constraints note on applyProbeOutcome. Guarded the same way
    // safeRecord/safeFrequencies degrade in feedback/index.js: a transient
    // ledger write failure here must cost the probe outcome, never the rest
    // of the payload.
    let probeResult = null;
    if (typeof probedPattern === "string" && probedPattern) {
      try {
        const reappeared = recordedPatterns.includes(probedPattern);
        const outcome = await applyProbeOutcome(probedPattern, !reappeared);
        if (outcome) probeResult = outcome;
      } catch (err) {
        console.warn("[feedback] probe outcome resolution failed, continuing:", err.message);
      }
    }

    const payload = { ...publicFields, corrections, probeResult };

    // Persistence must never cost the payload — the rule /turn has followed
    // since M3.
    if (turnId) {
      try {
        // spec §6.2: the turn also carries the session-level fluency current
        // at that turn, so M4 can query the trend without a per-turn metric.
        // A null value leaves the column untouched rather than writing 0.
        await saveTurnFeedback(turnId, payload, payload?.sessionFluency);
      } catch (dbErr) {
        console.warn("[feedback] persistence failed, continuing:", dbErr.message);
      }
    }

    return payload;
  }
```

- [ ] **Step 5: Add recurrence coverage to `feedback-route.test.js` (mocked-`buildFeedback` style)**

`feedback-probe.test.js` above never exercises a turn with a non-empty `corrections` array (real Harper output is fragile to depend on in a test), so the `recurrence` attachment logic — and the `frequenciesBeforeWrite[c.pattern]` lookup specifically — has no coverage without this step. `server/test/feedback-route.test.js` already mocks `buildFeedback` (see its top: `vi.mock("../src/feedback/index.js", () => ({ buildFeedback: vi.fn() }))`) and has a `PAYLOAD` constant and a `makeTurn(utterance)` helper already in scope — append these two tests inside its existing `describe("POST /feedback", () => { ... })` block:

```javascript
  it("attaches recurrence to each correction from the pre-write snapshot, always as active", async () => {
    const turnId = await makeTurn("I have 30 years");
    buildFeedback.mockResolvedValueOnce({
      ...PAYLOAD,
      corrections: [
        { span: [0, 4], original: "test", suggestion: "fixed", message: "m", kind: "grammar", pattern: "grammar:test-pattern", source: "harper" },
      ],
      recordedPatterns: ["grammar:test-pattern"],
      // Pre-write snapshot: this pattern was "resolved" before this sighting.
      frequenciesBeforeWrite: { "grammar:test-pattern": { frequency: 5, status: "resolved" } },
    });
    const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(res.status).toBe(200);
    // +1 on frequency (the sighting that just happened); status forced to
    // "active" regardless of the pre-write snapshot's "resolved" — a
    // relapse, not a lingering resolved badge.
    expect(res.body.corrections[0].recurrence).toEqual({ frequency: 6, status: "active" });
  });

  it("does not crash when frequenciesBeforeWrite is missing an entry for a correction's pattern", async () => {
    const turnId = await makeTurn("I have 30 years");
    buildFeedback.mockResolvedValueOnce({
      ...PAYLOAD,
      corrections: [
        { span: [0, 4], original: "test", suggestion: "fixed", message: "m", kind: "grammar", pattern: "grammar:unseen-pattern", source: "harper" },
      ],
      recordedPatterns: ["grammar:unseen-pattern"],
      frequenciesBeforeWrite: {}, // no prior entry — first-ever sighting
    });
    const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(res.status).toBe(200);
    expect(res.body.corrections[0].recurrence).toEqual({ frequency: 1, status: "active" });
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix server test -- feedback-probe feedback-route`
Expected: PASS, 8 tests in `feedback-probe.test.js` and the existing `feedback-route.test.js` tests plus the 2 new ones, all green.

Then run the full suite:

Run: `npm --prefix server test`
Expected: PASS, full suite green — this also proves `feedback-route.test.js`'s existing tests still pass with `corrections` now carrying `recurrence`.

- [ ] **Step 7: Commit**

```bash
git add server/src/feedback/index.js server/src/routes/feedback.js server/test/feedback-probe.test.js server/test/feedback-route.test.js
git commit -m "feat(server): resolve probe outcomes and attach recurrence in POST /feedback (M4)"
```

---

### Task 8: `GET /patterns`

**Files:**
- Create: `server/src/routes/patterns.js`
- Modify: `server/src/app.js`
- Test: `server/test/patterns-route.test.js`

**Interfaces:**
- Consumes: `listPatterns` (Task 5).
- Produces: `GET /patterns` → `{ patterns: Array<{pattern, example, frequency, status, probesPassed, lastSeenAt, lastProbedAt}> }`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/patterns-route.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { recordFindings } from "../src/repo/ledger.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await getPrisma().$disconnect();
});

describe("GET /patterns", () => {
  it("returns a patterns array", async () => {
    const res = await fetch(`${base}/patterns`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.patterns)).toBe(true);
  });

  it("includes a row after a finding is recorded, with the example visible", async () => {
    const p = `grammar:patterns-route-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." }]);
    const res = await fetch(`${base}/patterns`);
    const body = await res.json();
    const row = body.patterns.find((r) => r.pattern === p);
    expect(row).toMatchObject({ example: "I have 30 years", status: "active", frequency: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server test -- patterns-route`
Expected: FAIL — 404, `/patterns` is not yet routed.

- [ ] **Step 3: Create the route**

Create `server/src/routes/patterns.js`:

```javascript
import { Router } from "express";
import { listPatterns } from "../repo/ledger.js";

const router = Router();

/**
 * GET /patterns
 * resp: { patterns: [{ pattern, example, frequency, status, probesPassed, lastSeenAt, lastProbedAt }] }
 *
 * Read-only (spec D4/§7). `pattern` is included for React reconciliation
 * keys only — the client must not render it (see PatternsPanel.jsx).
 */
router.get("/", async (_req, res) => {
  try {
    const patterns = await listPatterns();
    return res.json({ patterns });
  } catch (err) {
    console.error("[patterns] read failed:", err);
    return res.status(502).json({ error: "Could not load patterns." });
  }
});

export default router;
```

- [ ] **Step 4: Wire it into `app.js`**

In `server/src/app.js`, the imports currently read:

```javascript
import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import feedbackRouter from "./routes/feedback.js";
```

Change to:

```javascript
import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import feedbackRouter from "./routes/feedback.js";
import patternsRouter from "./routes/patterns.js";
```

And the route registration currently reads:

```javascript
app.use("/turn", turnRouter);
app.use("/feedback", feedbackRouter);
```

Change to:

```javascript
app.use("/turn", turnRouter);
app.use("/feedback", feedbackRouter);
app.use("/patterns", patternsRouter);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix server test -- patterns-route`
Expected: PASS, 2 tests

Then run the full server suite:

Run: `npm --prefix server test`
Expected: PASS, full suite green

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/patterns.js server/src/app.js server/test/patterns-route.test.js
git commit -m "feat(server): add GET /patterns (M4)"
```

---

### Task 9: `client/src/lib/api.js` — `getPatterns`, `postFeedback` gains `probedPattern`

**Files:**
- Modify: `client/src/lib/api.js`
- Modify: `client/src/lib/api.test.js`

**Interfaces:**
- Produces: `getPatterns(): Promise<{patterns: Array} | null>` (never throws, same contract as `getHealth`). `postFeedback` accepts an added `probedPattern?: string` field, forwarded in the request body.

- [ ] **Step 1: Write the failing tests**

In `client/src/lib/api.test.js`, add this new `describe` block (append to the file, after the existing `postTurnOpen` block):

```javascript
describe("getPatterns", () => {
  it("returns the patterns payload on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ patterns: [{ pattern: "grammar:x", example: "x", frequency: 1, status: "active" }] }),
    }));
    const out = await getPatterns();
    expect(out.patterns).toHaveLength(1);
  });

  it("returns null on a server error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(getPatterns()).resolves.toBeNull();
  });

  it("returns null when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(getPatterns()).resolves.toBeNull();
  });
});
```

And change the top import line:

```javascript
import { postFeedback, postTurnOpen } from "./api.js";
```

to:

```javascript
import { postFeedback, postTurnOpen, getPatterns } from "./api.js";
```

Also add one assertion to the existing "returns the payload on success" test under `describe("postFeedback")` to prove `probedPattern` is forwarded — change:

```javascript
    const out = await postFeedback({ utterance: "hi", turnId: "t1" });
    expect(out.passes.mechanical).toBe("ok");
```

to:

```javascript
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ corrections: [], upgrades: [], passes: { mechanical: "ok", pedagogical: "ok" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await postFeedback({ utterance: "hi", turnId: "t1", probedPattern: "grammar:x" });
    expect(out.passes.mechanical).toBe("ok");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.probedPattern).toBe("grammar:x");
```

(this replaces the existing `vi.stubGlobal("fetch", ...)` call two lines above it in that same test — fold the two into one, do not leave a duplicate `stubGlobal` call.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix client test -- api.test`
Expected: FAIL — `getPatterns is not a function`; the `probedPattern` assertion fails because it is not yet sent.

- [ ] **Step 3: Implement**

In `client/src/lib/api.js`, `postFeedback` currently reads:

```javascript
export async function postFeedback({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables }) {
  try {
    const res = await fetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables }),
    });
```

Change to:

```javascript
export async function postFeedback({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables, probedPattern }) {
  try {
    const res = await fetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables, probedPattern }),
    });
```

Add this new function at the end of the file (after `postFeedback`):

```javascript
/**
 * The read-only patterns view (M4, spec D4). Never throws — a missing panel
 * is a degraded view, not a conversation error, same contract as getHealth.
 */
export async function getPatterns() {
  try {
    const res = await fetch("/patterns");
    if (!res.ok) return null;
    return await res.json(); // { patterns: [...] }
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix client test -- api.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/api.js client/src/lib/api.test.js
git commit -m "feat(client): add getPatterns, thread probedPattern through postFeedback (M4)"
```

---

### Task 10: `PatternsPanel.jsx`

**Files:**
- Create: `client/src/components/PatternsPanel.jsx`
- Create: `client/src/components/PatternsPanel.test.jsx`
- Modify: `client/src/components/__a11y__.test.jsx`

**Interfaces:**
- Consumes: `getPatterns` from Task 9.
- Produces: `<PatternsPanel open={boolean} />` — fetches on the `false → true` transition, renders `example` + a status/evidence line per row, never renders `pattern`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/PatternsPanel.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", () => ({ getPatterns: vi.fn() }));
import { getPatterns } from "../lib/api.js";
import PatternsPanel from "./PatternsPanel.jsx";

beforeEach(() => {
  getPatterns.mockReset();
});

describe("PatternsPanel", () => {
  it("renders nothing when closed, and does not fetch", () => {
    const { container } = render(<PatternsPanel open={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(getPatterns).not.toHaveBeenCalled();
  });

  it("fetches and renders rows when opened", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "grammar:x", example: "I have 30 years", frequency: 4, status: "active", probesPassed: 0, lastSeenAt: new Date().toISOString(), lastProbedAt: null },
      ],
    });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText("I have 30 years")).toBeInTheDocument());
  });

  it("never renders the raw pattern key", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "grammar:i have # years", example: "I have 30 years", frequency: 4, status: "active", probesPassed: 0, lastSeenAt: new Date().toISOString(), lastProbedAt: null },
      ],
    });
    const { container } = render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText("I have 30 years")).toBeInTheDocument());
    expect(container.textContent).not.toContain("grammar:i have # years");
  });

  it("shows status as visible text, not a title attribute", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "grammar:x", example: "I have 30 years", frequency: 4, status: "resolved", probesPassed: 3, lastSeenAt: new Date().toISOString(), lastProbedAt: new Date().toISOString() },
      ],
    });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeInTheDocument());
  });

  it("shows an empty state that does not read as failure", async () => {
    getPatterns.mockResolvedValue({ patterns: [] });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/keep talking/i)).toBeInTheDocument());
  });

  it("shows an empty state when the fetch fails too, never an error message", async () => {
    getPatterns.mockResolvedValue(null);
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/keep talking/i)).toBeInTheDocument());
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix client test -- PatternsPanel`
Expected: FAIL — `Failed to resolve import "./PatternsPanel.jsx"`

- [ ] **Step 3: Implement**

Create `client/src/components/PatternsPanel.jsx`:

```jsx
import { useEffect, useState } from "react";
import { getPatterns } from "../lib/api.js";

/** "1 day ago" vs "3 days ago" — no dependency needed for a single plural rule. */
function daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

/**
 * Status shown with its evidence beside it, as visible text (spec §7) —
 * never a bare label, never in a title attribute. `pattern` (the mangled
 * lexical key) is never part of this string; `example` is what the learner
 * recognises.
 */
function evidenceLine(row) {
  const parts = [];
  if (row.status === "resolved") parts.push("clean");
  else if (row.status === "improving") parts.push(`passed ${row.probesPassed} check${row.probesPassed === 1 ? "" : "s"}`);
  else parts.push("still slipping");

  const days = daysAgo(row.lastSeenAt);
  if (days !== null) parts.push(`last slip ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`);

  return parts.join(" · ");
}

/**
 * Read-only patterns view (spec D4). Fetches lazily on the closed->open
 * transition rather than on every mount, so the header affordance costs
 * nothing until the learner actually opens it.
 */
export default function PatternsPanel({ open }) {
  const [patterns, setPatterns] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getPatterns().then((data) => {
      if (!cancelled) setPatterns(data?.patterns ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <section
      aria-label="Your recurring patterns"
      className="mx-5 mb-4 rounded-2xl border border-line/70 bg-ink-2/60 p-3 text-sm"
    >
      {patterns === null && <p className="text-muted text-[12px]">Loading…</p>}
      {/* Empty state reads as "nothing yet", never as failure — covers both a genuinely empty ledger and a failed fetch (getPatterns never throws). */}
      {patterns?.length === 0 && <p className="text-muted text-[12px]">Nothing recorded yet — keep talking.</p>}
      {patterns?.map((row) => (
        <div key={row.pattern} className="mb-2 last:mb-0">
          <p className="leading-snug">{row.example}</p>
          <p className="text-[12px] text-muted mt-0.5">{evidenceLine(row)}</p>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix client test -- PatternsPanel`
Expected: PASS, 6 tests

- [ ] **Step 5: Add the a11y check**

In `client/src/components/__a11y__.test.jsx`, add the import:

```javascript
import PatternsPanel from "./PatternsPanel.jsx";
```

(next to the other component imports), and append this test at the end of the `describe("accessibility")` block, before its closing `});`:

```javascript
  it("PatternsPanel has no axe violations (with rows)", async () => {
    const { container } = render(<PatternsPanel open={true} />);
    expect(await axe(container)).toHaveNoViolations();
  });
```

(no mocking needed here — `open={true}` triggers a `getPatterns()` call against the real, un-mocked `fetch`, which will reject/fail fast in jsdom with no network; the component's loading state alone is what axe checks, matching how other a11y tests in this file render simple prop combinations without full data.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix client test -- __a11y__`
Expected: PASS, all a11y tests including the new one

- [ ] **Step 7: Commit**

```bash
git add client/src/components/PatternsPanel.jsx client/src/components/PatternsPanel.test.jsx client/src/components/__a11y__.test.jsx
git commit -m "feat(client): add the read-only PatternsPanel (M4)"
```

---

### Task 11: `useConversation.js` — carry the probe token across turns

**Files:**
- Modify: `client/src/hooks/useConversation.js`
- Modify: `client/src/hooks/useConversation.test.js`

**Interfaces:**
- Consumes: `probe` field on `postTurn`'s resolved value (Task 6); `probedPattern` param on `postFeedback` (Task 9).
- Produces: no new return value from the hook — the probe token is entirely internal (a `useRef`), matching spec D6 ("no new member in the state machine").

- [ ] **Step 1: Write the failing test**

In `client/src/hooks/useConversation.test.js`, append this new `describe` block (after the existing `describe("useConversation — deferred feedback", ...)` block, same file, same import style already in place):

```javascript
describe("useConversation — probe token", () => {
  // Spec §5.1's sequencing trap: turn N+1's /turn resolves before turn N+1's
  // /feedback fires, so the pending token from turn N must be read and sent
  // BEFORE the new probe (if any) from turn N+1 overwrites it — otherwise
  // turn N's probe is silently dropped and never resolves.
  it("sends turn N's probe token with turn N+1's feedback request, not turn N+1's own probe", async () => {
    postFeedback.mockResolvedValue(null);
    postTurn
      .mockResolvedValueOnce({ coach_reply: "ok1", xp: 1, sessionId: "s1", turnId: "t1", probe: { pattern: "grammar:turn-n" } })
      .mockResolvedValueOnce({ coach_reply: "ok2", xp: 1, sessionId: "s1", turnId: "t2", probe: { pattern: "grammar:turn-n-plus-1" } });

    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText("first"); });
    await act(async () => { await result.current.submitText("second"); });

    expect(postFeedback.mock.calls[0][0].probedPattern).toBeNull();
    expect(postFeedback.mock.calls[1][0].probedPattern).toBe("grammar:turn-n");
  });

  it("sends null probedPattern when no probe was ever issued", async () => {
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1", turnId: "t1", probe: null });
    postFeedback.mockResolvedValue(null);

    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText("hello"); });

    expect(postFeedback.mock.calls[0][0].probedPattern).toBeNull();
  });

  it("still works when postTurn's response has no probe field at all (older/degraded response)", async () => {
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const { result } = renderHook(() => useConversation());
    await expect(act(async () => { await result.current.submitText("hello"); })).resolves.not.toThrow();
    expect(postFeedback.mock.calls[0][0].probedPattern).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix client test -- useConversation`
Expected: FAIL — `postFeedback.mock.calls[1][0].probedPattern` is `undefined`, not `"grammar:turn-n"`.

- [ ] **Step 3: Implement**

In `client/src/hooks/useConversation.js`, add a new ref next to the other single-purpose refs. Find this block:

```javascript
  const sessionIdRef = useRef(null);
```

Add directly below it:

```javascript
  // The probe token carried between /turn and the NEXT /feedback call (spec
  // D6, §5.1). Not component state — nothing renders from it, and threading
  // it through a re-render would risk exactly the read-before-overwrite bug
  // §5.1 warns about.
  const pendingProbeRef = useRef(null);
```

In `runTurn`, the destructuring of `postTurn`'s response currently reads:

```javascript
      const { coach_reply, xp, audio, audioFormat, sessionId, turnId } = await postTurn({
```

Change to:

```javascript
      const { coach_reply, xp, audio, audioFormat, sessionId, turnId, probe } = await postTurn({
```

Further down in the same function, this line fires the deferred feedback request:

```javascript
      // Deferred feedback (spec D1): fire and forget. The panel fills in on an
      // already-rendered message; nothing here is allowed to block the voice.
      // The trailing .catch is defence in depth — postFeedback already
      // swallows its own errors, but the call site must not depend on that
      // upstream contract to stay safe from an unhandled rejection.
      requestFeedback({ utterance, turnId, historyBefore, userMsg, prosody }).catch(() => {});
```

Change to:

```javascript
      // M4 §5.1: read the PENDING probe (from the PREVIOUS turn) before
      // overwriting the ref with this turn's own probe — reversing this
      // order would silently drop the previous turn's probe outcome.
      const probedPattern = pendingProbeRef.current;
      pendingProbeRef.current = probe?.pattern ?? null;

      // Deferred feedback (spec D1): fire and forget. The panel fills in on an
      // already-rendered message; nothing here is allowed to block the voice.
      // The trailing .catch is defence in depth — postFeedback already
      // swallows its own errors, but the call site must not depend on that
      // upstream contract to stay safe from an unhandled rejection.
      requestFeedback({ utterance, turnId, historyBefore, userMsg, prosody, probedPattern }).catch(() => {});
```

`requestFeedback` currently reads:

```javascript
  async function requestFeedback({ utterance, turnId, historyBefore, userMsg, prosody }) {
    const payload = await postFeedback({
      utterance,
      turnId,
      history: toWireHistory(historyBefore),
      prosody,
      sessionPhonationMs: sessionPhonationRef.current,
      // Spoken turns only, matching the phonation above — both refs are
      // accumulated in the same `if (prosody)` block in runTurn, which has
      // already run by the time this is called.
      sessionSyllables: sessionSpokenSyllablesRef.current,
    });
```

Change to:

```javascript
  async function requestFeedback({ utterance, turnId, historyBefore, userMsg, prosody, probedPattern }) {
    const payload = await postFeedback({
      utterance,
      turnId,
      history: toWireHistory(historyBefore),
      prosody,
      sessionPhonationMs: sessionPhonationRef.current,
      // Spoken turns only, matching the phonation above — both refs are
      // accumulated in the same `if (prosody)` block in runTurn, which has
      // already run by the time this is called.
      sessionSyllables: sessionSpokenSyllablesRef.current,
      probedPattern,
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix client test -- useConversation`
Expected: PASS, all tests including the 3 new ones

- [ ] **Step 5: Check the coverage gate**

Run: `npm --prefix client run test:coverage`
Expected: `useConversation.js` still at or above 80% on all four metrics (it already was; this task adds ~6 lines all exercised by the new tests plus the existing suite's turn/feedback flows).

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js
git commit -m "feat(client): carry the probe token across turns (M4)"
```

---

### Task 12: Header affordance — `StatHeader.jsx` toggle, `App.jsx` wiring

**Files:**
- Modify: `client/src/components/StatHeader.jsx`
- Modify: `client/src/components/StatHeader.test.jsx`
- Modify: `client/src/components/__a11y__.test.jsx`
- Modify: `client/src/App.jsx`

**Interfaces:**
- Produces: `<StatHeader onTogglePatterns={fn} patternsOpen={boolean} ... />`. `App.jsx` owns `showPatterns` state and renders `<PatternsPanel open={showPatterns} />` between the header and the message list.

- [ ] **Step 1: Write the failing tests**

In `client/src/components/StatHeader.test.jsx`, check the existing imports at the top of the file (it already imports `render`/`screen` from Testing Library and `StatHeader` — extend that same pattern) and append:

```javascript
import userEvent from "@testing-library/user-event";
```

(only if not already imported in this file — check first; if `@testing-library/user-event` is already a dependency used elsewhere in the client suite, e.g. in `MicButton.test.jsx` or `TranscriptReview.test.jsx`, reuse the same import line style. If the package is not present in `client/package.json`, use `fireEvent.click` from `@testing-library/react` instead, which is already imported elsewhere in this suite — prefer that path if `user-event` is not already a client dependency, to avoid adding one.)

```javascript
describe("StatHeader — patterns toggle", () => {
  it("renders a patterns toggle button", () => {
    render(<StatHeader onTogglePatterns={() => {}} patternsOpen={false} />);
    expect(screen.getByRole("button", { name: /patterns/i })).toBeInTheDocument();
  });

  it("calls onTogglePatterns when clicked", () => {
    const onToggle = vi.fn();
    render(<StatHeader onTogglePatterns={onToggle} patternsOpen={false} />);
    screen.getByRole("button", { name: /patterns/i }).click();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("reflects the open state via aria-pressed", () => {
    render(<StatHeader onTogglePatterns={() => {}} patternsOpen={true} />);
    expect(screen.getByRole("button", { name: /patterns/i })).toHaveAttribute("aria-pressed", "true");
  });
});
```

(this file's top-level imports already include `vi` from vitest if any existing test in it uses mocks — check; if `vi` is not already imported at the top of `StatHeader.test.jsx`, add it to the existing `import { describe, it, expect } from "vitest";` line, changing it to `import { describe, it, expect, vi } from "vitest";`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix client test -- StatHeader`
Expected: FAIL — no button with an accessible name matching `/patterns/i` exists yet.

- [ ] **Step 3: Add the toggle button to `StatHeader.jsx`**

In `client/src/components/StatHeader.jsx`, the function signature currently reads:

```javascript
export default function StatHeader({ totalXp = 0, turns = 0, sessionFluency = null, brain, tts, stt }) {
```

Change to:

```javascript
export default function StatHeader({ totalXp = 0, turns = 0, sessionFluency = null, brain, tts, stt, onTogglePatterns, patternsOpen = false }) {
```

The right-side badge column currently ends with:

```javascript
        <Stat label="turns" value={turns} />
        <div className="flex flex-col items-end gap-1">
```

Add the button directly before `<Stat label="turns" ...>`, so it reads:

```javascript
        {onTogglePatterns && (
          <button
            type="button"
            onClick={onTogglePatterns}
            aria-pressed={patternsOpen}
            className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border transition ${
              patternsOpen ? "border-accent/60 text-accent" : "border-line text-muted hover:text-coach-soft hover:border-coach/50"
            }`}
          >
            📋 Patterns
          </button>
        )}
        <Stat label="turns" value={turns} />
        <div className="flex flex-col items-end gap-1">
```

(`onTogglePatterns &&` guards the button so `StatHeader`'s many existing call sites/tests that don't pass it — none of the pre-M4 tests do — keep rendering exactly as before with no button; `App.jsx` in Step 5 below always passes it.)

- [ ] **Step 4: Run the `StatHeader` tests, then the a11y test**

Run: `npm --prefix client test -- StatHeader`
Expected: PASS, all tests including the 3 new ones

In `client/src/components/__a11y__.test.jsx`, the existing `StatHeader` a11y test reads:

```javascript
  it("StatHeader has no axe violations", async () => {
    const { container } = render(
      <StatHeader totalXp={240} turns={5} sessionFluency={72} brain="mistral" tts="kokoro" stt="whisper" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
```

Add a second case right after it, so both the button-less and button-present renders stay axe-clean:

```javascript
  it("StatHeader has no axe violations (with the patterns toggle)", async () => {
    const { container } = render(
      <StatHeader
        totalXp={240}
        turns={5}
        sessionFluency={72}
        brain="mistral"
        tts="kokoro"
        stt="whisper"
        onTogglePatterns={() => {}}
        patternsOpen={true}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
```

Run: `npm --prefix client test -- __a11y__`
Expected: PASS

- [ ] **Step 5: Wire `App.jsx`**

In `client/src/App.jsx`, the imports currently read:

```javascript
import { Fragment, useEffect, useRef, useState } from "react";
import StatHeader from "./components/StatHeader.jsx";
import MessageBubble from "./components/MessageBubble.jsx";
import MicButton from "./components/MicButton.jsx";
import TranscriptReview from "./components/TranscriptReview.jsx";
import VoiceStatus from "./components/VoiceStatus.jsx";
import PauseNote from "./components/PauseNote.jsx";
import FeedbackPanel from "./components/FeedbackPanel.jsx";
import { useConversation } from "./hooks/useConversation.js";
```

Change to:

```javascript
import { Fragment, useEffect, useRef, useState } from "react";
import StatHeader from "./components/StatHeader.jsx";
import MessageBubble from "./components/MessageBubble.jsx";
import MicButton from "./components/MicButton.jsx";
import TranscriptReview from "./components/TranscriptReview.jsx";
import VoiceStatus from "./components/VoiceStatus.jsx";
import PauseNote from "./components/PauseNote.jsx";
import FeedbackPanel from "./components/FeedbackPanel.jsx";
import PatternsPanel from "./components/PatternsPanel.jsx";
import { useConversation } from "./hooks/useConversation.js";
```

The component body currently opens with:

```javascript
export default function App() {
  const c = useConversation();
  const [textInput, setTextInput] = useState("");
  const scrollRef = useRef(null);
```

Change to:

```javascript
export default function App() {
  const c = useConversation();
  const [textInput, setTextInput] = useState("");
  const [showPatterns, setShowPatterns] = useState(false);
  const scrollRef = useRef(null);
```

The JSX currently renders `<StatHeader ... />` with no follow-up element before `<main ...>`:

```javascript
      <StatHeader
        totalXp={c.totalXp}
        turns={c.turns}
        sessionFluency={c.sessionFluency}
        brain={c.providers.brain}
        tts={c.providers.tts}
        stt={c.providers.stt}
      />

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
```

Change to:

```javascript
      <StatHeader
        totalXp={c.totalXp}
        turns={c.turns}
        sessionFluency={c.sessionFluency}
        brain={c.providers.brain}
        tts={c.providers.tts}
        stt={c.providers.stt}
        onTogglePatterns={() => setShowPatterns((v) => !v)}
        patternsOpen={showPatterns}
      />

      <PatternsPanel open={showPatterns} />

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
```

- [ ] **Step 6: Manual smoke check in the browser**

Since this task changes rendered UI, verify it in the running app rather than only in tests: start the dev server (`npm run dev` from the repo root), open the client, click "📋 Patterns" in the header, confirm the panel opens showing either an empty state or rows, and click again to confirm it closes. Confirm no console errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/StatHeader.jsx client/src/components/StatHeader.test.jsx client/src/components/__a11y__.test.jsx client/src/App.jsx
git commit -m "feat(client): wire the patterns panel toggle into the header (M4)"
```

---

### Task 13: Docs — README + `.env.example` note

**Files:**
- Modify: `README.md`
- Modify: `server/.env.example`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the milestone table**

In `README.md`, find the line:

```
| **M4** | Error ledger + vocab spaced repetition | ⏭️ next |
```

Split it — M4 as built is the ledger-exploitation half only (spec D1: no vocabulary spaced repetition in this milestone), so replace that one row with two:

```
| **M4** | **Error ledger exploitation** — the coach periodically steers toward a construction the learner keeps failing, and a read-only patterns view shows which habits are changing on evidence, not on silence | ✅ shipped |
| **M4.5** | Vocabulary spaced repetition (`VocabItem`, SM-2) — deliberately deferred out of M4 (spec D1) | planned |
```

- [ ] **Step 2: Add `coach/` and `ledger/` to the architecture tree**

In `README.md`'s architecture tree (the `server/src/` block), find:

```
        ├── seed/         feeds | local        → the coach's opening topic (M8)
        ├── feedback/     Harper (mechanical) + LLM (pedagogical) → corrections + upgrades (M2)
```

Change to:

```
        ├── seed/         feeds | local        → the coach's opening topic (M8)
        ├── coach/        probe.js             → which recurring mistake to elicit next (M4)
        ├── ledger/       transitions.js       → the ErrorLedger status state machine (M4)
        ├── feedback/     Harper (mechanical) + LLM (pedagogical) → corrections + upgrades (M2)
```

- [ ] **Step 3: Update the tests badge**

Count the new total: run `npm test` from the repo root (Task 13's final full-suite run, see Step 5 below) and read the printed totals, then update:

```
![tests](https://img.shields.io/badge/tests-338%20passing-ffb35c?style=flat-square)
```

to whatever the new combined client+server total is (338 + this milestone's new tests — count them from the actual `npm test` output, do not guess).

- [ ] **Step 4: Note M4's honest limits in the Endpoints section**

In `README.md`'s `### Endpoints` table, find the `POST /feedback` row:

```
| `POST /feedback` | `{ utterance, turnId?, history?, prosody?, sessionPhonationMs?, sessionSyllables? }` → `{ corrections, upgrades, hesitation, sessionFluency, passes }` — deferred, per-turn structured feedback (M2), idempotent by `turnId`; persistence failing costs a row, never the response |
```

Change to:

```
| `POST /feedback` | `{ utterance, turnId?, history?, prosody?, sessionPhonationMs?, sessionSyllables?, probedPattern? }` → `{ corrections, upgrades, hesitation, sessionFluency, passes, probeResult }` — deferred, per-turn structured feedback (M2) plus M4's probe-outcome resolution, idempotent by `turnId`; persistence failing costs a row, never the response |
```

Add a new row directly below the `POST /turn` row:

```
| `GET /patterns` | → `{ patterns: [{ example, frequency, status, probesPassed, lastSeenAt, lastProbedAt }] }` — read-only (M4); a pattern's `status` reflects deliberate elicitation outcomes, not silence — see the design spec's §10 for what can and cannot be honestly claimed from it |
```

- [ ] **Step 5: Run the full suite one last time and confirm the badge number**

Run: `npm test` (from the repo root)
Expected: PASS, both suites green. Use the printed client + server totals to fill in Step 3's badge number precisely.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: update README for M4 (error ledger exploitation shipped)"
```

---

## Self-Review Notes

**Spec coverage check** — every §-numbered decision in the spec maps to a task:
- D1 (ledger exploitation only, no vocab/drill) → honored throughout; Task 13 documents the split explicitly.
- D2/D3 (elicitation is both pedagogy and measurement) → Task 3 (`chooseProbe`/directive) + Task 7 (outcome resolution).
- D4 (read-only patterns view) → Task 8 (route) + Task 10 (component).
- D5 (throttled to one per `PROBE_TURN_INTERVAL`) → Task 3.
- D6 (client-carried token) → Task 11.
- D7 (three consecutive passes to resolve) → Task 2.
- §3.2 (directive built from example/explanation, never `pattern`) → asserted directly in Task 3's and Task 10's tests.
- §4.1 (pure modules, second system message, repo/ledger.js as sole I/O) → Tasks 2, 3, 5, 6.
- §5.1 (sequencing trap) → Task 11, its own dedicated test.
- §5.2 (wire contract incl. the `+1` frequency rule) → Task 7.
- §5.3 (turn-count-from-DB, candidate pool, oldest-first, nulls-first) → Tasks 3, 4, 6.
- §6 (status transition table incl. relapse) → Task 2, Task 5's relapse test.
- §7 (ordering, never render `pattern`, visible evidence text, empty state) → Task 10.
- §8 / §8.1 (failure modes, idempotency placement) → Tasks 5, 6, 7 (the "most important test in M4").
- §9.3 (coverage gate extended in the creating commit) → Tasks 2 and 3.
- §12 (deferred decisions: directive wording, `GET /patterns` ordering/cap, header affordance) → pinned in Tasks 3, 5, 12 respectively, each with the reasoning inline.

**Not in this plan, by design:** §9.4's 20-turn hand evaluation and §11's two calibration questions are human/data-driven checks that need real usage, not code — they belong in `docs/superpowers/plans/voice-io-verification-checklist.md` after this ships, not as a task here.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-m4-error-ledger.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
