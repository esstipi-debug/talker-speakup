# M8 Phase 1 — The Opening Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The coach opens every session by raising a concrete subject and asking for an opinion, instead of the client rendering a hardcoded greeting — with no network, no API key, and no RSS feed involved.

**Architecture:** A new `seed/` module supplies an opening topic behind a provider factory shaped like `brain/`. A new `POST /turn/open` asks the brain for a first turn with no learner utterance, using a system prompt built around that topic, and records which provider supplied it on the `Session` row. The client calls it on mount and falls back to today's constant if anything goes wrong. Phase 2 adds a second provider fed by RSS; nothing else changes when it does.

**Tech Stack:** Node 20+ ESM, Express 5, Prisma 6 + SQLite, Vitest 4 (node env for server, jsdom + Testing Library for client).

**Spec:** [`docs/superpowers/specs/2026-08-02-sourced-proactivity-design.md`](../specs/2026-08-02-sourced-proactivity-design.md). This plan implements its §11 build-order steps 1–2, plus the topic block from step 7. Steps 3–6 and 8 are phase 2.

**Base:** `main` at `f27093c`. **Verify this before starting** — `git log --oneline -1 main`. This project has more than one worktree and one of them shipped a duplicate milestone by trusting a stale README instead of checking `main`.

## Global Constraints

- **`server/src/repo/session.js` is the only module that reads or writes the Prisma `Session` and `Turn` models.** `repo/ledger.js` owns `ErrorLedger`. Do not add Prisma access anywhere else.
- **The coach's pedagogy lives in `server/src/prompts/coach-system.js`, not in route or adapter code.** Any English the learner will hear shaped by, or any instruction about how to teach, belongs in that file.
- **`coachSystemM1` is a FROZEN BASELINE.** Its docstring says so. Do not edit it for any reason.
- **Degrade, never break.** Every failure in this plan must leave a working session: no seed, no brain, no TTS, no network, no database — the learner still gets an opening line and can still speak.
- **Nothing may be added to `server/src/app.js` that performs I/O at import time.** The server test suite imports `app.js`.
- **`POST /turn`'s request and response contracts do not change.** `/turn/open` is a new sibling route.
- **The opening line must never be autoplayed.** Browsers block audio playback without a user gesture; an opener that tries to speak on mount fails silently and inconsistently. Render the text, keep the audio for the existing replay control.
- Server tests: `npm --prefix server test`. Client tests: `npm --prefix client test`. Both: `npm test` from the repo root.
- A fresh clone or worktree needs `npm --prefix server install && npm --prefix server exec -- prisma generate` before the server suite will run. A wall of `@prisma/client did not initialize yet` means that step was skipped, not that the code is broken.

---

### Task 1: Record which provider opened the session

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/repo/session.js`
- Test: `server/test/session-repo.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `recordSeed(sessionId, { provider, topicId }): Promise<void>` — stores which seed provider opened a session and, when there is one, the id of the item that supplied the topic. `Session.seedProvider` and `Session.topicId` columns exist.

**A deliberate split from the spec:** §11 step 1 bundles the `FeedItem` model into this same migration. It is left out here. `FeedItem` has no reader and no writer until phase 2, and shipping an unused table so the schema "moves once" only pays off across milestones — inside one milestone, two small migrations are each independently verifiable and neither leaves dead schema behind.

**Why this is task 1 and not an afterthought:** these two columns are the reason M8 was sequenced after M2 at all. Without them there is no way to compare words-per-turn and hesitation between sourced and unsourced sessions, and the milestone becomes a feature that feels smarter with no evidence it teaches better. If this task gets cut for being "just instrumentation", the spec's §12 becomes unanswerable.

- [ ] **Step 1: Write the failing test**

Append to `server/test/session-repo.test.js`:

