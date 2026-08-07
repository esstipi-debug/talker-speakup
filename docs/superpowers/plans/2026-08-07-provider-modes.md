# Provider Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SpeakUp's real operating configurations selectable by name in one command (`npm run dev:web` / `dev:cloud` / `dev:hybrid`), and make the running app report its own mode honestly — including when it is not the mode that was requested.

**Architecture:** A new `server/src/config/mode.js` owns the preset table and is the single source of truth for what each mode means. The `brain` and `tts` factories consult it for defaults, with explicit env vars still winning. `modeStatus()` derives the effective mode from the providers that actually resolved, plus one in-memory flag recording whether real TTS synthesis last succeeded. `/health` publishes the result; the client renders it as a pill and refreshes only on the edge where it can change.

**Tech Stack:** Node ≥22, Express 5.2, Vitest (node environment for server, jsdom + Testing Library + jest-axe for client), React 19.

**Spec:** [`docs/superpowers/specs/2026-08-07-provider-modes-design.md`](../specs/2026-08-07-provider-modes-design.md)

## Global Constraints

- **A mode controls exactly two slots: `brain` and `tts`** (spec D1). `stt`, `pron` and `sources` stay orthogonal env vars. Do not add them to the preset table.
- **`auto` is the default and must reproduce today's resolution byte-for-byte** (spec D2): brain auto-detected from the key, tts `kokoro`. This is the plan's most important test.
- **Precedence: explicit env var → mode default → legacy default** (spec D3). An existing `.env` keeps meaning what it meant.
- **`degraded` marks failure, not choice** (spec D5). A deliberate env override that moves the effective mode is `degraded: false`.
- **TTS reachability is learned from real turns only** (spec D6). No probe, no timer. The flag starts `null` meaning *not yet attempted*, and `null` never degrades.
- **`mode.js` must not import the factories.** The factories import it; `modeStatus()` receives providers as arguments. A cycle here is a defect.
- **An unknown mode warns and falls back to `auto`. It never throws** (spec D8).
- **Only the `--mode=<value>` form is supported.** `--mode <value>` is not.
- **`server/src/config/**` joins the 80% coverage gate**, alongside the existing `feedback/**` and `metrics/**` entries.
- **Do not touch the README's Tests section.** Its test count was already corrected to 413 by the Railway branch this one is stacked on. The modes spec §12 listed that correction as pending; it is done, and redoing it is a defect.

## Spec corrections this plan makes

The spec's §7 failure table says `--mode=hybrid` with no API key yields `effective: "web"`. **That is wrong.** With no key but a reachable Kokoro the real pair is `(mock, kokoro)`, which matches no preset, so the effective mode is `custom`. The adjacent row — both slots degraded yields `web` — is correct, because that pair really is `(mock, browser)`.

The rule is mechanical and stated once, in Task 1: the effective mode is the preset name matching `(actual brain, effective tts)`, or `custom`. Nothing is special-cased. Task 4 corrects the spec's table.

---

### Task 1: The mode resolver

**Files:**
- Create: `server/src/config/mode.js`
- Modify: `server/vitest.config.js` (add `src/config/**/*.js` to the coverage `include` array)
- Test: `server/test/mode.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveMode(): "auto" | "web" | "cloud" | "hybrid"` — memoized, logs once
  - `slotDefault(slot: "brain" | "tts"): string | null` — the mode's default, `null` under `auto`
  - `noteTTSOutcome(ok: boolean): void`
  - `modeStatus({ brain, tts }): { requested, effective, degraded, reasons }`
  - `__resetForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `server/test/mode.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveMode, slotDefault, noteTTSOutcome, modeStatus, __resetForTests } from "../src/config/mode.js";

/**
 * resolveMode reads process.argv and process.env, both of which are global.
 * Snapshot and restore them around every test so ordering never matters.
 */
let argv;
let env;

beforeEach(() => {
  argv = process.argv;
  env = { ...process.env };
  process.argv = ["node", "src/index.js"];
  delete process.env.SPEAKUP_MODE;
  __resetForTests();
});

afterEach(() => {
  process.argv = argv;
  process.env = env;
  __resetForTests();
});