```js
describe("seed provenance", () => {
  it("records which provider opened the session", async () => {
    const session = await startSession();
    await recordSeed(session.id, { provider: "local", topicId: null });

    const stored = await getSessionWithTurns(session.id);
    expect(stored.seedProvider).toBe("local");
    expect(stored.topicId).toBeNull();
  });

  it("records the topic id when the provider had one", async () => {
    const session = await startSession();
    await recordSeed(session.id, { provider: "feeds", topicId: "item-42" });

    const stored = await getSessionWithTurns(session.id);
    expect(stored.seedProvider).toBe("feeds");
    expect(stored.topicId).toBe("item-42");
  });

  it("leaves both columns null on a session that was never seeded", async () => {
    const session = await startSession();
    const stored = await getSessionWithTurns(session.id);
    expect(stored.seedProvider).toBeNull();
    expect(stored.topicId).toBeNull();
  });
});
```

Add `recordSeed` to the existing import from `../src/repo/session.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix server test -- session-repo`
Expected: FAIL — `recordSeed is not a function`.

- [ ] **Step 3: Add the columns**

In `server/prisma/schema.prisma`, add to `model Session` after `summary`:

```prisma
  // Which seed provider opened this session, and the id of the item that
  // supplied the topic (null for providers that have no item, like `local`).
  // This is the measurement hook: without it there is no way to compare a
  // sourced session against an unsourced one, which is the whole reason M8
  // was sequenced after M2.
  seedProvider String?
  topicId      String?
```

- [ ] **Step 4: Run the migration**

Run: `npm --prefix server exec -- prisma migrate dev --name m8_session_seed`

Use this form, not `npm run prisma:migrate` — the underlying `prisma migrate dev` prompts for a name interactively and will hang in a non-interactive shell. If it asks to reset the database, stop and report rather than accepting.

- [ ] **Step 5: Implement**

In `server/src/repo/session.js`, add after `startSession`:

```js
/**
 * Stamps a session with the provenance of its opening topic. Separate from
 * startSession because the session exists before the seed is chosen: /turn/open
 * may adopt a session the client already had.
 */
export async function recordSeed(sessionId, { provider, topicId = null }) {
  await getPrisma().session.update({
    where: { id: sessionId },
    data: { seedProvider: provider, topicId },
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm --prefix server test -- session-repo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/prisma server/src/repo/session.js server/test/session-repo.test.js
git commit -m "feat: record which seed provider opened a session"
```

---

### Task 2: The seed provider

**Files:**
- Create: `server/src/seed/local.js`
- Create: `server/src/seed/index.js`
- Test: `server/test/seed-local.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nextSeed(): Promise<Seed>` from `seed/index.js`, where
    `Seed = { provider: string, topic: string, sourceLabel: string | null, sourceUrl: string | null, topicId: string | null }`.
  - `pickOpener(n: number): Seed` from `seed/local.js` — pure, deterministic for a given `n`.
  - `local.nextSeed(): Promise<Seed>` — never returns null. It is the terminal provider.

**A deviation from the spec, made deliberately:** the spec's §4.1 describes `local.js` as drawing a topic "from the ErrorLedger or the last session summary". Neither is usable:

- **Nothing writes `Session.summary`.** Verified with `grep -rn "summary" server/src` — the column has been decorative since M0. Reading it would be dead code.
- **An `ErrorLedger` pattern is a mistake, not a subject.** Its keys are lexical fragments of what the learner got wrong (`grammar:i have # years`). Opening a conversation from one turns the opener into a correction, which the M2 coach prompt explicitly forbids in the conversational turn.

So `local` is a fixed rotation of concrete subjects and nothing else. That is honest, it is what the milestone actually needs, and it is three lines instead of two dead branches.

- [ ] **Step 1: Write the failing test**

Create `server/test/seed-local.test.js`:

```js
import { describe, it, expect } from "vitest";
import { pickOpener, OPENERS } from "../src/seed/local.js";
import { nextSeed } from "../src/seed/index.js";

describe("seed/local", () => {
  it("is deterministic for a given n", () => {
    expect(pickOpener(7)).toEqual(pickOpener(7));
  });

  it("walks the whole rotation rather than favouring one entry", () => {
    const seen = new Set();
    for (let n = 0; n < OPENERS.length; n += 1) seen.add(pickOpener(n).topic);
    expect(seen.size).toBe(OPENERS.length);
  });

  it("handles a negative or huge n without falling off the array", () => {
    for (const n of [-1, -999, 0, Number.MAX_SAFE_INTEGER]) {
      expect(typeof pickOpener(n).topic).toBe("string");
      expect(pickOpener(n).topic.length).toBeGreaterThan(0);
    }
  });

  it("reports itself as the local provider with no source or item", () => {
    const seed = pickOpener(0);
    expect(seed.provider).toBe("local");
    expect(seed.sourceLabel).toBeNull();
    expect(seed.sourceUrl).toBeNull();
    expect(seed.topicId).toBeNull();
  });
});

describe("seed/index", () => {
  it("always returns a seed — local is the terminal provider", async () => {
    const seed = await nextSeed();
    expect(seed).not.toBeNull();
    expect(seed.provider).toBe("local");
    expect(typeof seed.topic).toBe("string");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix server test -- seed-local`
Expected: FAIL — cannot resolve `../src/seed/local.js`.

- [ ] **Step 3: Implement `local.js`**

Create `server/src/seed/local.js`:

```js
/**
 * The terminal seed provider: no network, no database, never returns null.
 *
 * Every other provider may come up empty — no feeds configured, nothing
 * cached, everything already used — and falls through to this one. That is
 * why it cannot fail: it is what stands between a dead feed and a session
 * that will not open.
 *
 * The subjects are chosen to be arguable rather than merely answerable. "How
 * was your weekend" has a three-word answer and the M2 coach prompt would
 * spend its first turn dragging the learner off it.
 */
const OPENERS = [
  "whether working from home actually makes people better at their jobs, or just more available",
  "why some films are worth watching twice and most are not",
  "whether a city is better judged by its public transport or its food",
  "what a person should be allowed to keep private from an employer",
  "whether learning a language as an adult is harder than people claim, or just less forgiving",
  "why some jobs are respected far more than they are paid, and others the reverse",
  "whether the best way to learn something is to teach it, or to fail at it in public",
  "what makes a place feel like home when you did not grow up there",
];

export { OPENERS };

/**
 * Pure and deterministic. `n` is any integer — the caller supplies a clock, so
 * this module keeps no state and the tests keep no fixtures.
 */
export function pickOpener(n) {
  const index = ((Math.trunc(n) % OPENERS.length) + OPENERS.length) % OPENERS.length;
  return {
    provider: "local",
    topic: OPENERS[index],
    sourceLabel: null,
    sourceUrl: null,
    topicId: null,
  };
}

export async function nextSeed() {
  return pickOpener(Date.now());
}
```

- [ ] **Step 4: Implement the factory**

Create `server/src/seed/index.js`:

```js
import * as local from "./local.js";

/**
 * Seed provider chain. Each provider returns a seed or null; the first
 * non-null wins. `local` is last and never returns null, so this function
 * cannot fail to produce an opening topic.
 *
 * Phase 2 inserts the RSS-backed `feeds` provider ahead of `local`. That is
 * the entire integration: no caller changes, and a dry or unreachable feed
 * degrades to `local` by falling through, not by an error path.
 */
const PROVIDERS = [local];

export async function nextSeed() {
  for (const provider of PROVIDERS) {
    try {
      const seed = await provider.nextSeed();
      if (seed) return seed;
    } catch (err) {
      console.warn("[seed] provider failed, falling through:", err.message);
    }
  }
  return null; // unreachable while `local` is terminal; kept so the contract is honest
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm --prefix server test -- seed-local`
Expected: PASS, all five cases.

- [ ] **Step 6: Commit**

```bash
git add server/src/seed server/test/seed-local.test.js
git commit -m "feat: add the opening-seed provider chain"
```