describe("resolveMode", () => {
  it("defaults to auto when nothing is set", () => {
    expect(resolveMode()).toBe("auto");
  });

  it("reads --mode= from argv", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(resolveMode()).toBe("hybrid");
  });

  it("reads SPEAKUP_MODE when there is no flag", () => {
    process.env.SPEAKUP_MODE = "cloud";
    expect(resolveMode()).toBe("cloud");
  });

  it("lets the flag win over the env var", () => {
    process.env.SPEAKUP_MODE = "cloud";
    process.argv = ["node", "src/index.js", "--mode=web"];
    expect(resolveMode()).toBe("web");
  });

  it("ignores the bare --mode form rather than consuming the next argument", () => {
    process.argv = ["node", "src/index.js", "--mode", "hybrid"];
    expect(resolveMode()).toBe("auto");
  });

  it("falls back to auto on an unknown mode without throwing", () => {
    process.argv = ["node", "src/index.js", "--mode=banana"];
    expect(() => resolveMode()).not.toThrow();
    expect(resolveMode()).toBe("auto");
  });

  it("is case- and whitespace-insensitive", () => {
    process.argv = ["node", "src/index.js", "--mode=  HYBRID  "];
    expect(resolveMode()).toBe("hybrid");
  });
});

describe("slotDefault", () => {
  it("returns null for both slots under auto, so the legacy chain decides", () => {
    expect(slotDefault("brain")).toBeNull();
    expect(slotDefault("tts")).toBeNull();
  });

  it("maps web to mock + browser", () => {
    process.argv = ["node", "src/index.js", "--mode=web"];
    expect(slotDefault("brain")).toBe("mock");
    expect(slotDefault("tts")).toBe("browser");
  });

  it("maps cloud to mistral + browser", () => {
    process.argv = ["node", "src/index.js", "--mode=cloud"];
    expect(slotDefault("brain")).toBe("mistral");
    expect(slotDefault("tts")).toBe("browser");
  });

  it("maps hybrid to mistral + kokoro", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(slotDefault("brain")).toBe("mistral");
    expect(slotDefault("tts")).toBe("kokoro");
  });

  it("returns null for a slot no mode controls", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(slotDefault("stt")).toBeNull();
  });
});

describe("modeStatus — effective name", () => {
  it("names the pair when it matches a preset", () => {
    expect(modeStatus({ brain: "mistral", tts: "kokoro" }).effective).toBe("hybrid");
    expect(modeStatus({ brain: "mistral", tts: "browser" }).effective).toBe("cloud");
    expect(modeStatus({ brain: "mock", tts: "browser" }).effective).toBe("web");
  });

  it("says custom when the pair matches no preset", () => {
    expect(modeStatus({ brain: "mock", tts: "kokoro" }).effective).toBe("custom");
  });

  it("never names the pair auto", () => {
    expect(modeStatus({ brain: "mistral", tts: "kokoro" }).effective).not.toBe("auto");
  });
});

describe("modeStatus — degradation", () => {
  it("is not degraded when the requested mode got what it asked for", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s).toMatchObject({ requested: "hybrid", effective: "hybrid", degraded: false, reasons: [] });
  });

  it("reports a missing key when a mistral mode resolved to mock", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    const s = modeStatus({ brain: "mock", tts: "kokoro" });
    expect(s.reasons).toEqual(["missing-mistral-key"]);
    expect(s.degraded).toBe(true);
    // The real pair is mock+kokoro, which is no preset — see the plan's
    // "Spec corrections" section.
    expect(s.effective).toBe("custom");
  });

  it("does not call a deliberate override degraded", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    const s = modeStatus({ brain: "mistral", tts: "browser" });
    expect(s).toMatchObject({ effective: "cloud", degraded: false, reasons: [] });
  });

  it("treats an unattempted TTS as fine, not as broken", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(modeStatus({ brain: "mistral", tts: "kokoro" }).degraded).toBe(false);
  });

  it("reports an unreachable TTS after a failed turn, and reads as cloud", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s.reasons).toEqual(["tts-unreachable"]);
    expect(s.degraded).toBe(true);
    expect(s.effective).toBe("cloud");
  });

  it("clears the reason on the next successful synthesis", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    noteTTSOutcome(true);
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s.degraded).toBe(false);
    expect(s.effective).toBe("hybrid");
  });

  it("ignores reachability when the configured voice is the browser", () => {
    process.argv = ["node", "src/index.js", "--mode=cloud"];
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mistral", tts: "browser" });
    expect(s.degraded).toBe(false);
    expect(s.effective).toBe("cloud");
  });

  it("applies reachability to voicebox too, not only kokoro", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    expect(modeStatus({ brain: "mistral", tts: "voicebox" }).reasons).toEqual(["tts-unreachable"]);
  });

  it("carries both reasons at once, and reads as web", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mock", tts: "kokoro" });
    expect(s.reasons).toEqual(["missing-mistral-key", "tts-unreachable"]);
    expect(s.effective).toBe("web");
  });

  it("never degrades under auto, which asked for nothing", () => {
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mock", tts: "kokoro" });
    expect(s.requested).toBe("auto");
    expect(s.degraded).toBe(false);
    expect(s.reasons).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- mode
```

Expected: FAIL — `Failed to resolve import "../src/config/mode.js"`.

- [ ] **Step 3: Write the implementation**

Create `server/src/config/mode.js`:

```js
/**
 * The preset table is the single definition of what a mode means. A mode
 * controls exactly two slots (spec D1); `auto` controls neither, which is
 * what makes it identical to the pre-modes resolution (spec D2).
 */
const MODES = {
  auto: {},
  web: { brain: "mock", tts: "browser" },
  cloud: { brain: "mistral", tts: "browser" },
  hybrid: { brain: "mistral", tts: "kokoro" },
};

const SERVER_SIDE_TTS = ["kokoro", "voicebox"];

let _mode = null;

/**
 * The only mutable state in this module. null means "no turn has tried to
 * synthesize yet" and never counts as degraded (spec D6) — which is what
 * lets a Kokoro started mid-session recover on the next successful turn.
 */
let _ttsReachable = null;

function parseMode() {
  const flag = process.argv.find((arg) => arg.startsWith("--mode="));
  const raw = (flag ? flag.slice("--mode=".length) : process.env.SPEAKUP_MODE ?? "").trim().toLowerCase();

  if (!raw) return "auto";
  if (!Object.hasOwn(MODES, raw)) {
    console.warn(`[mode] unknown mode "${raw}" → falling back to auto.`);
    return "auto";
  }
  return raw;
}

export function resolveMode() {
  if (_mode) return _mode;
  _mode = parseMode();
  console.log(`[mode] requested = ${_mode}`);
  return _mode;
}

/** The requested mode's default for one slot, or null to defer to the legacy chain. */
export function slotDefault(slot) {
  return MODES[resolveMode()][slot] ?? null;
}

/** Called by the turn route on both the success and the failure branch. Never throws. */
export function noteTTSOutcome(ok) {
  _ttsReachable = !!ok;
}

function nameFor(brain, tts) {
  for (const [name, slots] of Object.entries(MODES)) {
    if (name === "auto") continue;
    if (slots.brain === brain && slots.tts === tts) return name;
  }
  return "custom";
}

/**
 * Takes the providers as arguments rather than importing the factories: they
 * import this module for their defaults, so importing them back would close a
 * cycle. app.js already holds both and is the caller.
 */
export function modeStatus({ brain, tts }) {
  const requested = resolveMode();
  const wanted = MODES[requested];
  const reasons = [];

  if (wanted.brain === "mistral" && brain !== "mistral") reasons.push("missing-mistral-key");

  const ttsUnreachable = SERVER_SIDE_TTS.includes(tts) && _ttsReachable === false;
  if (ttsUnreachable) reasons.push("tts-unreachable");

  // What the learner actually gets: an unreachable server voice means the
  // client is speaking, so the effective voice is the browser's.
  const effectiveTts = ttsUnreachable ? "browser" : tts;

  return {
    requested,
    effective: nameFor(brain, effectiveTts),
    degraded: reasons.length > 0,
    reasons,
  };
}

export function __resetForTests() {
  _mode = null;
  _ttsReachable = null;
}
```

Note the `auto` case falls out for free: `MODES.auto` has no `brain` key, so the `missing-mistral-key` condition is never true under `auto`. A mode that asked for nothing cannot be disappointed.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --prefix server test -- mode
```

Expected: PASS, all cases.

- [ ] **Step 5: Add the new directory to the coverage gate**

In `server/vitest.config.js`, add `"src/config/**/*.js"` to the `coverage.include` array, keeping the existing entries:

```js
      include: ["src/feedback/**/*.js", "src/metrics/**/*.js", "src/coach/**/*.js", "src/ledger/**/*.js", "src/config/**/*.js"],
```

- [ ] **Step 6: Verify the gate passes at 80% on the new file**

```bash
npm --prefix server run test:coverage
```

Expected: PASS, with `src/config/mode.js` at or above 80% on lines, functions, branches and statements.

- [ ] **Step 7: Commit**

```bash
git add server/src/config/mode.js server/test/mode.test.js server/vitest.config.js
git commit -m "feat(server): the provider mode resolver"
```

---

### Task 2: Wire the server to the resolver

**Files:**
- Modify: `server/src/brain/index.js` (the `resolveProvider` chain)
- Modify: `server/src/tts/index.js` (the `resolveProvider` chain)
- Modify: `server/src/routes/turn.js` (the `runTurn` TTS try/catch)
- Modify: `server/src/app.js` (the `/health` handler)
- Modify: `server/src/index.js` (the boot log line)
- Test: `server/test/health.test.js` (extend), `server/test/mode-wiring.test.js` (create)

**Interfaces:**
- Consumes: `slotDefault`, `noteTTSOutcome`, `modeStatus`, `__resetForTests` from `server/src/config/mode.js` (Task 1).
- Produces: `/health` responses carrying a `mode` object.

- [ ] **Step 1: Write the failing tests**

Create `server/test/mode-wiring.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("GET /health — mode", () => {
  it("publishes the mode block alongside the existing slots", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode).toMatchObject({
      requested: expect.any(String),
      effective: expect.any(String),
      degraded: expect.any(Boolean),
    });
    expect(Array.isArray(body.mode.reasons)).toBe(true);
  });

  it("reports auto under the test run, which sets no mode", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.requested).toBe("auto");
  });

  it("is not degraded under auto, whatever the providers resolved to", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.degraded).toBe(false);
    expect(body.mode.reasons).toEqual([]);
  });

  it("leaves every pre-existing health field intact", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    for (const key of ["status", "brain", "tts", "stt", "pron", "feedback", "sources", "ts"]) {
      expect(body).toHaveProperty(key);
    }
  });
});
```

Then add this block to the end of `server/test/health.test.js`, so the pre-existing suite also pins the addition:

```js
describe("GET /health — the mode block does not disturb the slots", () => {
  it("still reports brain and tts as plain strings", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(typeof body.brain).toBe("string");
    expect(typeof body.tts).toBe("string");
    expect(body.mode.effective).not.toBe(undefined);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm --prefix server test -- mode-wiring
```

Expected: FAIL — `expected undefined to match object` on `body.mode`.

- [ ] **Step 3: Wire the brain factory**

In `server/src/brain/index.js`, add the import:

```js
import { slotDefault } from "../config/mode.js";
```

and change the one line inside `resolveProvider` that builds `provider`, leaving the missing-key guard below it untouched:

```js
  let provider = explicit || slotDefault("brain") || (hasMistralKey ? "mistral" : "mock");
```

- [ ] **Step 4: Wire the TTS factory**

In `server/src/tts/index.js`, add the import:

```js
import { slotDefault } from "../config/mode.js";
```

and change `resolveProvider`:

```js
function resolveProvider() {
  return process.env.TTS_PROVIDER?.trim().toLowerCase() || slotDefault("tts") || "kokoro";
}
```

- [ ] **Step 5: Record the real TTS outcome**

In `server/src/routes/turn.js`, add the import:

```js
import { noteTTSOutcome } from "../config/mode.js";
```

and add one call to each branch of the existing try/catch inside `runTurn`:

```js
    try {
      const out = await tts.synthesize(result.coach_reply);
      audio = out.audio.toString("base64");
      audioFormat = out.format;
      noteTTSOutcome(true);
    } catch (ttsErr) {
      console.warn("[turn] TTS failed → client will use browser voice:", ttsErr.message);
      noteTTSOutcome(false);
    }
```

Keep the existing `synthesize` call exactly as it is — the line above is illustrative of placement, not a replacement for whatever arguments the current code passes. Read the file and add only the two `noteTTSOutcome` lines.

- [ ] **Step 6: Publish the mode from /health**

In `server/src/app.js`, add the import beside the other provider imports:

```js
import { modeStatus } from "./config/mode.js";
```

and restructure the `/health` handler so the two providers are named once and reused:

```js
app.get("/health", async (_req, res) => {
  const feedUrls = configuredFeeds();
  // Configuration and cache state, never reachability (spec §8) — no DB hit
  // at all when there's nothing configured to report on.
  const { cached, unused } = feedUrls.length > 0 ? await topicStats() : { cached: 0, unused: 0 };
  const brain = currentProvider();
  const tts = currentTTSProvider();
  res.json({
    status: "ok",
    brain,
    tts,
    stt: currentSTTProvider(),
    pron: currentPronProvider(),
    feedback: harperStatus(),
    mode: modeStatus({ brain, tts }),
    sources: { provider: feedUrls.length > 0 ? "feeds" : "local", feeds: feedUrls.length, cached, unused },
    ts: Date.now(),
  });
});
```

- [ ] **Step 7: Add the mode to the boot log**

In `server/src/index.js`, add the import:

```js
import { resolveMode } from "./config/mode.js";
```

and extend the existing `app.listen` log line so it names the mode first:

```js
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (mode: ${resolveMode()}, brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()}, pron: ${currentPronProvider()})`,
  );
```

- [ ] **Step 8: Run the full server suite**

```bash
npm --prefix server test
```

Expected: PASS, including every pre-existing test. If any pre-existing test changed behavior, that is a regression against spec D2 — report it rather than adjusting the test.

- [ ] **Step 9: Commit**

```bash
git add server/src/brain/index.js server/src/tts/index.js server/src/routes/turn.js server/src/app.js server/src/index.js server/test/mode-wiring.test.js server/test/health.test.js
git commit -m "feat(server): resolve providers through the mode, and publish it"
```

---

### Task 3: The client's mode pill

**Files:**
- Modify: `client/src/hooks/useConversation.js` (the mount effect's `setProviders`, and the turn path)
- Modify: `client/src/components/StatHeader.jsx` (a new pill)
- Modify: `client/src/lib/api.js` (the `getHealth` return comment only)
- Test: `client/src/components/StatHeader.test.jsx` (extend), `client/src/components/__a11y__.test.jsx` (extend), `client/src/hooks/useConversation.test.js` (extend)

**Interfaces:**
- Consumes: the `mode` object from `GET /health` (Task 2): `{ requested, effective, degraded, reasons }`.
- Produces: a `mode` prop on `StatHeader`, and a `providers.mode` value from `useConversation`.

- [ ] **Step 1: Write the failing StatHeader tests**

Add to `client/src/components/StatHeader.test.jsx`:

```js
describe("the mode pill", () => {
  it("renders nothing when the server did not report a mode", () => {
    render(<StatHeader totalXp={0} turns={0} />);
    expect(screen.queryByTitle(/^mode /)).toBeNull();
  });

  it("names the effective mode", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "hybrid", degraded: false, reasons: [] }} />);
    expect(screen.getByLabelText("mode hybrid")).toBeInTheDocument();
  });

  it("names the requested mode too when they differ by choice", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "cloud", degraded: false, reasons: [] }} />);
    expect(screen.getByLabelText("mode cloud, requested hybrid")).toBeInTheDocument();
  });

  it("puts the degradation reason in the accessible name, not only in colour", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "cloud", degraded: true, reasons: ["tts-unreachable"] }} />);
    expect(screen.getByLabelText("mode cloud, requested hybrid, degraded: TTS unreachable")).toBeInTheDocument();
  });

  it("spells out both reasons when both hold", () => {
    render(
      <StatHeader
        totalXp={0}
        turns={0}
        mode={{ requested: "hybrid", effective: "web", degraded: true, reasons: ["missing-mistral-key", "tts-unreachable"] }}
      />,
    );
    expect(screen.getByLabelText("mode web, requested hybrid, degraded: no Mistral API key, TTS unreachable")).toBeInTheDocument();
  });

  it("renders an unrecognised reason verbatim rather than dropping it", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "custom", degraded: true, reasons: ["something-new"] }} />);
    expect(screen.getByLabelText("mode custom, requested hybrid, degraded: something-new")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm --prefix client test -- StatHeader
```

Expected: FAIL — `Unable to find a label with the text of: mode hybrid`.

- [ ] **Step 3: Implement the pill**

In `client/src/components/StatHeader.jsx`, add `mode` to the destructured props, and add this helper above the component:

```js
const REASON_TEXT = {
  "missing-mistral-key": "no Mistral API key",
  "tts-unreachable": "TTS unreachable",
};

/**
 * The whole story in one string, because it is also the accessible name:
 * colour alone must never be the thing that says "degraded".
 */
function modeLabel(mode) {
  let label = `mode ${mode.effective}`;
  if (mode.requested !== mode.effective) label += `, requested ${mode.requested}`;
  if (mode.degraded && mode.reasons.length > 0) {
    label += `, degraded: ${mode.reasons.map((r) => REASON_TEXT[r] ?? r).join(", ")}`;
  }
  return label;
}
```

Then render the pill as the first child of the `<div className="flex flex-col items-end gap-1">` that already holds the brain and tts pills:

```jsx
          {mode && (
            <span
              aria-label={modeLabel(mode)}
              title={modeLabel(mode)}
              className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border ${
                mode.degraded
                  ? "border-user/60 text-user"
                  : "border-coach/50 text-coach-soft"
              }`}
            >
              {mode.degraded ? `${mode.effective} !` : mode.effective}
            </span>
          )}
```

- [ ] **Step 4: Run the StatHeader tests to verify they pass**

```bash
npm --prefix client test -- StatHeader
```

Expected: PASS.

- [ ] **Step 5: Write the failing hook test**

Add to `client/src/hooks/useConversation.test.js`. The file already mocks `../lib/api.js` and `../lib/speech.js` at the top and imports `postTurn`, `getHealth` and `playAudio` from them — reuse those, do not add a second mock.

Two facts about this file that the tests below depend on:

- `submitText` is a no-op unless the status is `idle` (`useConversation.js:484`). After a turn, the status returns to `idle` only when the playback path calls its `onEnd`. The file's `speak` mock does (`speak: vi.fn((_t, o) => o?.onEnd?.())`), but its `playAudio` mock does not — so any test that needs a **second** turn *with audio present* must override `playAudio` to call `onEnd`, as the tests below do.
- That override must not leak into the rest of the file. Restore it in an `afterEach` inside this `describe`.

```js
describe("mode refresh", () => {
  const HYBRID = { requested: "hybrid", effective: "hybrid", degraded: false, reasons: [] };
  const healthWith = (mode, tts = "kokoro") => ({ brain: "mistral", tts, stt: "none", mode });

  // The module mock's playAudio never ends playback, which parks the status at
  // "speaking" and makes a second submitText a no-op. Tests that need two turns
  // with audio install this instead.
  const endsImmediately = (_audio, opts) => {
    opts?.onEnd?.();
    return { pause: vi.fn() };
  };

  afterEach(() => {
    playAudio.mockImplementation(() => ({ pause: vi.fn() }));
  });

  it("carries the mode from /health into providers", async () => {
    getHealth.mockResolvedValue(healthWith(HYBRID));
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.mode).toMatchObject({ effective: "hybrid" }));
  });

  it("re-fetches /health when a turn that expected audio did not get any", async () => {
    getHealth.mockResolvedValue(healthWith(HYBRID));
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, audio: null, ttsProvider: "kokoro" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));
    expect(getHealth).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.submitText("hello"); });
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));
  });

  it("does not re-fetch while the audio expectation keeps being met", async () => {
    getHealth.mockResolvedValue(healthWith(HYBRID));
    playAudio.mockImplementation(endsImmediately);
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, audio: "AAAA", audioFormat: "mp3", ttsProvider: "kokoro" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    await act(async () => { await result.current.submitText("first"); });
    await act(async () => { await result.current.submitText("second"); });
    expect(getHealth).toHaveBeenCalledTimes(1);
  });

  it("re-fetches again when audio comes back after a failure", async () => {
    getHealth.mockResolvedValue(healthWith(HYBRID));
    playAudio.mockImplementation(endsImmediately);
    postTurn
      .mockResolvedValueOnce({ coach_reply: "ok", xp: 5, audio: null, ttsProvider: "kokoro" })
      .mockResolvedValueOnce({ coach_reply: "ok", xp: 5, audio: "AAAA", audioFormat: "mp3", ttsProvider: "kokoro" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    await act(async () => { await result.current.submitText("first"); });
    await act(async () => { await result.current.submitText("second"); });
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(3));
  });

  it("never re-fetches when the server never intended to send audio", async () => {
    const cloud = { requested: "cloud", effective: "cloud", degraded: false, reasons: [] };
    getHealth.mockResolvedValue(healthWith(cloud, "browser"));
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, audio: null, ttsProvider: "browser" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("browser"));

    await act(async () => { await result.current.submitText("first"); });
    await act(async () => { await result.current.submitText("second"); });
    expect(getHealth).toHaveBeenCalledTimes(1);
  });
});
```

`afterEach` must be added to the file's `vitest` import if it is not already there. The behaviour being pinned is: a refresh happens exactly on a change of `expectedAudio && !gotAudio`, and never otherwise.

- [ ] **Step 6: Run them to verify they fail**

```bash
npm --prefix client test -- useConversation
```

Expected: FAIL — `getHealth` called once where two calls were expected.

- [ ] **Step 7: Implement the hook changes**

In `client/src/hooks/useConversation.js`:

1. Carry the mode through the mount effect's existing call:

```js
      if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt, mode: h.mode });
```

2. Add a ref beside the other refs in the hook:

```js
  // Tracks whether the last turn expected server audio and did not get it.
  // A refresh fires only when this flips, so a healthy session makes no extra
  // requests and a recovered TTS clears the pill on its own.
  const ttsFailedRef = useRef(false);
```

3. Add `ttsProvider` to the destructuring of the `postTurn` response, and after the message is appended, add:

```js
      const failed = ttsProvider !== "browser" && !audio;
      if (failed !== ttsFailedRef.current) {
        ttsFailedRef.current = failed;
        getHealth().then((h) => {
          if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt, mode: h.mode });
        });
      }
```

4. In `client/src/lib/api.js`, update the `getHealth` return comment to name the new field:

```js
    return res.json(); // { status, brain, tts, stt, pron, feedback, mode, sources, ts }
```

- [ ] **Step 8: Pass the prop through**

In `client/src/App.jsx`, pass `mode={providers.mode}` to `<StatHeader …>` alongside the `brain`, `tts` and `stt` props it already receives. Read the component's current prop list first and match its formatting.

- [ ] **Step 9: Add the accessibility assertion**

In `client/src/components/__a11y__.test.jsx`, extend the existing `StatHeader` case (or add one beside it, matching the file's style) so a degraded mode is rendered and asserted axe-clean:

```js
  it("StatHeader with a degraded mode has no axe violations", async () => {
    const { container } = render(
      <StatHeader totalXp={120} turns={4} mode={{ requested: "hybrid", effective: "cloud", degraded: true, reasons: ["tts-unreachable"] }} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
```

- [ ] **Step 10: Run the full client suite**

```bash
npm --prefix client test
```

Expected: PASS, including every pre-existing test.

- [ ] **Step 11: Commit**

```bash
git add client/src/hooks/useConversation.js client/src/components/StatHeader.jsx client/src/components/StatHeader.test.jsx client/src/components/__a11y__.test.jsx client/src/hooks/useConversation.test.js client/src/lib/api.js client/src/App.jsx
git commit -m "feat(client): render the active mode, and refresh it on the edge"
```

---

### Task 4: Scripts, documentation, and the spec correction

**Files:**
- Modify: `package.json` (root — three new scripts)
- Modify: `README.md` (a Modes subsection; the provider table gains a pointer)
- Modify: `server/.env.example` (a `SPEAKUP_MODE` note)
- Modify: `docs/superpowers/specs/2026-08-07-provider-modes-design.md` (correct the §7 row)
- Test: none — verified by running each script

**Interfaces:**
- Consumes: `--mode=<value>` parsing from Task 1; the `mode` block from Task 2.
- Produces: `npm run dev:web`, `dev:cloud`, `dev:hybrid`.

- [ ] **Step 1: Add the three scripts**

In the root `package.json`, insert these three immediately after the existing `dev:client` entry, leaving `dev`, `build` and `start` untouched:

```json
    "dev:web": "concurrently -k -n server,client -c magenta,cyan \"npm --prefix server run dev -- --mode=web\" \"npm --prefix client run dev\"",
    "dev:cloud": "concurrently -k -n server,client -c magenta,cyan \"npm --prefix server run dev -- --mode=cloud\" \"npm --prefix client run dev\"",
    "dev:hybrid": "concurrently -k -n server,client -c magenta,cyan \"npm --prefix server run dev -- --mode=hybrid\" \"npm --prefix client run dev\"",
```

Arguments after `--` are appended to the server's `dev` script, landing after `src/index.js`, which is where `resolveMode()` scans for them.

- [ ] **Step 2: Verify each script actually selects its mode**

`server/run dev` uses `--env-file=.env`, so `server/.env` must exist for these to start. If it does not, create it from the example first: `cp server/.env.example server/.env`.

Run each of the three in turn, read the boot log, then stop it:

```bash
npm run dev:hybrid
```

Expected in the server's output: `[mode] requested = hybrid`, then a boot line beginning `[server] SpeakUp API → http://localhost:3001  (mode: hybrid, brain: …`. Repeat for `dev:cloud` and `dev:web`, confirming the mode name changes each time and that `npm run dev` still reports `auto`. Capture all four boot lines for your report.

- [ ] **Step 3: Confirm the modes reach /health**

With `npm run dev:web` running, in another shell:

```bash
curl -s http://localhost:3001/health
```

Expected: `"mode":{"requested":"web","effective":"web","degraded":false,"reasons":[]}` and `"brain":"mock"`, `"tts":"browser"`. Stop the server afterwards.

- [ ] **Step 4: Document the modes in the README**

Insert a `### Modes` subsection immediately before the existing `### Turning on the good stuff` subsection:

````markdown
### Modes

The two configurations this project actually runs have names, and one command each:

```bash
npm run dev:hybrid
```

| | `web` | `cloud` | `hybrid` |
|---|---|---|---|
| brain | `mock` | Mistral | Mistral |
| coach voice | browser | browser | Kokoro, local |
| `upgrades` channel | off | on | on |
| needs | nothing | an API key | key + Docker on `:8880` |

A mode sets defaults for two slots and nothing else — `stt`, `pron` and the seed sources stay independent env vars, and **an explicit env var always beats the mode**, so an existing `.env` keeps meaning what it meant.

Plain `npm run dev` is mode `auto`: exactly the pre-modes behaviour, which is Mistral if a key is present and Kokoro for the voice.

`GET /health` reports the mode you asked for **and** the one you got, because they can differ. Ask for `hybrid` with no key and you get the mock brain; ask for it with Kokoro down and the coach speaks in the browser's voice from the first failed turn until one succeeds. The header pill shows the mode you are actually in, marked when it is not the one you requested.
````

Then, in the provider table further down (the one whose rows are **brain**, **tts**, **stt**, **pron**, **sources**, **`COACH_PROMPT`**), add this row at the top:

```markdown
| **mode** | `auto`, `web`, `cloud`, `hybrid` | `auto` | Sets the `brain` and `tts` defaults together — see [Modes](#modes). Select with `--mode=`, or `SPEAKUP_MODE`. Any explicit env var below still wins. |
```

- [ ] **Step 5: Document it in `server/.env.example`**

Insert at the top of the file, immediately after the existing first comment line:

```
# --- Mode ---
# Sets the brain and tts defaults together: web | cloud | hybrid.
# Unset (or `auto`) reproduces the pre-modes behaviour exactly. Every explicit
# variable below beats the mode. The npm scripts pass --mode= instead, which is
# what `npm run dev:hybrid` does.
# SPEAKUP_MODE=hybrid
```

- [ ] **Step 6: Correct the spec's §7 table**

In `docs/superpowers/specs/2026-08-07-provider-modes-design.md`, find the §7 row reading:

> | `--mode=hybrid`, no API key | Brain resolves `mock`; `effective: "web"`, `reasons: ["missing-mistral-key"]` |

Replace `effective: "web"` with `effective: "custom"`, and append to that cell: ` — the real pair is (mock, kokoro), which matches no preset`. Leave the "Both slots degraded" row alone; `web` is correct there because that pair really is `(mock, browser)`.

- [ ] **Step 7: Run the full suite**

```bash
npm test
```

Expected: PASS. No test in this task, but the docs and scripts must not have disturbed anything.

- [ ] **Step 8: Commit**

```bash
git add package.json README.md server/.env.example docs/superpowers/specs/2026-08-07-provider-modes-design.md
git commit -m "feat: one command per mode, documented, with the spec's failure table corrected"
```

---

## Self-review notes

**Spec coverage.** D1 → Task 1's `MODES` table and the `slotDefault("stt")` test. D2 → Task 1 Steps 1, 3 and Task 2 Step 8. D3 → Task 2 Steps 3-4. D4 → Task 1's `nameFor` and the effective-name tests. D5 → Task 1's "deliberate override" test. D6 → Task 1's null-flag and clearing tests, Task 2 Step 5. D7 → Task 3 Steps 5, 7. D8 → Task 1's unknown-mode test. Spec §4 preset table → Task 1 Step 3. §5 architecture → Tasks 1-2. §6 reasons → Task 1. §7 failure modes → Task 1's degradation suite, with the `custom` correction. §8 scripts → Task 4. §9 testing → Tasks 1-3. §10 deferred → resolved below.

**Deferred items resolved.** The spec's §12 left four open. Memoization ordering → `resolveMode()` memoizes on first call and the factories call it lazily, so the first `currentProvider()` fixes it; no ordering constraint remains. README placement → a `### Modes` subsection plus a table row, Task 4 Step 4. The stale test count → already corrected to 413 by the Railway branch; explicitly out of scope here. `.env.example` documenting `SPEAKUP_MODE` → yes, Task 4 Step 5.

**Known interaction with the Railway branch.** This branch is stacked on `claude/provider-modes`'s parent, the Railway deployment work. Task 4 edits the root `package.json` scripts block that the Railway branch also edited, and the README section that it rewrote — so both files must be read as they currently are, not as the spec described them. `app.js` now calls `mountClient(app)` after the routers; Task 2 Step 6 changes only the `/health` handler above that and must leave the mount alone.

**Test-count drift.** Task 1 adds roughly 25 server tests, Task 2 roughly 5, Task 3 roughly 10. The README's badge and Tests-section numbers will therefore be wrong again once this lands. They are deliberately not updated here, because the number cannot be known until the last task is green; correcting them is the first thing to do in whatever lands next, and it is called out in this plan's final review rather than fixed blind.