---

### Task 3: Teach the coach to open

**Files:**
- Modify: `server/src/prompts/coach-system.js`
- Modify: `server/src/brain/mock.js`
- Modify: `server/src/brain/mistral.js`
- Test: `server/test/coach-prompt.test.js`
- Test: `server/test/brain-open.test.js`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces:
  - `buildOpeningPrompt(topic: string): string` from `prompts/coach-system.js` — the active coach prompt plus an opening instruction and the topic, as a delimited data block.
  - `openTurn({ topic }): Promise<{ coach_reply: string, xp: number }>` on both brains — the same return shape as `evaluateTurn`, so the route can treat them identically.

- [ ] **Step 1: Write the failing prompt test**

Append to `server/test/coach-prompt.test.js`:

```js
describe("buildOpeningPrompt", () => {
  const TOPIC = "whether a city is better judged by its public transport or its food";

  it("carries the active coach prompt, so pressure and register still apply", () => {
    const built = buildOpeningPrompt(TOPIC);
    expect(built).toContain("YOUR ENGLISH IS THE LESSON");
  });

  it("includes the topic", () => {
    expect(buildOpeningPrompt(TOPIC)).toContain(TOPIC);
  });

  it("forbids assuming the learner has seen or read anything", () => {
    expect(buildOpeningPrompt(TOPIC).toLowerCase()).toContain("never assume");
  });

  it("delimits the topic as data rather than splicing it into instructions", () => {
    // The topic is untrusted text in phase 2 — it comes from a feed. Even now,
    // it must sit inside a marked block so a topic containing instruction-like
    // wording cannot read as an instruction.
    const built = buildOpeningPrompt(TOPIC);
    const block = built.slice(built.indexOf("<topic>"), built.indexOf("</topic>") + 8);
    expect(block).toContain(TOPIC);
  });

  it("still opens on a topic when COACH_PROMPT is the frozen m1 baseline", () => {
    process.env.COACH_PROMPT = "m1";
    try {
      expect(buildOpeningPrompt(TOPIC)).toContain(TOPIC);
    } finally {
      delete process.env.COACH_PROMPT;
    }
  });
});
```

Add `buildOpeningPrompt` to that file's import from `../src/prompts/coach-system.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix server test -- coach-prompt`
Expected: FAIL — `buildOpeningPrompt is not a function`.

- [ ] **Step 3: Implement the prompt builder**

Append to `server/src/prompts/coach-system.js`:

```js
/**
 * The system prompt for the coach's FIRST turn, when the learner has not
 * spoken yet.
 *
 * The topic is a SUBJECT, never an artefact: the coach discusses the thing
 * itself and never mentions a video, a channel, or that anything is recent.
 * That is what lets the same prompt work whether the topic came from a fixed
 * rotation or from a feed the learner may not have watched — see the M8 spec's
 * D2. It also means a stale topic is indistinguishable from a fresh one, which
 * is why phase 2 needs no expiry logic at all.
 *
 * The topic is delimited because in phase 2 it is untrusted text lifted from a
 * feed. Splicing it into the instruction text would let a title read as an
 * instruction.
 */
export function buildOpeningPrompt(topic) {
  return `${selectCoachPrompt()}

THIS IS YOUR OPENING LINE. The learner has not said anything yet.

Open by raising the subject inside the <topic> block below and asking for their opinion on it. Be concrete and specific — never "what would you like to talk about?", which hands the work back to them.

NEVER assume the learner has seen, read, heard or watched anything. Do not mention a video, a channel, an article, or that the subject is recent or new. Discuss the subject itself.

If they steer the conversation elsewhere, follow them. The topic is a starting point, not a rail.

<topic>
${topic}
</topic>`;
}
```

- [ ] **Step 4: Write the failing brain test**

Create `server/test/brain-open.test.js`:

```js
import { describe, it, expect } from "vitest";
import { MockBrain } from "../src/brain/mock.js";

const TOPIC = "whether learning a language as an adult is harder than people claim";

describe("MockBrain.openTurn", () => {
  it("returns a coach line and xp, the same shape as evaluateTurn", async () => {
    const out = await new MockBrain().openTurn({ topic: TOPIC });
    expect(typeof out.coach_reply).toBe("string");
    expect(out.coach_reply.length).toBeGreaterThan(0);
    expect(typeof out.xp).toBe("number");
  });

  it("opens on the topic it was given", async () => {
    const out = await new MockBrain().openTurn({ topic: TOPIC });
    expect(out.coach_reply).toContain(TOPIC);
  });

  it("still produces an opening line with no topic at all", async () => {
    const out = await new MockBrain().openTurn({ topic: null });
    expect(out.coach_reply.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm --prefix server test -- brain-open`
Expected: FAIL — `openTurn is not a function`.

- [ ] **Step 6: Implement `openTurn` on the mock**

Add to the `MockBrain` class in `server/src/brain/mock.js`:

```js
  /**
   * The $0 opener. It cannot reason about a topic, so it states it and asks
   * for an opinion — which is structurally the right move even when the
   * wording is wooden. The loop is demonstrable with no key; the pedagogy is
   * the real brain's job.
   */
  async openTurn({ topic }) {
    const subject = topic ? `Here's something I've been chewing on: ${topic}. Where do you land on it?`
                          : "Let's get straight into it — tell me about something that annoyed you this week, and why.";
    return { coach_reply: subject, xp: 0 };
  }
```

- [ ] **Step 7: Probe how the Mistral API handles a system-only message list**

The opener has no user message by nature. Before writing the adapter, find out whether the API accepts a `messages` array containing only a system message.

If `MISTRAL_API_KEY` is set in `server/.env`, write a throwaway script `server/tmp-open-probe.mjs` that POSTs to `https://api.mistral.ai/v1/chat/completions` with `messages: [{ role: "system", content: "Say the word READY." }]` and print the status and body. Run it, note the result, and `rm server/tmp-open-probe.mjs` — it is never committed.

If no key is configured, skip the probe and take the fallback branch in Step 8 directly, saying so in your report. Do not add a key, and do not fabricate a probe result.

- [ ] **Step 8: Implement `openTurn` on the Mistral brain**

Add to the `MistralBrain` class in `server/src/brain/mistral.js`:

```js
  async openTurn({ topic }) {
    const messages = [
      { role: "system", content: buildOpeningPrompt(topic) },
      // A stage cue, not learner speech. It never enters the transcript and is
      // never shown. Present because a chat completion with no user message is
      // rejected by some providers — see the probe in this task's step 7.
      { role: "user", content: "Begin." },
    ];

    const res = await fetch(`${MISTRAL_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.8, max_tokens: 200 }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mistral API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Mistral returned an empty opening line.");
    return { coach_reply: reply, xp: 0 };
  }
```

Add `buildOpeningPrompt` to that file's existing import from `../prompts/coach-system.js`.

If the step 7 probe showed the API accepts a system-only list, drop the `"Begin."` message and replace the comment with one line recording that the probe confirmed it.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm --prefix server test`
Expected: PASS, whole suite. The Mistral adapter is not unit-tested here — it is network I/O behind a key, same as `evaluateTurn`, which also has no unit test.

- [ ] **Step 10: Commit**

```bash
git add server/src/prompts/coach-system.js server/src/brain server/test/coach-prompt.test.js server/test/brain-open.test.js
git commit -m "feat: teach the coach to open a session on a given topic"
```

---

### Task 4: `POST /turn/open`

**Files:**
- Modify: `server/src/routes/turn.js`
- Test: `server/test/turn-open.test.js`

**Interfaces:**
- Consumes: `nextSeed` (Task 2), `openTurn` (Task 3), `startSession` / `recordTurn` / `recordSeed` (Task 1).
- Produces: `POST /turn/open`, body `{ sessionId? }` → `{ coach_reply, xp, audio?, audioFormat?, ttsProvider, sessionId, seedProvider }`. Never 5xx unless the brain itself fails, matching `POST /turn`.

- [ ] **Step 1: Write the failing test**

Create `server/test/turn-open.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { getSessionWithTurns } from "../src/repo/session.js";

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

async function open(body = {}) {
  const res = await fetch(`${base}/turn/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /turn/open", () => {
  it("returns an opening line with no utterance in the request", async () => {
    const { status, body } = await open();
    expect(status).toBe(200);
    expect(body.coach_reply.length).toBeGreaterThan(0);
  });

  it("opens a session and persists the opener as a coach turn", async () => {
    const { body } = await open();
    expect(body.sessionId).toBeTruthy();

    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].role).toBe("coach");
    expect(session.turns[0].text).toBe(body.coach_reply);
  });

  it("stamps the session with the provider that supplied the topic", async () => {
    const { body } = await open();
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.seedProvider).toBe("local");
    expect(body.seedProvider).toBe("local");
  });

  it("adopts a session it is given instead of opening a new one", async () => {
    const first = await open();
    const second = await open({ sessionId: first.body.sessionId });
    expect(second.body.sessionId).toBe(first.body.sessionId);
  });

  it("still answers when the session id does not exist — the loop never breaks on a DB miss", async () => {
    const { status, body } = await open({ sessionId: "does-not-exist" });
    expect(status).toBe(200);
    expect(body.coach_reply.length).toBeGreaterThan(0);
    expect(body.sessionId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix server test -- turn-open`
Expected: FAIL — 404 on every case.

- [ ] **Step 3: Implement the route**

Add to `server/src/routes/turn.js`. Put it **above** `router.post("/audio", ...)` so the two sibling routes read together, and extend the imports:

```js
import { startSession, recordTurn, recordSeed } from "../repo/session.js";
import { nextSeed } from "../seed/index.js";
```

```js
/**
 * POST /turn/open
 * body: { sessionId?: string }
 * resp: { coach_reply, xp, audio?, audioFormat?, ttsProvider, sessionId, seedProvider }
 *
 * The coach's first turn, before the learner has said anything. This exists as
 * a sibling of POST /turn rather than as a nullable `utterance` on it: /turn's
 * validation catches real client bugs and is worth keeping strict.
 *
 * The opening line is deliberately NOT the client's business to compose. The
 * learner should never be asked "what would you like to talk about?" — that
 * hands the work back to the person who came here to be pushed.
 */
router.post("/open", async (req, res) => {
  const { sessionId } = req.body ?? {};

  const seed = await nextSeed().catch(() => null);

  let result;
  try {
    result = await getBrain().openTurn({ topic: seed?.topic ?? null });
  } catch (err) {
    console.error("[turn/open] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }

  let audio = null;
  let audioFormat = null;
  const tts = getTTS();
  if (tts && result?.coach_reply) {
    try {
      const out = await tts.speak(result.coach_reply);
      audio = out.audio.toString("base64");
      audioFormat = out.format;
    } catch (ttsErr) {
      console.warn("[turn/open] TTS failed → client will use browser voice:", ttsErr.message);
    }
  }

  const persistedId = await persistOpening({ sessionId, seed, coachReply: result.coach_reply });

  return res.json({
    ...result,
    audio,
    audioFormat,
    ttsProvider: currentTTSProvider(),
    sessionId: persistedId,
    seedProvider: seed?.provider ?? null,
  });
});

/**
 * Same rule persistTurn follows: a DB failure costs the row, never the turn.
 * Returns null rather than echoing back an id it could not write to, so the
 * client opens a fresh session next turn instead of retrying a dead one.
 */
async function persistOpening({ sessionId, seed, coachReply }) {
  let id = sessionId ?? null;
  try {
    if (!id) id = (await startSession()).id;
    await recordTurn({ sessionId: id, role: "coach", text: coachReply });
    if (seed) await recordSeed(id, { provider: seed.provider, topicId: seed.topicId });
    return id;
  } catch (dbErr) {
    console.warn("[turn/open] persistence failed, continuing:", dbErr.message);
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix server test -- turn-open`
Expected: PASS, all five cases.

- [ ] **Step 5: Run the whole server suite**

Run: `npm --prefix server test`
Expected: PASS. `POST /turn` and `POST /turn/audio` must be untouched — if any of their tests moved, the route was edited rather than extended.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/turn.js server/test/turn-open.test.js
git commit -m "feat: add POST /turn/open so the coach speaks first"
```

---

### Task 5: The client opens from the server

**Files:**
- Modify: `client/src/lib/api.js`
- Modify: `client/src/hooks/useConversation.js`
- Test: `client/src/lib/api.test.js`
- Test: `client/src/hooks/useConversation.test.js`

**Interfaces:**
- Consumes: `POST /turn/open` (Task 4).
- Produces: `postTurnOpen({ sessionId }): Promise<object | null>` in `api.js` — resolves to the payload, or `null` on any failure, matching how `getHealth` already degrades.

- [ ] **Step 1: Write the failing api test**

Append to `client/src/lib/api.test.js`, following the shape of the existing `postFeedback` cases:

```js
describe("postTurnOpen", () => {
  it("posts the session id and returns the payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ coach_reply: "So — where do you land on it?", sessionId: "s1", seedProvider: "local" }),
    });

    const out = await postTurnOpen({ sessionId: "s1" });
    expect(out.coach_reply).toBe("So — where do you land on it?");
    expect(global.fetch).toHaveBeenCalledWith("/turn/open", expect.objectContaining({ method: "POST" }));
  });

  it("resolves to null on a server error rather than throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    expect(await postTurnOpen({})).toBeNull();
  });

  it("resolves to null when the network is down", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await postTurnOpen({})).toBeNull();
  });
});
```

Add `postTurnOpen` to that file's import from `./api.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix client test -- api`
Expected: FAIL — `postTurnOpen is not a function`.

- [ ] **Step 3: Implement the transport**

Add to `client/src/lib/api.js`:

```js
/**
 * The coach's opening turn. Returns null on ANY failure — a session that
 * cannot reach the server must still open with the local greeting, so this
 * never throws and never makes the caller handle an error path.
 */
export async function postTurnOpen({ sessionId }) {
  try {
    const res = await fetch("/turn/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Write the failing hook test**

Append to `client/src/hooks/useConversation.test.js`, matching how that file already mocks `../lib/api.js`:

```js
describe("the coach opens the session", () => {
  it("replaces the local greeting with the server's opening line", async () => {
    postTurnOpen.mockResolvedValue({
      coach_reply: "So — is a city better judged by its transport or its food?",
      sessionId: "s1",
      seedProvider: "local",
    });

    const { result } = renderHook(() => useConversation());
    await waitFor(() => {
      expect(result.current.messages[0].text).toContain("transport or its food");
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it("keeps the local greeting when the server cannot be reached", async () => {
    postTurnOpen.mockResolvedValue(null);

    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(postTurnOpen).toHaveBeenCalled());
    expect(result.current.messages[0].text).toContain("SpeakUp coach");
    expect(result.current.status).toBe("idle");
  });

  it("does not autoplay the opener", async () => {
    postTurnOpen.mockResolvedValue({
      coach_reply: "So — where do you land on it?",
      audio: "AAAA",
      audioFormat: "mp3",
      sessionId: "s1",
    });

    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.messages[0].text).toContain("where do you land"));
    expect(playAudio).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });
});
```

Add `postTurnOpen` to the mocked `../lib/api.js` module factory in that file, and make sure `playAudio` and `speak` are available from the existing `../lib/speech.js` mock.

- [ ] **Step 5: Run it to verify it fails**

Run: `npm --prefix client test -- useConversation`
Expected: FAIL — the greeting is never replaced.

- [ ] **Step 6: Implement the opener in the hook**

In `client/src/hooks/useConversation.js`, add `postTurnOpen` to the `../lib/api.js` import, keep the `GREETING` constant exactly as it is, and extend the existing mount effect:

```js
  useEffect(() => {
    warmUpVoices();
    getHealth().then((h) => {
      if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt });
    });

    // The coach speaks first. The local GREETING stays as the fallback rather
    // than being deleted: no server, no key and no network must still produce
    // an opening line.
    //
    // The opener is NOT played aloud. Browsers block audio without a user
    // gesture, so autoplaying here fails silently on a cold load and works on
    // a warm one — the worst kind of inconsistency. The audio rides along and
    // the existing replay control plays it on demand.
    let cancelled = false;
    postTurnOpen({ sessionId: sessionIdRef.current }).then((opening) => {
      if (cancelled || !opening?.coach_reply) return;
      sessionIdRef.current = opening.sessionId ?? null;
      setMessages([{
        id: 0,
        role: "coach",
        text: opening.coach_reply,
        audio: opening.audio,
        audioFormat: opening.audioFormat,
      }]);
    });
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 7: Run the client suite**

Run: `npm --prefix client test`
Expected: PASS. Then `npm --prefix client run test:coverage` — `useConversation.js` is behind an 80% gate on four metrics and this task adds a branch to it.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/api.js client/src/hooks/useConversation.js client/src/lib/api.test.js client/src/hooks/useConversation.test.js
git commit -m "feat(client): open the session from the coach, not a constant"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `server/.env.example`

**Interfaces:** none.

- [ ] **Step 1: Add the endpoint to the README**

In the Endpoints table in `README.md`, add a row under `POST /turn`:

```
| `POST /turn/open` | `{ sessionId? }` → `{ coach_reply, xp, audio?, audioFormat?, ttsProvider, sessionId, seedProvider }` — the coach's first turn, before the learner has spoken |
```

- [ ] **Step 2: Document the milestone's state**

In the milestone table in `README.md`, add a row after M7:

```
| **M8** | **Sourced proactivity** — the coach opens on a subject worth arguing about. Phase 1 (a local topic rotation) shipped; phase 2 feeds it from RSS channels you choose | 🚧 phase 1 |
```

- [ ] **Step 3: Note the absent knob**

Add to `server/.env.example`:

```
# --- Seed (M8) ---
# Phase 1 has no configuration: the coach opens from a built-in rotation of
# subjects. Phase 2 adds SOURCE_FEEDS, a comma-separated list of RSS feed URLs
# (YouTube channel feeds work as-is), and the coach opens on those instead —
# falling back to the rotation whenever they are empty or unreachable.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, client and server.

- [ ] **Step 5: Commit**

```bash
git add README.md server/.env.example
git commit -m "docs: document POST /turn/open and the M8 phase 1 state"
```

---

## Done when

- Opening the app with no API key, no TTS container and no network beyond localhost produces a coach line that raises a concrete subject and asks for an opinion.
- Stopping the server and reloading still produces an opening line — the local `GREETING` constant.
- The opener does not try to speak on load.
- `Session.seedProvider` is `"local"` on every session opened through the new route.
- `npm test` passes; `npm --prefix client run test:coverage` still meets the 80% gate on `useConversation.js`.

## Not in this plan (Phase 2)

Spec §11 build-order steps 3–6 and 8: the `FeedItem` model and `repo/topics.js`, `seed/rss.js` (fetching and Atom/RSS parsing), `seed/select.js` (newest-unused selection), `seed/feeds.js` and its registration ahead of `local` in the provider chain, the boot-time background refresh in `index.js`, the `sources` block in `GET /health`, and the `SOURCE_FEEDS` env var.

The seam this plan builds is what makes that a small change: phase 2 adds one provider to one array.
