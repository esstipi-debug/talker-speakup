# Pronunciation Server Slot Implementation Plan (M7 · plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose pronunciation scoring through the Express server as a pluggable provider slot, with a mock that works offline and a route that enforces the scripted/unscripted distinction.

**Architecture:** A `server/src/pron/` slot mirroring the existing `brain/`, `tts/` and `stt/` factories, with providers `mock` | `local` | `azure`. `server/src/app.js` is extracted to export `createApp()` so route contracts become testable (spec §12 A9). Adds Vitest to the server, which currently has no test runner.

**Tech Stack:** Node 22 ESM, Express 5, multer, Vitest, supertest, @vitest/coverage-v8.

## Global Constraints

Every task's requirements implicitly include this section. Values are exact.

- **Repo root (a git worktree):** `C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e`
- **Branch:** `claude/pronunciation-layer-bd7af6`. Never commit to `main`.
- **Design spec:** `docs/superpowers/specs/2026-07-27-pronunciation-layer-design.md`. Read §12 (amendments) before §4 — nine approved decisions were corrected after verification.
- **Shell:** PowerShell 7. `timeout`, `2>/dev/null`, and bash `[ -f x ]` do not exist.
- **Runtime model:** `facebook/wav2vec2-lv-60-espeak-cv-ft` (392-token espeak IPA vocab, Apache-2.0). Never `mrrubino/*` (40 tokens, no `ə`/`iː`/`dʒ`), never `slplab/*` (ARPAbet, no licence), never `torchaudio.pipelines.MMS_FA` (character-level, CC-BY-NC).
- **Provider default:** `PRON_PROVIDER` unset → `mock`. `npm run dev` must work with no Docker running.
- **Ports:** server `3001`, sidecar `8899`, Kokoro TTS `8880`.
- **JS style:** ESM, double quotes, semicolons, 2-space indent, explicit `.js`/`.jsx` on every relative import. No TypeScript, no PropTypes. Hooks are named exports; components are default exports. There is no lint or format config — style is convention only.
- **Test placement:** test files sit *beside* their source (`foo.js` + `foo.test.js`).
- **Coverage floor:** 80% on every new server module.
- **`client/src/hooks/useConversation.js` is untouchable.** No task in any of the four plans may modify it or its test. Plan 3's final task proves this with `git diff`.
- **Nothing writes to the database.** Persistence is M3's single decision; pronunciation results live in client state only.
- **Azure is never a runtime path.** The adapter exists for `tools/calibration/` and requires an explicit key.
- **In unscripted mode `words[].phones` is stripped server-side** before the response is written. A test must fail if phones ever leak.
- **`substituted` is ABSENT, not null,** when a phoneme was produced as expected.
- **Commits stage explicit paths.** `git add -A` and `git add .` are forbidden. Verify the *staged* blob with `git show :<path>` before every commit — this repo has shipped a commit importing an untracked file (spec §11).

### Outstanding verification debt

The four adversarial critic passes (placeholders, interface drift, spec coverage, TDD quality) **did not run** — the API returned `529 Overloaded` twice. These plans carry a mechanical placeholder scan and an author self-review only. Treat the first task of each plan with extra scepticism, and re-run the adversarial pass when capacity allows.

---

## Chunk 2 — The server (Node/Express)

Everything below happens in the worktree `C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e`.
Run every command from the **repo root** unless a step says otherwise. The shell is PowerShell 7.

Read before starting:
- The repo has **no lint and no format config**. Style is convention only: double quotes, semicolons,
  2-space indent, trailing commas in multiline literals, ESM, explicit `.js` on every relative import.
- The repo has **no dotenv**. `server/.env` is loaded by `node --env-file` in the `dev`/`start` scripts
  only. Vitest will **not** see it. Every server test sets `process.env.*` itself.
- This repo has shipped a commit importing an untracked file. Every commit step below stages
  **explicit paths** and verifies the **staged** blob with `git show :<path>` before committing.

---

### Task 1: Stand up Vitest on the server and land the first contract constants

The server has no test runner at all. This task adds one, mirroring the client's setup exactly, and
proves it works with a real behavioral test of `clampScore`.

**Files:**
- Create: `server/vitest.config.js`
- Create: `server/src/pron/contract.js`
- Modify: `server/package.json`
- Modify: `package.json` (repo root)
- Test: `server/src/pron/contract.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const PRON_MODES` — `Object.freeze(["scripted", "unscripted"])`
  - `export const DEFAULT_MODE` — `"scripted"`
  - `export const MAX_TEXT_LENGTH` — `300`
  - `export const MAX_AUDIO_BYTES` — `15 * 1024 * 1024`
  - `export const REPORT_VERSION` — `1`
  - `export const PRON_ERROR_CODES` — frozen `Record<string,string>`
  - `export function clampScore(value: number): number`

#### Step 1.1 — Install the runner

```powershell
npm --prefix server install -D vitest@^4.1.10 "@vitest/coverage-v8@^4.1.10" supertest@^7.1.4
```

`supertest` is installed now (rather than in the route task) so `server/package-lock.json` is
touched exactly once in this milestone.

#### Step 1.2 — Write the failing test

Create `server/src/pron/contract.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  PRON_MODES,
  DEFAULT_MODE,
  MAX_TEXT_LENGTH,
  MAX_AUDIO_BYTES,
  REPORT_VERSION,
  PRON_ERROR_CODES,
  clampScore,
} from "./contract.js";

describe("contract — constants", () => {
  it("freezes the mode enum so a caller cannot widen it at runtime", () => {
    expect(PRON_MODES).toEqual(["scripted", "unscripted"]);
    expect(Object.isFrozen(PRON_MODES)).toBe(true);
    expect(() => PRON_MODES.push("freestyle")).toThrow();
  });

  it("defaults to scripted and caps text at 300 chars / audio at 15 MB", () => {
    expect(DEFAULT_MODE).toBe("scripted");
    expect(PRON_MODES).toContain(DEFAULT_MODE);
    expect(MAX_TEXT_LENGTH).toBe(300);
    expect(MAX_AUDIO_BYTES).toBe(15728640);
    expect(REPORT_VERSION).toBe(1);
  });

  it("exposes every error code the routes and providers throw, keyed by itself", () => {
    for (const [key, value] of Object.entries(PRON_ERROR_CODES)) {
      expect(value).toBe(key);
    }
    expect(Object.keys(PRON_ERROR_CODES)).toEqual([
      "MISSING_AUDIO",
      "MISSING_TEXT",
      "TEXT_TOO_LONG",
      "INVALID_MODE",
      "AUDIO_TOO_LARGE",
      "UNKNOWN_FOCUS",
      "NO_SPEECH",
      "DECODE_FAILED",
      "UNPRONOUNCEABLE_TEXT",
      "PRON_UNAVAILABLE",
      "BAD_REPORT",
    ]);
  });
});

describe("contract — clampScore", () => {
  it("rounds to an integer inside 0-100", () => {
    expect(clampScore(41.4)).toBe(41);
    expect(clampScore(41.5)).toBe(42);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(100)).toBe(100);
  });

  it("clamps out-of-range values instead of propagating them into the report", () => {
    expect(clampScore(-12)).toBe(0);
    expect(clampScore(1000)).toBe(100);
  });

  it("maps non-finite input to 0 rather than emitting NaN into JSON", () => {
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(0);
    expect(clampScore(-Infinity)).toBe(0);
    expect(clampScore(undefined)).toBe(0);
  });
});
```

#### Step 1.3 — See it fail

```powershell
npm --prefix server test
```

Expected: `npm error Missing script: "test"` — the server `package.json` has no `test` script yet.

#### Step 1.4 — Add the config and the scripts

Create `server/vitest.config.js`:

```js
import { defineConfig } from "vitest/config";

// Server-side Vitest — same runner and idiom as the client (design §8), node
// environment, no jsdom. `node --env-file` does not apply here, so tests set
// process.env explicitly.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      include: [
        "src/pron/index.js",
        "src/pron/contract.js",
        "src/pron/mock.js",
        "src/pron/local.js",
        "src/pron/prompts.js",
        "src/routes/pron.js",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
```

In `server/package.json`, replace the `"scripts"` block with:

```json
  "scripts": {
    "dev": "node --env-file=.env --watch src/index.js",
    "start": "node --env-file=.env src/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:studio": "prisma studio"
  },
```

In the root `package.json`, add three scripts after `"dev:client"`:

```json
    "test": "npm run test:server && npm run test:client",
    "test:server": "npm --prefix server test",
    "test:client": "npm --prefix client test",
```

#### Step 1.5 — See it fail for the right reason

```powershell
npm --prefix server test
```

Expected: vitest starts and reports
`Error: Failed to load url ./contract.js` … `Does the file exist?` for
`src/pron/contract.test.js`.

#### Step 1.6 — Implement

Create `server/src/pron/contract.js`:

```js
/**
 * Pronunciation-assessment wire contract (design §4.3). Single owner of the
 * report shape, the input rules, and every typed error code shared by the
 * pron/ providers and the /pron routes.
 *
 * The canonical schema — reproduced verbatim so the shape lives next to the
 * validator that enforces it:
 *
 * {
 *   "$schema": "https://json-schema.org/draft/2020-12/schema",
 *   "$id": "https://speakup.local/schemas/pronunciation-report-v1.json",
 *   "title": "PronunciationReport",
 *   "type": "object",
 *   "additionalProperties": false,
 *   "required": ["version", "mode", "model", "overall", "prosody", "words"],
 *   "properties": {
 *     "version":      { "type": "integer", "const": 1 },
 *     "mode":         { "type": "string", "enum": ["scripted", "unscripted"] },
 *     "pronProvider": { "type": "string", "enum": ["local", "mock", "azure"] },
 *     "model":        { "type": "string", "minLength": 1 },
 *     "durationSec":  { "type": "number", "minimum": 0 },
 *     "sampleRate":   { "type": "integer", "const": 16000 },
 *     "overall": {
 *       "type": "object",
 *       "additionalProperties": false,
 *       "required": ["accuracy", "fluency", "completeness"],
 *       "properties": {
 *         "accuracy":     { "type": "integer", "minimum": 0, "maximum": 100 },
 *         "fluency":      { "type": "integer", "minimum": 0, "maximum": 100 },
 *         "completeness": { "type": "integer", "minimum": 0, "maximum": 100 }
 *       }
 *     },
 *     "prosody": {
 *       "type": "object",
 *       "additionalProperties": false,
 *       "required": [
 *         "speechRateWpm", "articulationRateSyllPerSec",
 *         "pauseCount", "pauseTotalSec",
 *         "f0MinHz", "f0MaxHz", "f0RangeSemitones"
 *       ],
 *       "properties": {
 *         "speechRateWpm":              { "type": "number", "minimum": 0 },
 *         "articulationRateSyllPerSec": { "type": "number", "minimum": 0 },
 *         "pauseCount":                 { "type": "integer", "minimum": 0 },
 *         "pauseTotalSec":              { "type": "number", "minimum": 0 },
 *         "f0MinHz":                    { "type": ["number", "null"], "minimum": 0 },
 *         "f0MaxHz":                    { "type": ["number", "null"], "minimum": 0 },
 *         "f0RangeSemitones":           { "type": ["number", "null"], "minimum": 0 }
 *       }
 *     },
 *     "words": {
 *       "type": "array",
 *       "minItems": 1,
 *       "items": {
 *         "type": "object",
 *         "additionalProperties": false,
 *         "required": ["word", "start", "end", "accuracy"],
 *         "properties": {
 *           "word":     { "type": "string", "minLength": 1 },
 *           "start":    { "type": "number", "minimum": 0 },
 *           "end":      { "type": "number", "minimum": 0 },
 *           "accuracy": { "type": "integer", "minimum": 0, "maximum": 100 },
 *           "phones": {
 *             "type": "array",
 *             "minItems": 1,
 *             "items": {
 *               "type": "object",
 *               "additionalProperties": false,
 *               "required": ["ipa", "score", "start", "end"],
 *               "properties": {
 *                 "ipa":         { "type": "string", "minLength": 1 },
 *                 "score":       { "type": "integer", "minimum": 0, "maximum": 100 },
 *                 "start":       { "type": "number", "minimum": 0 },
 *                 "end":         { "type": "number", "minimum": 0 },
 *                 "substituted": { "type": "string", "minLength": 1 }
 *               }
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * Invariant the schema cannot express: `substituted` is ABSENT — never null,
 * never "" — whenever the phoneme was produced as expected.
 */

/**
 * @typedef {object} PronPhone
 * @property {string} ipa
 * @property {number} score          integer 0-100
 * @property {number} start          seconds
 * @property {number} end            seconds
 * @property {string} [substituted]  ABSENT when the phone was produced as expected — never null
 */

/**
 * @typedef {object} PronWord
 * @property {string} word
 * @property {number} start
 * @property {number} end
 * @property {number} accuracy       integer 0-100
 * @property {PronPhone[]} [phones]  absent in mode "unscripted"
 */

/**
 * @typedef {object} PronOverall
 * @property {number} accuracy
 * @property {number} fluency
 * @property {number} completeness
 */

/**
 * @typedef {object} PronProsody
 * @property {number} speechRateWpm
 * @property {number} articulationRateSyllPerSec
 * @property {number} pauseCount
 * @property {number} pauseTotalSec
 * @property {number|null} f0MinHz
 * @property {number|null} f0MaxHz
 * @property {number|null} f0RangeSemitones
 */

/**
 * @typedef {object} PronunciationReport
 * @property {number} version                 always 1
 * @property {"scripted"|"unscripted"} mode
 * @property {"local"|"mock"|"azure"} [pronProvider]
 * @property {string} model
 * @property {number} [durationSec]
 * @property {number} [sampleRate]
 * @property {PronOverall} overall
 * @property {PronProsody} prosody
 * @property {PronWord[]} words
 */

export const PRON_MODES = Object.freeze(["scripted", "unscripted"]);
export const DEFAULT_MODE = "scripted";
export const MAX_TEXT_LENGTH = 300;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const REPORT_VERSION = 1;

export const PRON_ERROR_CODES = Object.freeze({
  MISSING_AUDIO: "MISSING_AUDIO",
  MISSING_TEXT: "MISSING_TEXT",
  TEXT_TOO_LONG: "TEXT_TOO_LONG",
  INVALID_MODE: "INVALID_MODE",
  AUDIO_TOO_LARGE: "AUDIO_TOO_LARGE",
  UNKNOWN_FOCUS: "UNKNOWN_FOCUS",
  NO_SPEECH: "NO_SPEECH",
  DECODE_FAILED: "DECODE_FAILED",
  UNPRONOUNCEABLE_TEXT: "UNPRONOUNCEABLE_TEXT",
  PRON_UNAVAILABLE: "PRON_UNAVAILABLE",
  BAD_REPORT: "BAD_REPORT",
});

/**
 * @param {number} value
 * @returns {number} integer in [0,100]; NaN / non-finite becomes 0
 */
export function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
```

#### Step 1.7 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

#### Step 1.8 — Commit

```powershell
git add server/package.json server/package-lock.json server/vitest.config.js server/src/pron/contract.js server/src/pron/contract.test.js package.json
git status --short
git show :server/package.json | Select-String '"test": "vitest run"'
git show :server/src/pron/contract.js | Select-String "export function clampScore"
git commit -m "test(server): add vitest runner and the pron contract constants"
```

`git status --short` must show no `A`/`M` entries beyond the six paths above. If it does, stop and
unstage the stray path — do not use `git add -A`.

---

### Task 2: `validateAssessInput` — reject bad requests before any provider is touched

**Files:**
- Modify: `server/src/pron/contract.js`
- Test: `server/src/pron/contract.test.js`

**Interfaces:**
- Consumes: `PRON_MODES`, `DEFAULT_MODE`, `MAX_TEXT_LENGTH`, `MAX_AUDIO_BYTES`, `PRON_ERROR_CODES`
- Produces: `export function validateAssessInput({ text, mode, audioBytes } = {}): { ok: true, value: { text: string, mode: "scripted"|"unscripted" } } | { ok: false, status: number, code: string, error: string }`

#### Step 2.1 — Write the failing test

Append to `server/src/pron/contract.test.js`, and add `validateAssessInput` to the import list at
the top of the file:

```js
describe("contract — validateAssessInput", () => {
  const ok = { text: "The ship is full of sheep.", audioBytes: 2048 };

  it("trims the text and defaults the mode to scripted", () => {
    expect(validateAssessInput({ ...ok, text: "  the ship  " })).toEqual({
      ok: true,
      value: { text: "the ship", mode: "scripted" },
    });
  });

  it("passes an explicit unscripted mode through", () => {
    expect(validateAssessInput({ ...ok, mode: "unscripted" })).toEqual({
      ok: true,
      value: { text: "The ship is full of sheep.", mode: "unscripted" },
    });
  });

  it("rejects a missing or zero-length audio part with 400 MISSING_AUDIO", () => {
    expect(validateAssessInput({ text: "hi" })).toEqual({
      ok: false,
      status: 400,
      code: "MISSING_AUDIO",
      error: 'Missing "audio" file.',
    });
    expect(validateAssessInput({ text: "hi", audioBytes: 0 }).code).toBe("MISSING_AUDIO");
    expect(validateAssessInput({ text: "hi", audioBytes: 1.5 }).code).toBe("MISSING_AUDIO");
  });

  it("checks the audio size before the text so a huge upload is not blamed on the sentence", () => {
    expect(validateAssessInput({ text: "", audioBytes: MAX_AUDIO_BYTES + 1 })).toEqual({
      ok: false,
      status: 413,
      code: "AUDIO_TOO_LARGE",
      error: "That recording is too large. Keep drill takes under 15 MB.",
    });
  });

  it("rejects blank or non-string text with 400 MISSING_TEXT", () => {
    expect(validateAssessInput({ ...ok, text: "   " })).toEqual({
      ok: false,
      status: 400,
      code: "MISSING_TEXT",
      error: 'Missing "text" (the reference sentence, non-empty string).',
    });
    expect(validateAssessInput({ ...ok, text: 42 }).code).toBe("MISSING_TEXT");
    expect(validateAssessInput({ ...ok, text: undefined }).code).toBe("MISSING_TEXT");
  });

  it("measures the text length after trimming", () => {
    const exactly300 = "a".repeat(300);
    expect(validateAssessInput({ ...ok, text: `  ${exactly300}  ` }).ok).toBe(true);
    expect(validateAssessInput({ ...ok, text: "a".repeat(301) })).toEqual({
      ok: false,
      status: 400,
      code: "TEXT_TOO_LONG",
      error: "That reference sentence is too long. Keep it under 300 characters.",
    });
  });

  it("rejects an unknown mode but tolerates an omitted one", () => {
    expect(validateAssessInput({ ...ok, mode: "freestyle" })).toEqual({
      ok: false,
      status: 400,
      code: "INVALID_MODE",
      error: '"mode" must be "scripted" or "unscripted".',
    });
    expect(validateAssessInput({ ...ok, mode: undefined }).value.mode).toBe("scripted");
  });

  it("does not throw when called with no argument at all", () => {
    expect(validateAssessInput().code).toBe("MISSING_AUDIO");
  });
});
```

#### Step 2.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `TypeError: validateAssessInput is not a function` on the first case in the new describe.

#### Step 2.3 — Implement

Append to `server/src/pron/contract.js`:

```js
/**
 * Validates a POST /pron/assess request body. Order matters: audio presence,
 * then audio size, then text, then mode — so a 15 MB upload with a blank
 * sentence is reported as the size problem it actually is.
 *
 * @param {{ text?: unknown, mode?: unknown, audioBytes?: unknown }} [input]
 * @returns {{ ok: true, value: { text: string, mode: "scripted"|"unscripted" } }
 *          | { ok: false, status: number, code: string, error: string }}
 */
export function validateAssessInput({ text, mode, audioBytes } = {}) {
  if (!Number.isInteger(audioBytes) || audioBytes <= 0) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.MISSING_AUDIO,
      error: 'Missing "audio" file.',
    };
  }
  if (audioBytes > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      status: 413,
      code: PRON_ERROR_CODES.AUDIO_TOO_LARGE,
      error: "That recording is too large. Keep drill takes under 15 MB.",
    };
  }
  if (typeof text !== "string" || !text.trim()) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.MISSING_TEXT,
      error: 'Missing "text" (the reference sentence, non-empty string).',
    };
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.TEXT_TOO_LONG,
      error: "That reference sentence is too long. Keep it under 300 characters.",
    };
  }
  if (mode !== undefined && !PRON_MODES.includes(mode)) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.INVALID_MODE,
      error: '"mode" must be "scripted" or "unscripted".',
    };
  }
  return { ok: true, value: { text: trimmed, mode: mode ?? DEFAULT_MODE } };
}
```

#### Step 2.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Tests  14 passed (14)`.

#### Step 2.5 — Commit

```powershell
git add server/src/pron/contract.js server/src/pron/contract.test.js
git show :server/src/pron/contract.js | Select-String "export function validateAssessInput"
git commit -m "feat(pron): validate assess input before touching a provider"
```

---

### Task 3: `validateReport` — the gate that stops a malformed provider report reaching the client

The pedagogically load-bearing invariant lives here: `substituted` absent means "produced as
expected". `substituted: null` is a contract violation and must be rejected, not tolerated.

**Files:**
- Modify: `server/src/pron/contract.js`
- Test: `server/src/pron/contract.test.js`

**Interfaces:**
- Consumes: `REPORT_VERSION`
- Produces: `export function validateReport(report: unknown): { ok: true } | { ok: false, error: string }`

#### Step 3.1 — Write the failing test

Append to `server/src/pron/contract.test.js`, adding `validateReport` to the import list:

```js
function validReport() {
  return {
    version: 1,
    mode: "scripted",
    model: "mock",
    overall: { accuracy: 78, fluency: 84, completeness: 100 },
    prosody: {
      speechRateWpm: 132.5,
      articulationRateSyllPerSec: 4.2,
      pauseCount: 1,
      pauseTotalSec: 0.31,
      f0MinHz: null,
      f0MaxHz: null,
      f0RangeSemitones: null,
    },
    words: [
      {
        word: "sheep",
        start: 0.42,
        end: 0.81,
        accuracy: 41,
        phones: [
          { ipa: "ʃ", score: 88, start: 0.42, end: 0.5 },
          { ipa: "iː", score: 31, start: 0.5, end: 0.72, substituted: "ɪ" },
          { ipa: "p", score: 79, start: 0.72, end: 0.81 },
        ],
      },
    ],
  };
}

describe("contract — validateReport", () => {
  it("accepts the canonical scripted report", () => {
    expect(validateReport(validReport())).toEqual({ ok: true });
  });

  it("accepts a word with no phones (the unscripted shape)", () => {
    const report = validReport();
    delete report.words[0].phones;
    expect(validateReport(report)).toEqual({ ok: true });
  });

  it("rejects a wrong or missing version", () => {
    expect(validateReport({ ...validReport(), version: 2 }).error).toContain("report.version");
    expect(validateReport(null).ok).toBe(false);
    expect(validateReport("nope").ok).toBe(false);
  });

  it("rejects non-integer or out-of-range overall scores, naming the path", () => {
    const report = validReport();
    report.overall.fluency = 84.5;
    expect(validateReport(report).error).toBe("report.overall.fluency must be an integer 0-100.");
    report.overall.fluency = 101;
    expect(validateReport(report).error).toBe("report.overall.fluency must be an integer 0-100.");
  });

  it("requires all seven prosody keys with the declared types", () => {
    const report = validReport();
    delete report.prosody.pauseCount;
    expect(validateReport(report).error).toBe("report.prosody.pauseCount must be an integer >= 0.");

    const report2 = validReport();
    delete report2.prosody.f0MaxHz;
    expect(validateReport(report2).error).toBe("report.prosody.f0MaxHz must be a number >= 0 or null.");

    const report3 = validReport();
    report3.prosody.f0MaxHz = 220;
    expect(validateReport(report3)).toEqual({ ok: true });
  });

  it("rejects unknown keys on overall, prosody, words and phones", () => {
    const a = validReport();
    a.overall.pronScore = 80;
    expect(validateReport(a).error).toBe('report.overall has unknown key "pronScore".');

    const b = validReport();
    b.prosody.jitter = 0.1;
    expect(validateReport(b).error).toBe('report.prosody has unknown key "jitter".');

    const c = validReport();
    c.words[0].errorType = "Mispronunciation";
    expect(validateReport(c).error).toBe('report.words[0] has unknown key "errorType".');

    const d = validReport();
    d.words[0].phones[0].confidence = 0.9;
    expect(validateReport(d).error).toBe('report.words[0].phones[0] has unknown key "confidence".');
  });

  it("rejects an empty words array and an empty phones array", () => {
    const a = validReport();
    a.words = [];
    expect(validateReport(a).error).toBe("report.words must be a non-empty array.");

    const b = validReport();
    b.words[0].phones = [];
    expect(validateReport(b).error).toBe("report.words[0].phones must be a non-empty array.");
  });

  it("rejects an end before its start", () => {
    const a = validReport();
    a.words[0].end = 0.1;
    expect(validateReport(a).error).toBe("report.words[0].end must be a number >= start.");

    const b = validReport();
    b.words[0].phones[1].end = 0.4;
    expect(validateReport(b).error).toBe("report.words[0].phones[1].end must be a number >= start.");
  });

  it("rejects substituted: null and substituted: '' — absence is the only way to say 'correct'", () => {
    const a = validReport();
    a.words[0].phones[0].substituted = null;
    expect(validateReport(a).error).toContain("report.words[0].phones[0].substituted");

    const b = validReport();
    b.words[0].phones[0].substituted = "";
    expect(validateReport(b).error).toContain("report.words[0].phones[0].substituted");
  });

  it("rejects a substitution equal to the expected phone", () => {
    const report = validReport();
    report.words[0].phones[1].substituted = "iː";
    expect(validateReport(report).error).toBe(
      "report.words[0].phones[1].substituted must differ from ipa.",
    );
  });
});
```

#### Step 3.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `TypeError: validateReport is not a function`.

#### Step 3.3 — Implement

Append to `server/src/pron/contract.js`:

```js
const OVERALL_KEYS = ["accuracy", "fluency", "completeness"];
const PROSODY_NUMBER_KEYS = ["speechRateWpm", "articulationRateSyllPerSec", "pauseTotalSec"];
const PROSODY_NULLABLE_KEYS = ["f0MinHz", "f0MaxHz", "f0RangeSemitones"];
const PROSODY_KEYS = [...PROSODY_NUMBER_KEYS, "pauseCount", ...PROSODY_NULLABLE_KEYS];
const WORD_KEYS = ["word", "start", "end", "accuracy", "phones"];
const PHONE_KEYS = ["ipa", "score", "start", "end", "substituted"];

function isScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fail(error) {
  return { ok: false, error };
}

function unknownKey(object, allowed, path) {
  const extra = Object.keys(object).find((key) => !allowed.includes(key));
  return extra ? `${path} has unknown key "${extra}".` : null;
}

/**
 * Structural gate on anything a provider hands back. Everything the JSON Schema
 * in this file's header states, plus the three invariants a schema cannot say:
 * `substituted` absent-not-null, `substituted !== ipa`, and no unknown keys.
 *
 * @param {unknown} report
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateReport(report) {
  if (!report || typeof report !== "object") return fail("report is not an object.");
  if (report.version !== REPORT_VERSION) {
    return fail(`report.version must be ${REPORT_VERSION}.`);
  }

  const { overall, prosody, words } = report;

  if (!overall || typeof overall !== "object") return fail("report.overall is missing.");
  for (const key of OVERALL_KEYS) {
    if (!isScore(overall[key])) return fail(`report.overall.${key} must be an integer 0-100.`);
  }
  const overallExtra = unknownKey(overall, OVERALL_KEYS, "report.overall");
  if (overallExtra) return fail(overallExtra);

  if (!prosody || typeof prosody !== "object") return fail("report.prosody is missing.");
  for (const key of PROSODY_NUMBER_KEYS) {
    if (!isNonNegativeNumber(prosody[key])) {
      return fail(`report.prosody.${key} must be a number >= 0.`);
    }
  }
  if (!Number.isInteger(prosody.pauseCount) || prosody.pauseCount < 0) {
    return fail("report.prosody.pauseCount must be an integer >= 0.");
  }
  for (const key of PROSODY_NULLABLE_KEYS) {
    if (prosody[key] !== null && !isNonNegativeNumber(prosody[key])) {
      return fail(`report.prosody.${key} must be a number >= 0 or null.`);
    }
  }
  const prosodyExtra = unknownKey(prosody, PROSODY_KEYS, "report.prosody");
  if (prosodyExtra) return fail(prosodyExtra);

  if (!Array.isArray(words) || words.length === 0) {
    return fail("report.words must be a non-empty array.");
  }

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const at = `report.words[${i}]`;
    if (!word || typeof word !== "object") return fail(`${at} is not an object.`);
    if (typeof word.word !== "string" || !word.word) {
      return fail(`${at}.word must be a non-empty string.`);
    }
    if (!isNonNegativeNumber(word.start)) return fail(`${at}.start must be a number >= 0.`);
    if (!isNonNegativeNumber(word.end) || word.end < word.start) {
      return fail(`${at}.end must be a number >= start.`);
    }
    if (!isScore(word.accuracy)) return fail(`${at}.accuracy must be an integer 0-100.`);
    const wordExtra = unknownKey(word, WORD_KEYS, at);
    if (wordExtra) return fail(wordExtra);

    if (!("phones" in word)) continue;
    if (!Array.isArray(word.phones) || word.phones.length === 0) {
      return fail(`${at}.phones must be a non-empty array.`);
    }
    for (let j = 0; j < word.phones.length; j += 1) {
      const phone = word.phones[j];
      const pAt = `${at}.phones[${j}]`;
      if (!phone || typeof phone !== "object") return fail(`${pAt} is not an object.`);
      if (typeof phone.ipa !== "string" || !phone.ipa) {
        return fail(`${pAt}.ipa must be a non-empty string.`);
      }
      if (!isScore(phone.score)) return fail(`${pAt}.score must be an integer 0-100.`);
      if (!isNonNegativeNumber(phone.start)) return fail(`${pAt}.start must be a number >= 0.`);
      if (!isNonNegativeNumber(phone.end) || phone.end < phone.start) {
        return fail(`${pAt}.end must be a number >= start.`);
      }
      if ("substituted" in phone) {
        if (typeof phone.substituted !== "string" || !phone.substituted) {
          return fail(
            `${pAt}.substituted must be a non-empty string when present — omit the key entirely when the phone was produced as expected.`,
          );
        }
        if (phone.substituted === phone.ipa) {
          return fail(`${pAt}.substituted must differ from ipa.`);
        }
      }
      const phoneExtra = unknownKey(phone, PHONE_KEYS, pAt);
      if (phoneExtra) return fail(phoneExtra);
    }
  }

  return { ok: true };
}
```

#### Step 3.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Tests  24 passed (24)`.

#### Step 3.5 — Commit

```powershell
git add server/src/pron/contract.js server/src/pron/contract.test.js
git show :server/src/pron/contract.js | Select-String "must differ from ipa"
git commit -m "feat(pron): validate provider reports, rejecting substituted: null"
```

---

### Task 4: `stripPhones` — the §3 enforcement primitive

**Files:**
- Modify: `server/src/pron/contract.js`
- Test: `server/src/pron/contract.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function stripPhones(report: PronunciationReport): PronunciationReport`

#### Step 4.1 — Write the failing test

Append to `server/src/pron/contract.test.js`, adding `stripPhones` to the import list:

```js
describe("contract — stripPhones", () => {
  it("removes phones from every word", () => {
    const stripped = stripPhones(validReport());
    expect(stripped.words).toHaveLength(1);
    for (const word of stripped.words) {
      expect("phones" in word).toBe(false);
      expect(word.word).toBe("sheep");
      expect(word.accuracy).toBe(41);
    }
  });

  it("never mutates the input report", () => {
    const original = validReport();
    const before = JSON.stringify(original);
    stripPhones(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(original.words[0].phones).toHaveLength(3);
  });

  it("returns new objects, not shared references", () => {
    const original = validReport();
    const stripped = stripPhones(original);
    expect(stripped).not.toBe(original);
    expect(stripped.words).not.toBe(original.words);
    expect(stripped.words[0]).not.toBe(original.words[0]);
  });

  it("produces a report that still validates", () => {
    expect(validateReport(stripPhones(validReport()))).toEqual({ ok: true });
  });

  it("is a no-op on a report whose words already carry no phones", () => {
    const source = stripPhones(validReport());
    expect(stripPhones(source)).toEqual(source);
  });
});
```

#### Step 4.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `TypeError: stripPhones is not a function`.

#### Step 4.3 — Implement

Append to `server/src/pron/contract.js`:

```js
/**
 * Enforces design §3 — unscripted mode never carries phonemes. Returns a new
 * report; the input is never mutated, because the same report object may be
 * logged or reused by the caller.
 *
 * @param {PronunciationReport} report
 * @returns {PronunciationReport}
 */
export function stripPhones(report) {
  return {
    ...report,
    words: report.words.map((word) => {
      const copy = { ...word };
      delete copy.phones;
      return copy;
    }),
  };
}
```

#### Step 4.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Tests  29 passed (29)`.

#### Step 4.5 — Commit

```powershell
git add server/src/pron/contract.js server/src/pron/contract.test.js
git show :server/src/pron/contract.js | Select-String "export function stripPhones"
git commit -m "feat(pron): add stripPhones so unscripted mode can never leak phonemes"
```

---

### Task 5: `MockPron` — deterministic offline scores so the drill runs with no Docker

**Files:**
- Create: `server/src/pron/mock.js`
- Test: `server/src/pron/mock.test.js`

**Interfaces:**
- Consumes: `clampScore`, `DEFAULT_MODE`, `validateReport` (test only) from `./contract.js`
- Produces:
  - `export function hashText(text: string): number` — FNV-1a 32-bit, unsigned
  - `export class MockPron` with
    `async assess(audioBuffer: Buffer, { text, mode = "scripted", filename = "drill.webm" } = {}): Promise<PronunciationReport>`

#### Step 5.1 — Write the failing test

Create `server/src/pron/mock.test.js`:

```js
import { describe, it, expect } from "vitest";
import { MockPron, hashText } from "./mock.js";
import { validateReport } from "./contract.js";

const AUDIO = Buffer.alloc(16000 * 2 * 3); // 3 s of 16 kHz 16-bit PCM
const TEXT = "The ship is full of sheep.";

describe("mock — hashText", () => {
  it("is a stable FNV-1a 32-bit hash", () => {
    expect(hashText("")).toBe(2166136261);
    expect(hashText("a")).toBe(0xe40c292c);
    expect(hashText("foobar")).toBe(0xbf9cf968);
  });

  it("returns an unsigned 32-bit integer for any input", () => {
    for (const sample of ["", "a", "sheep", "The ship is full of sheep."]) {
      const value = hashText(sample);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("mock — MockPron.assess", () => {
  it("returns a report that passes the contract validator", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(validateReport(report)).toEqual({ ok: true });
    expect(report.version).toBe(1);
    expect(report.model).toBe("mock");
    expect(report.mode).toBe("scripted");
  });

  it("is deterministic — same text and audio, byte-identical report", async () => {
    const a = await new MockPron().assess(AUDIO, { text: TEXT });
    const b = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces different scores for different text", async () => {
    const a = await new MockPron().assess(AUDIO, { text: "The ship is full of sheep." });
    const b = await new MockPron().assess(AUDIO, { text: "She sells sea shells." });
    expect(a.overall.accuracy).not.toBe(b.overall.accuracy);
  });

  it("emits one word per whitespace token with punctuation stripped", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "Hello, world!" });
    expect(report.words.map((w) => w.word)).toEqual(["Hello", "world"]);
  });

  it("falls back to the raw tokens when punctuation stripping would empty the sentence", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "..." });
    expect(report.words.map((w) => w.word)).toEqual(["..."]);
    expect(validateReport(report)).toEqual({ ok: true });
  });

  it("gives every word between 1 and 6 phones, sized from the word length", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "a sheep internationalization" });
    const counts = report.words.map((w) => w.phones.length);
    expect(counts).toEqual([1, 2, 6]);
  });

  it("lays phones out contiguously across the clip duration", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    const phones = report.words.flatMap((w) => w.phones);
    expect(phones[0].start).toBe(0);
    for (let i = 1; i < phones.length; i += 1) {
      expect(phones[i].start).toBe(phones[i - 1].end);
    }
    expect(phones.at(-1).end).toBeCloseTo(3, 2);
    for (const word of report.words) {
      expect(word.start).toBe(word.phones[0].start);
      expect(word.end).toBe(word.phones.at(-1).end);
    }
  });

  it("omits substituted rather than emitting null, and only substitutes below 50", async () => {
    const report = await new MockPron().assess(AUDIO, {
      text: "the ship is full of sheep and the sailor watched them jump",
    });
    const phones = report.words.flatMap((w) => w.phones);
    const substituted = phones.filter((p) => "substituted" in p);
    expect(substituted.length).toBeGreaterThan(0);
    for (const phone of phones) {
      if ("substituted" in phone) {
        expect(phone.score).toBeLessThan(50);
        expect(phone.substituted).not.toBe(phone.ipa);
        expect(typeof phone.substituted).toBe("string");
      }
    }
    expect(JSON.stringify(report)).not.toContain('"substituted":null');
  });

  it("keeps every score inside 0-100 and reports completeness 100", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(report.overall.completeness).toBe(100);
    expect(report.overall.fluency).toBeGreaterThanOrEqual(60);
    expect(report.overall.fluency).toBeLessThanOrEqual(100);
    for (const phone of report.words.flatMap((w) => w.phones)) {
      expect(phone.score).toBeGreaterThanOrEqual(20);
      expect(phone.score).toBeLessThanOrEqual(100);
    }
  });

  it("ignores mode — stripping is the route's job for every provider", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT, mode: "unscripted" });
    expect(report.mode).toBe("unscripted");
    expect(report.words[0].phones.length).toBeGreaterThan(0);
  });

  it("emits null F0 fields in stage 1", async () => {
    const { prosody } = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(prosody.f0MinHz).toBeNull();
    expect(prosody.f0MaxHz).toBeNull();
    expect(prosody.f0RangeSemitones).toBeNull();
    expect(prosody.pauseCount).toBeGreaterThanOrEqual(0);
  });
});
```

The three `hashText` constants are the published FNV-1a 32-bit test vectors; if the implementation
disagrees with them it is not FNV-1a and the mock is not reproducible across machines.

#### Step 5.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Error: Failed to load url ./mock.js` for `src/pron/mock.test.js`.

#### Step 5.3 — Implement

Create `server/src/pron/mock.js`:

```js
import { clampScore, DEFAULT_MODE } from "./contract.js";

/**
 * Offline, zero-dependency pron scorer. Deterministic: the same reference text
 * always yields the same report, so route tests and the client drill are
 * reproducible with no sidecar and no Docker.
 */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const MOCK_IPA = ["ʃ", "iː", "p", "b", "v", "æ", "ə", "dʒ", "t", "ɪ"];
const MOCK_SUBSTITUTES = { "iː": "ɪ", æ: "e", v: "b", "dʒ": "j", ə: "ʌ", ɪ: "iː" };
const SUBSTITUTION_THRESHOLD = 50; // phone score below this emits `substituted` when a mapping exists
const MAX_PHONES_PER_WORD = 6;
const PUNCTUATION = /[^\p{L}\p{N}']/gu;
const MOCK_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // the buffer is only measured, never decoded

/**
 * FNV-1a, 32-bit, over UTF-16 code units. Exposed so tests can pin the
 * determinism rather than trust it.
 *
 * @param {string} text
 * @returns {number} unsigned 32-bit integer
 */
export function hashText(text) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function splitWords(text) {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const cleaned = raw.map((word) => word.replace(PUNCTUATION, "")).filter(Boolean);
  // "..." strips to nothing; a report with zero words fails validateReport, so
  // keep the raw tokens instead of emitting an invalid report.
  return cleaned.length ? cleaned : raw;
}

export class MockPron {
  /**
   * @param {Buffer} audioBuffer
   * @param {{ text: string, mode?: "scripted"|"unscripted", filename?: string }} [opts]
   * @returns {Promise<import("./contract.js").PronunciationReport>}
   */
  async assess(audioBuffer, { text, mode = DEFAULT_MODE, filename = "drill.webm" } = {}) {
    void filename; // the mock never reads the bytes; the name is contract parity only
    const durationSec = round3((audioBuffer?.length ?? 0) / MOCK_SAMPLE_RATE / BYTES_PER_SAMPLE);
    const words = splitWords(text);

    const grouped = words.map((word, index) => {
      const wordSeed = hashText(`${word}#${index}`);
      const count = Math.max(1, Math.min(MAX_PHONES_PER_WORD, (word.length >> 1) || 1));
      const phones = [];
      for (let j = 0; j < count; j += 1) {
        const seed = (wordSeed + j * FNV_PRIME) >>> 0;
        const ipa = MOCK_IPA[seed % MOCK_IPA.length];
        const score = clampScore(20 + (seed % 81));
        const phone = { ipa, score, start: 0, end: 0 };
        if (score < SUBSTITUTION_THRESHOLD && MOCK_SUBSTITUTES[ipa]) {
          phone.substituted = MOCK_SUBSTITUTES[ipa];
        }
        phones.push(phone);
      }
      return { word, phones };
    });

    const totalPhones = grouped.reduce((sum, group) => sum + group.phones.length, 0);
    const step = totalPhones > 0 ? durationSec / totalPhones : 0;
    let cursor = 0;
    for (const group of grouped) {
      for (const phone of group.phones) {
        phone.start = round3(cursor * step);
        phone.end = round3((cursor + 1) * step);
        cursor += 1;
      }
    }

    const reportWords = grouped.map(({ word, phones }) => ({
      word,
      start: phones[0].start,
      end: phones.at(-1).end,
      accuracy: clampScore(phones.reduce((sum, p) => sum + p.score, 0) / phones.length),
      phones,
    }));

    const weighted = grouped.reduce(
      (sum, group, index) => sum + reportWords[index].accuracy * group.phones.length,
      0,
    );
    const hash = hashText(text);

    return {
      version: 1,
      mode,
      model: "mock",
      overall: {
        accuracy: clampScore(totalPhones ? weighted / totalPhones : 0),
        fluency: clampScore(60 + (hash % 41)),
        completeness: 100,
      },
      prosody: {
        speechRateWpm: round3(90 + (hash % 80)),
        articulationRateSyllPerSec: round3(3 + ((hash >>> 8) % 25) / 10),
        pauseCount: (hash >>> 16) % 3,
        pauseTotalSec: round3(((hash >>> 20) % 15) / 10),
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: reportWords,
    };
  }
}
```

#### Step 5.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  2 passed (2)`, `Tests  42 passed (42)`.

If the "emits one word per whitespace token" case fails on the phone-count expectation
`[1, 2, 6]`, recheck: `"a"` → `1 >> 1 = 0 || 1 = 1`; `"sheep"` → `5 >> 1 = 2`;
`"internationalization"` → `20 >> 1 = 10`, capped to 6.

#### Step 5.5 — Commit

```powershell
git add server/src/pron/mock.js server/src/pron/mock.test.js
git show :server/src/pron/mock.js | Select-String "SUBSTITUTION_THRESHOLD"
git commit -m "feat(pron): deterministic MockPron provider"
```

---

### Task 6: `LocalPron` — the sidecar HTTP client and its typed error mapping

The sidecar does not exist yet (chunk 3 builds it). This task builds and fully tests the client
against a stubbed `fetch`, so the Node side is finished and provable before any Python runs.

**Files:**
- Create: `server/src/pron/local.js`
- Test: `server/src/pron/local.test.js`

**Interfaces:**
- Consumes: `PRON_ERROR_CODES` from `./contract.js`; env `PRON_URL`, `PRON_TIMEOUT_MS`
- Produces:
  - `export class LocalPron` — zero-arg `constructor()`
  - `async assess(audioBuffer: Buffer, { text, mode = "scripted", filename = "drill.webm" } = {}): Promise<PronunciationReport>`
  - `async health(): Promise<{ status, model, alignAvailable, espeakAvailable, ffmpegAvailable, ts }>`

#### Step 6.1 — Write the failing test

Create `server/src/pron/local.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalPron } from "./local.js";

const AUDIO = Buffer.from("fake-webm-bytes");

function response(body, { status = 200, statusText = "OK" } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

beforeEach(() => {
  delete process.env.PRON_URL;
  delete process.env.PRON_TIMEOUT_MS;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local — configuration", () => {
  it("defaults to http://localhost:8899 with a 30 s timeout", () => {
    const pron = new LocalPron();
    expect(pron.baseUrl).toBe("http://localhost:8899");
    expect(pron.timeoutMs).toBe(30000);
  });

  it("strips trailing slashes from PRON_URL and parses PRON_TIMEOUT_MS", () => {
    process.env.PRON_URL = "  http://pron.local:9000///  ";
    process.env.PRON_TIMEOUT_MS = "5000";
    const pron = new LocalPron();
    expect(pron.baseUrl).toBe("http://pron.local:9000");
    expect(pron.timeoutMs).toBe(5000);
  });

  it("falls back to the default timeout when PRON_TIMEOUT_MS is not a number", () => {
    process.env.PRON_TIMEOUT_MS = "soon";
    expect(new LocalPron().timeoutMs).toBe(30000);
  });
});

describe("local — assess", () => {
  it("POSTs multipart audio/text/mode to /assess and returns the parsed report", async () => {
    const report = { version: 1, mode: "scripted", model: "facebook/x" };
    fetch.mockResolvedValue(response(report));

    const result = await new LocalPron().assess(AUDIO, { text: "the ship", mode: "unscripted" });

    expect(result).toEqual(report);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://localhost:8899/assess");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("text")).toBe("the ship");
    expect(init.body.get("mode")).toBe("unscripted");
    expect(init.body.get("audio").name).toBe("drill.webm");
    expect(init.body.get("audio").size).toBe(AUDIO.length);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults the mode to scripted and honours a caller-supplied filename", async () => {
    fetch.mockResolvedValue(response({ version: 1 }));
    await new LocalPron().assess(AUDIO, { text: "hi", filename: "take.ogg" });
    const form = fetch.mock.calls[0][1].body;
    expect(form.get("mode")).toBe("scripted");
    expect(form.get("audio").name).toBe("take.ogg");
  });

  it("maps a 422 NO_SPEECH body to a typed error carrying the sidecar's message", async () => {
    fetch.mockResolvedValue(
      response(
        { error: "Couldn't make out any speech in that recording.", code: "NO_SPEECH" },
        { status: 422, statusText: "Unprocessable Entity" },
      ),
    );
    await expect(new LocalPron().assess(AUDIO, { text: "hi" })).rejects.toMatchObject({
      code: "NO_SPEECH",
      message: "Couldn't make out any speech in that recording.",
    });
  });

  it("maps a 400 UNPRONOUNCEABLE_TEXT body to a typed error", async () => {
    fetch.mockResolvedValue(
      response(
        { error: "Couldn't turn that sentence into phonemes.", code: "UNPRONOUNCEABLE_TEXT" },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    await expect(new LocalPron().assess(AUDIO, { text: "xyzzy" })).rejects.toMatchObject({
      code: "UNPRONOUNCEABLE_TEXT",
    });
  });

  it("treats a code the Node layer does not know as PRON_UNAVAILABLE", async () => {
    fetch.mockResolvedValue(
      response({ error: "model cold", code: "MODEL_UNAVAILABLE" }, { status: 503, statusText: "Service Unavailable" }),
    );
    const error = await new LocalPron()
      .assess(AUDIO, { text: "hi" })
      .catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(error.message).toContain("Pron sidecar 503 Service Unavailable");
    expect(error.message).toContain("model cold");
  });

  it("caps the echoed upstream detail at 200 characters", async () => {
    fetch.mockResolvedValue(response("x".repeat(5000), { status: 500, statusText: "Internal Server Error" }));
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.message.length).toBeLessThan(260);
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });

  it("tags a refused connection as PRON_UNAVAILABLE without swallowing it", async () => {
    fetch.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: "ECONNREFUSED" }));
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.message).toBe("fetch failed");
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });

  it("tags an abort as PRON_UNAVAILABLE so the route degrades to listen-and-repeat", async () => {
    fetch.mockRejectedValue(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.name).toBe("AbortError");
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });

  it("aborts the request once the timeout elapses", async () => {
    process.env.PRON_TIMEOUT_MS = "10";
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });
});

describe("local — health", () => {
  it("GETs /health and returns the parsed body", async () => {
    const body = { status: "ok", model: "facebook/x", alignAvailable: true, ts: 1 };
    fetch.mockResolvedValue(response(body));
    expect(await new LocalPron().health()).toEqual(body);
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:8899/health");
  });

  it("throws on a non-OK health response instead of reporting the sidecar as up", async () => {
    fetch.mockResolvedValue(response("down", { status: 500, statusText: "Internal Server Error" }));
    await expect(new LocalPron().health()).rejects.toThrow(
      "Pron sidecar 500 Internal Server Error — down",
    );
  });
});
```

#### Step 6.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Error: Failed to load url ./local.js` for `src/pron/local.test.js`.

#### Step 6.3 — Implement

Create `server/src/pron/local.js`:

```js
import { PRON_ERROR_CODES } from "./contract.js";

/**
 * HTTP client for the pronunciation sidecar (design §4.2). Wire protocol:
 *   POST {PRON_URL}/assess  multipart: audio (file), text (form), mode (form)
 *        -> 200 PronunciationReport envelope | 4xx/5xx { error, code }
 *   GET  {PRON_URL}/health  -> { status, model, ... }
 * The Node server never decodes audio; it forwards the bytes verbatim.
 */
const DEFAULTS = {
  url: "http://localhost:8899",
  timeoutMs: 30000,
};

const DETAIL_CAP = 200;

export class LocalPron {
  constructor() {
    this.baseUrl = (process.env.PRON_URL?.trim() || DEFAULTS.url).replace(/\/+$/, "");
    this.timeoutMs = Number(process.env.PRON_TIMEOUT_MS) || DEFAULTS.timeoutMs;
  }

  /**
   * @param {Buffer} audioBuffer
   * @param {{ text: string, mode?: "scripted"|"unscripted", filename?: string }} [opts]
   * @returns {Promise<import("./contract.js").PronunciationReport>}
   */
  async assess(audioBuffer, { text, mode = "scripted", filename = "drill.webm" } = {}) {
    const form = new FormData();
    form.append("audio", new Blob([audioBuffer]), filename);
    form.append("text", text);
    form.append("mode", mode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/assess`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
      } catch (err) {
        // abort, ECONNREFUSED, DNS — all mean "no score this round".
        err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
        throw err;
      }
      if (res.ok) return await res.json();
      throw await this._toTypedError(res);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @returns {Promise<{ status: string, model: string, alignAvailable: boolean, espeakAvailable: boolean, ffmpegAvailable: boolean, ts: number }>}
   */
  async health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Pron sidecar ${res.status} ${res.statusText} — ${detail.slice(0, DETAIL_CAP)}`,
        );
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The body is read exactly once — reading it twice throws on an already
   * disturbed stream, which would mask the real upstream failure.
   */
  async _toTypedError(res) {
    const raw = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 422) {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const code = body?.code;
      if (code && PRON_ERROR_CODES[code]) {
        const err = new Error(body.error || `Pron sidecar ${res.status} ${res.statusText}`);
        err.code = code;
        return err;
      }
    }
    const err = new Error(
      `Pron sidecar ${res.status} ${res.statusText} — ${raw.slice(0, DETAIL_CAP)}`,
    );
    err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
    return err;
  }
}
```

#### Step 6.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  3 passed (3)`, `Tests  55 passed (55)`.

#### Step 6.5 — Commit

```powershell
git add server/src/pron/local.js server/src/pron/local.test.js
git show :server/src/pron/local.js | Select-String "_toTypedError"
git commit -m "feat(pron): sidecar HTTP client with typed error mapping"
```

---

### Task 7: `AzurePron` — the calibration-only adapter (external interface: verify first)

Azure is **never** a runtime path. It exists so the calibration harness can put a commercial
reference score next to the local one. It is built here because the factory in the next task
imports it.

**Files:**
- Create: `server/src/pron/azure.js`
- Test: `server/src/pron/azure.test.js`

**Interfaces:**
- Consumes: `PRON_ERROR_CODES`, `clampScore`, `validateReport` from `./contract.js`; env
  `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_LOCALE`, `AZURE_SPEECH_TIMEOUT_MS`
- Produces:
  - `export class AzurePron` — zero-arg `constructor()`
  - `async assess(audioBuffer: Buffer, { text, mode = "scripted", filename = "drill.wav" } = {}): Promise<PronunciationReport>`

#### Step 7.0 — VERIFICATION STEP (do this before writing any code)

Nothing about Azure's wire format was verified during recon. Open, in a browser:

1. `https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short`
2. `https://learn.microsoft.com/azure/ai-services/speech-service/how-to-pronunciation-assessment`

Confirm each of the following and write the answer into your notes before continuing:

| # | Claim the code below makes | Where to confirm |
|---|---|---|
| A1 | Endpoint is `https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={locale}` | short-audio REST page |
| A2 | Auth header is `Ocp-Apim-Subscription-Key` | short-audio REST page |
| A3 | The assessment config travels in a `Pronunciation-Assessment` header as **base64 of a JSON object** | pronunciation-assessment page, "REST" section |
| A4 | Config keys are `ReferenceText`, `GradingSystem`, `Granularity`, `Dimension`, `EnableMiscue`, `PhonemeAlphabet` | same |
| A5 | `PhonemeAlphabet: "IPA"` is accepted and makes `Phonemes[].Phoneme` an IPA string | same |
| A6 | Response is `{ RecognitionStatus, NBest: [{ PronunciationAssessment: { AccuracyScore, FluencyScore, CompletenessScore }, Words: [{ Word, Offset, Duration, PronunciationAssessment: { AccuracyScore }, Phonemes: [{ Phoneme, Offset, Duration, PronunciationAssessment: { AccuracyScore } }] }] }] }` | same |
| A7 | `Offset` / `Duration` are in **100-nanosecond ticks** | short-audio REST page |

If any differ, change `_toReport` / `_assessmentHeader` **and the canned response in the test**
to match the live docs before you run anything. Do not guess.

#### Step 7.1 — Write the failing test

Create `server/src/pron/azure.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AzurePron } from "./azure.js";
import { validateReport } from "./contract.js";

const AUDIO = Buffer.from("riff-bytes");

// Canned Azure short-audio pronunciation-assessment body. Offsets are
// 100-nanosecond ticks: 4_200_000 ticks = 0.42 s.
const AZURE_BODY = {
  RecognitionStatus: "Success",
  DisplayText: "Sheep.",
  NBest: [
    {
      Lexical: "sheep",
      PronunciationAssessment: { AccuracyScore: 41, FluencyScore: 84, CompletenessScore: 100 },
      Words: [
        {
          Word: "sheep",
          Offset: 4200000,
          Duration: 3900000,
          PronunciationAssessment: { AccuracyScore: 41, ErrorType: "Mispronunciation" },
          Phonemes: [
            { Phoneme: "ʃ", Offset: 4200000, Duration: 800000, PronunciationAssessment: { AccuracyScore: 88 } },
            { Phoneme: "iː", Offset: 5000000, Duration: 2200000, PronunciationAssessment: { AccuracyScore: 31 } },
            { Phoneme: "p", Offset: 7200000, Duration: 900000, PronunciationAssessment: { AccuracyScore: 79 } },
          ],
        },
      ],
    },
  ],
};

function response(body, { status = 200, statusText = "OK" } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

beforeEach(() => {
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_LOCALE;
  delete process.env.AZURE_SPEECH_TIMEOUT_MS;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("azure — guards", () => {
  it("refuses to run without a key or a region", async () => {
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.message).toBe("Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.");
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses with a key but no region", async () => {
    process.env.AZURE_SPEECH_KEY = "k";
    await expect(new AzurePron().assess(AUDIO, { text: "sheep" })).rejects.toThrow(
      "Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
    );
  });
});

describe("azure — assess", () => {
  beforeEach(() => {
    process.env.AZURE_SPEECH_KEY = "secret-key";
    process.env.AZURE_SPEECH_REGION = "westeurope";
  });

  it("sends the reference text in the base64 Pronunciation-Assessment header", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    await new AzurePron().assess(AUDIO, { text: "sheep" });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("https://westeurope.stt.speech.microsoft.com/");
    expect(url).toContain("language=en-US");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("secret-key");
    const config = JSON.parse(
      Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8"),
    );
    expect(config).toMatchObject({
      ReferenceText: "sheep",
      Granularity: "Phoneme",
      PhonemeAlphabet: "IPA",
    });
  });

  it("maps the Azure body onto a valid PronunciationReport with seconds, not ticks", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    const report = await new AzurePron().assess(AUDIO, { text: "sheep" });

    expect(validateReport(report)).toEqual({ ok: true });
    expect(report.overall).toEqual({ accuracy: 41, fluency: 84, completeness: 100 });
    expect(report.words[0].start).toBe(0.42);
    expect(report.words[0].end).toBe(0.81);
    expect(report.words[0].phones.map((p) => p.ipa)).toEqual(["ʃ", "iː", "p"]);
    expect(report.words[0].phones[1]).toEqual({ ipa: "iː", score: 31, start: 0.5, end: 0.72 });
  });

  it("never invents a substitution — Azure does not report one", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    const report = await new AzurePron().assess(AUDIO, { text: "sheep" });
    expect(JSON.stringify(report)).not.toContain("substituted");
  });

  it("throws BAD_REPORT when the mapping produces something the contract rejects", async () => {
    fetch.mockResolvedValue(response({ RecognitionStatus: "Success", NBest: [] }));
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.code).toBe("BAD_REPORT");
  });

  it("surfaces a non-OK Azure response as PRON_UNAVAILABLE", async () => {
    fetch.mockResolvedValue(response("forbidden", { status: 403, statusText: "Forbidden" }));
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(error.message).toContain("Azure 403 Forbidden");
  });
});
```

#### Step 7.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Error: Failed to load url ./azure.js` for `src/pron/azure.test.js`.

#### Step 7.3 — Implement

Create `server/src/pron/azure.js`:

```js
import { clampScore, PRON_ERROR_CODES, validateReport } from "./contract.js";

/**
 * Azure Speech pronunciation-assessment adapter — CALIBRATION ONLY (design §2,
 * "Cloud as a runtime path" is a non-goal). Selected only by an explicit
 * PRON_PROVIDER=azure with AZURE_SPEECH_KEY present.
 *
 * EXTERNAL CALL SITE — the Azure request URL, the Pronunciation-Assessment
 * header encoding, and the response JSON field names MUST BE VERIFIED AGAINST
 * LIVE AZURE DOCS DURING IMPLEMENTATION. Nothing about Azure's wire format was
 * verified by recon.
 */
const DEFAULTS = {
  locale: "en-US",
  timeoutMs: 30000,
};

const TICKS_PER_SECOND = 1e7; // Azure offsets are 100-nanosecond ticks
const DETAIL_CAP = 200;

function seconds(ticks) {
  return Math.round((Number(ticks) / TICKS_PER_SECOND) * 1000) / 1000;
}

/**
 * Azure JSON -> PronunciationReport. Deliberately emits no `substituted`:
 * Azure reports an ErrorType per word, not the phone it actually heard, and
 * inventing one would fabricate the single most pedagogically load-bearing
 * field in the contract.
 */
function _toReport(azureJson) {
  const best = azureJson?.NBest?.[0];
  const assessment = best?.PronunciationAssessment ?? {};
  const words = (best?.Words ?? []).map((word) => {
    const start = seconds(word.Offset ?? 0);
    const end = seconds((word.Offset ?? 0) + (word.Duration ?? 0));
    const phones = (word.Phonemes ?? []).map((phone) => ({
      ipa: String(phone.Phoneme ?? ""),
      score: clampScore(phone.PronunciationAssessment?.AccuracyScore),
      start: seconds(phone.Offset ?? 0),
      end: seconds((phone.Offset ?? 0) + (phone.Duration ?? 0)),
    }));
    const mapped = {
      word: String(word.Word ?? ""),
      start,
      end,
      accuracy: clampScore(word.PronunciationAssessment?.AccuracyScore),
    };
    if (phones.length) mapped.phones = phones;
    return mapped;
  });

  const totalSec = words.length ? words.at(-1).end : 0;

  return {
    version: 1,
    mode: "scripted",
    model: "azure-pronunciation-assessment",
    overall: {
      accuracy: clampScore(assessment.AccuracyScore),
      fluency: clampScore(assessment.FluencyScore),
      completeness: clampScore(assessment.CompletenessScore),
    },
    prosody: {
      speechRateWpm: totalSec > 0 ? Math.round((words.length / totalSec) * 60 * 1000) / 1000 : 0,
      articulationRateSyllPerSec: 0,
      pauseCount: 0,
      pauseTotalSec: 0,
      f0MinHz: null,
      f0MaxHz: null,
      f0RangeSemitones: null,
    },
    words,
  };
}

export class AzurePron {
  constructor() {
    this.apiKey = process.env.AZURE_SPEECH_KEY;
    this.region = process.env.AZURE_SPEECH_REGION?.trim() || null;
    this.locale = process.env.AZURE_SPEECH_LOCALE?.trim() || DEFAULTS.locale;
    this.timeoutMs = Number(process.env.AZURE_SPEECH_TIMEOUT_MS) || DEFAULTS.timeoutMs;
  }

  _assessmentHeader(text) {
    const config = {
      ReferenceText: text,
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true,
      PhonemeAlphabet: "IPA",
    };
    return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  }

  /**
   * @param {Buffer} audioBuffer 16 kHz mono PCM WAV
   * @param {{ text: string, mode?: "scripted"|"unscripted", filename?: string }} [opts]
   * @returns {Promise<import("./contract.js").PronunciationReport>}
   */
  async assess(audioBuffer, { text, mode = "scripted", filename = "drill.wav" } = {}) {
    void mode;
    void filename;
    if (!this.apiKey || !this.region) {
      const err = new Error("Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.");
      err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
      throw err;
    }

    const url =
      `https://${this.region}.stt.speech.microsoft.com` +
      `/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(this.locale)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json;
    try {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.apiKey,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            Accept: "application/json",
            "Pronunciation-Assessment": this._assessmentHeader(text),
          },
          body: audioBuffer,
          signal: controller.signal,
        });
      } catch (err) {
        err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
        throw err;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(
          `Azure ${res.status} ${res.statusText} — ${detail.slice(0, DETAIL_CAP)}`,
        );
        err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
        throw err;
      }
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const report = _toReport(json);
    const valid = validateReport(report);
    if (!valid.ok) {
      const err = new Error(`Azure returned an unmappable report — ${valid.error}`);
      err.code = PRON_ERROR_CODES.BAD_REPORT;
      throw err;
    }
    return report;
  }
}
```

#### Step 7.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  4 passed (4)`, `Tests  62 passed (62)`.

#### Step 7.5 — Commit

```powershell
git add server/src/pron/azure.js server/src/pron/azure.test.js
git show :server/src/pron/azure.js | Select-String "CALIBRATION ONLY"
git commit -m "feat(pron): azure calibration adapter (never a runtime path)"
```

---

### Task 8: `getPron()` — the factory and the `PRON_PROVIDER` degradation ladder

Follows `brain/index.js` (Variant A) exactly: the instance is never null, so the instance itself is
the memoization guard, and there is no reset export.

**Files:**
- Create: `server/src/pron/index.js`
- Test: `server/src/pron/index.test.js`

**Interfaces:**
- Consumes: `MockPron`, `LocalPron`, `AzurePron`; env `PRON_PROVIDER`, `AZURE_SPEECH_KEY`
- Produces:
  - `export function getPron(): MockPron|LocalPron|AzurePron` — never null
  - `export function currentPronProvider(): "local"|"mock"|"azure"`

#### Step 8.1 — Write the failing test

Create `server/src/pron/index.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The factory memoizes at module scope and exposes no reset (matching brain/,
// tts/, stt/), so every case reloads the module graph.
async function loadPron(env = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("./index.js");
}

beforeEach(() => {
  delete process.env.PRON_PROVIDER;
  delete process.env.PRON_URL;
  delete process.env.PRON_TIMEOUT_MS;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pron factory — provider resolution", () => {
  it("defaults to mock when PRON_PROVIDER is unset", async () => {
    const { getPron, currentPronProvider } = await loadPron({ PRON_PROVIDER: undefined });
    const { MockPron } = await import("./mock.js");
    expect(getPron()).toBeInstanceOf(MockPron);
    expect(currentPronProvider()).toBe("mock");
  });

  it("selects the sidecar client for PRON_PROVIDER=local", async () => {
    const { getPron, currentPronProvider } = await loadPron({ PRON_PROVIDER: "local" });
    const { LocalPron } = await import("./local.js");
    expect(getPron()).toBeInstanceOf(LocalPron);
    expect(currentPronProvider()).toBe("local");
  });

  it("trims and lowercases the env value", async () => {
    const { currentPronProvider } = await loadPron({ PRON_PROVIDER: "  LOCAL  " });
    expect(currentPronProvider()).toBe("local");
  });

  it("selects azure only when a key is present", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "secret",
    });
    const { AzurePron } = await import("./azure.js");
    expect(getPron()).toBeInstanceOf(AzurePron);
    expect(currentPronProvider()).toBe("azure");
  });

  it("warns and falls back to mock when azure is asked for without a key", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: undefined,
    });
    const { MockPron } = await import("./mock.js");
    expect(getPron()).toBeInstanceOf(MockPron);
    expect(currentPronProvider()).toBe("mock");
    expect(console.warn).toHaveBeenCalledWith(
      "[pron] PRON_PROVIDER=azure but AZURE_SPEECH_KEY is missing → falling back to mock.",
    );
  });

  it("treats a whitespace-only azure key as missing", async () => {
    const { currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "   ",
    });
    expect(currentPronProvider()).toBe("mock");
  });

  it("warns and falls back to mock on an unknown provider", async () => {
    const { currentPronProvider } = await loadPron({ PRON_PROVIDER: "elsa" });
    expect(currentPronProvider()).toBe("mock");
    expect(console.warn).toHaveBeenCalledWith(
      '[pron] unknown PRON_PROVIDER="elsa" → falling back to mock.',
    );
  });
});

describe("pron factory — memoization", () => {
  it("constructs the provider once and logs the choice once", async () => {
    const { getPron } = await loadPron({ PRON_PROVIDER: "local" });
    const first = getPron();
    const second = getPron();
    expect(second).toBe(first);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("[pron] provider = local");
  });

  it("currentPronProvider() self-primes without an explicit getPron() call", async () => {
    const { currentPronProvider } = await loadPron({ PRON_PROVIDER: "local" });
    expect(currentPronProvider()).toBe("local");
    expect(console.log).toHaveBeenCalledWith("[pron] provider = local");
  });

  it("ignores a PRON_PROVIDER change after the first resolution", async () => {
    const { getPron, currentPronProvider } = await loadPron({ PRON_PROVIDER: "local" });
    getPron();
    process.env.PRON_PROVIDER = "mock";
    expect(currentPronProvider()).toBe("local");
  });
});
```

#### Step 8.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Error: Failed to load url ./index.js` for `src/pron/index.test.js`.

#### Step 8.3 — Implement

Create `server/src/pron/index.js`:

```js
import { MockPron } from "./mock.js";
import { LocalPron } from "./local.js";
import { AzurePron } from "./azure.js";

/**
 * Pluggable pronunciation-assessment factory (design §4.1).
 *   local -> score via the sidecar container on :8899 (CAPT pipeline)
 *   mock  -> deterministic offline pseudo-scores, $0, no Docker (default)
 *   azure -> calibration reference only; never a runtime path
 * Swap with PRON_PROVIDER in server/.env.
 */
let _pron = null;
let _provider = null;

function resolveProvider() {
  const explicit = process.env.PRON_PROVIDER?.trim().toLowerCase();
  const hasAzureKey = !!process.env.AZURE_SPEECH_KEY?.trim();

  let provider = explicit || "mock";

  if (provider === "azure" && !hasAzureKey) {
    console.warn("[pron] PRON_PROVIDER=azure but AZURE_SPEECH_KEY is missing → falling back to mock.");
    provider = "mock";
  }
  if (provider !== "local" && provider !== "mock" && provider !== "azure") {
    console.warn(`[pron] unknown PRON_PROVIDER="${provider}" → falling back to mock.`);
    provider = "mock";
  }
  return provider;
}

/**
 * @returns {MockPron|LocalPron|AzurePron} never null — the drill always has a scorer to call
 */
export function getPron() {
  if (_pron) return _pron;
  _provider = resolveProvider();
  _pron =
    _provider === "local"
      ? new LocalPron()
      : _provider === "azure"
        ? new AzurePron()
        : new MockPron();
  console.log(`[pron] provider = ${_provider}`);
  return _pron;
}

/**
 * @returns {"local"|"mock"|"azure"}
 */
export function currentPronProvider() {
  if (!_provider) getPron();
  return _provider;
}
```

#### Step 8.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  5 passed (5)`, `Tests  72 passed (72)`.

#### Step 8.5 — Commit

```powershell
git add server/src/pron/index.js server/src/pron/index.test.js
git show :server/src/pron/index.js | Select-String "provider = "
git commit -m "feat(pron): getPron factory with mock fallback ladder"
```

---

### Task 9: The drill content file and `listPrompts()`

The server owns the drill set (design §4.1) so that when M3/M4 make it ledger-derived, the route and
the client contract do not change.

**Files:**
- Create: `server/src/content/drills.v1.json`
- Create: `server/src/pron/prompts.js`
- Test: `server/src/pron/prompts.test.js`

**Interfaces:**
- Consumes: `PRON_ERROR_CODES` from `./contract.js`
- Produces:
  - `export const PROMPT_FOCUSES: readonly string[]`
  - `export function listPrompts({ focus } = {}): { ok: true, value: PromptSet } | { ok: false, status: number, code: string, error: string }`
  - `PromptSet` = `{ version: number, updated: string, focuses: string[], prompts: DrillPrompt[] }`
  - `DrillPrompt` = `{ id, focus, text, ipaTargets, keyWords, contrast, level }`

#### Step 9.1 — Write the failing test

Create `server/src/pron/prompts.test.js`:

```js
import { describe, it, expect } from "vitest";
import { PROMPT_FOCUSES, listPrompts } from "./prompts.js";

const FROZEN_FOCUSES = ["ih-iy", "ae", "schwa", "v-b", "dzh", "s-cluster", "ed-ending"];
const LEVELS = ["A2", "B1", "B2", "C1"];

function tokens(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

describe("prompts — the full set", () => {
  it("exposes exactly the seven frozen focus slugs, frozen", () => {
    expect([...PROMPT_FOCUSES]).toEqual(FROZEN_FOCUSES);
    expect(Object.isFrozen(PROMPT_FOCUSES)).toBe(true);
  });

  it("returns the whole set when focus is omitted, null, or empty", () => {
    const full = listPrompts();
    expect(full.ok).toBe(true);
    expect(full.value.version).toBe(1);
    expect(full.value.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(full.value.prompts.length).toBeGreaterThanOrEqual(21);
    expect(listPrompts({ focus: null }).value.prompts).toHaveLength(full.value.prompts.length);
    expect(listPrompts({ focus: "" }).value.prompts).toHaveLength(full.value.prompts.length);
  });
});

describe("prompts — filtering", () => {
  it("returns only the requested focus but still advertises every focus", () => {
    const result = listPrompts({ focus: "v-b" });
    expect(result.ok).toBe(true);
    expect(result.value.prompts.length).toBeGreaterThanOrEqual(3);
    expect(result.value.prompts.every((p) => p.focus === "v-b")).toBe(true);
    expect(result.value.focuses).toEqual(FROZEN_FOCUSES);
  });

  it("rejects an unknown focus with a message listing the valid slugs", () => {
    expect(listPrompts({ focus: "th" })).toEqual({
      ok: false,
      status: 400,
      code: "UNKNOWN_FOCUS",
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
    });
  });

  it("rejects a repeated query param (express hands over an array)", () => {
    expect(listPrompts({ focus: ["ae", "schwa"] }).code).toBe("UNKNOWN_FOCUS");
  });
});

describe("prompts — content invariants", () => {
  const prompts = listPrompts().value.prompts;

  it("gives every focus at least three prompts", () => {
    for (const focus of FROZEN_FOCUSES) {
      expect(prompts.filter((p) => p.focus === focus).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses unique ids prefixed with their own focus", () => {
    const ids = prompts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prompt of prompts) {
      expect(prompt.id.startsWith(`${prompt.focus}-`)).toBe(true);
      expect(prompt.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("declares only known focuses and levels, with text inside the 300-char cap", () => {
    for (const prompt of prompts) {
      expect(FROZEN_FOCUSES).toContain(prompt.focus);
      expect(LEVELS).toContain(prompt.level);
      expect(prompt.text.length).toBeGreaterThan(0);
      expect(prompt.text.length).toBeLessThanOrEqual(300);
      expect(prompt.contrast.length).toBeGreaterThan(0);
    }
  });

  it("only lists keyWords that actually appear in the sentence", () => {
    for (const prompt of prompts) {
      const words = tokens(prompt.text);
      expect(prompt.keyWords.length).toBeGreaterThan(0);
      for (const keyWord of prompt.keyWords) {
        expect(words).toContain(keyWord.toLowerCase());
      }
    }
  });

  it("keeps ipaTargets free of stress marks, tie bars, separators and spaces", () => {
    for (const prompt of prompts) {
      expect(prompt.ipaTargets.length).toBeGreaterThan(0);
      for (const ipa of prompt.ipaTargets) {
        expect(ipa.length).toBeGreaterThan(0);
        expect(ipa).not.toMatch(/[ˈˌ|͡\s]/);
      }
    }
  });

  it("carries exactly the seven contract keys on every prompt", () => {
    for (const prompt of prompts) {
      expect(Object.keys(prompt).sort()).toEqual([
        "contrast",
        "focus",
        "id",
        "ipaTargets",
        "keyWords",
        "level",
        "text",
      ]);
    }
  });
});
```

#### Step 9.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Error: Failed to load url ./prompts.js` for `src/pron/prompts.test.js`.

#### Step 9.3 — Create the content file

Create `server/src/content/drills.v1.json`:

```json
{
  "version": 1,
  "updated": "2026-07-27",
  "focuses": ["ih-iy", "ae", "schwa", "v-b", "dzh", "s-cluster", "ed-ending"],
  "prompts": [
    {
      "id": "ih-iy-01",
      "focus": "ih-iy",
      "text": "The ship is full of sheep.",
      "ipaTargets": ["ɪ", "iː"],
      "keyWords": ["ship", "sheep"],
      "contrast": "vowel length + quality",
      "level": "B2"
    },
    {
      "id": "ih-iy-02",
      "focus": "ih-iy",
      "text": "He will fill the field with wheat.",
      "ipaTargets": ["ɪ", "iː"],
      "keyWords": ["fill", "field", "wheat"],
      "contrast": "vowel length + quality",
      "level": "B1"
    },
    {
      "id": "ih-iy-03",
      "focus": "ih-iy",
      "text": "This seat is a bit cheap.",
      "ipaTargets": ["ɪ", "iː"],
      "keyWords": ["seat", "bit", "cheap"],
      "contrast": "vowel length + quality",
      "level": "B1"
    },
    {
      "id": "ae-01",
      "focus": "ae",
      "text": "That cat sat on a black mat.",
      "ipaTargets": ["æ"],
      "keyWords": ["cat", "sat", "black", "mat"],
      "contrast": "absent in Spanish",
      "level": "A2"
    },
    {
      "id": "ae-02",
      "focus": "ae",
      "text": "Sam had a bad plan.",
      "ipaTargets": ["æ"],
      "keyWords": ["sam", "had", "bad", "plan"],
      "contrast": "absent in Spanish",
      "level": "A2"
    },
    {
      "id": "ae-03",
      "focus": "ae",
      "text": "The angry man ran past the cab.",
      "ipaTargets": ["æ"],
      "keyWords": ["angry", "man", "ran", "cab"],
      "contrast": "absent in Spanish",
      "level": "B1"
    },
    {
      "id": "schwa-01",
      "focus": "schwa",
      "text": "This sofa is comfortable.",
      "ipaTargets": ["ə"],
      "keyWords": ["sofa", "comfortable"],
      "contrast": "schwa reduction in unstressed syllables",
      "level": "B1"
    },
    {
      "id": "schwa-02",
      "focus": "schwa",
      "text": "The camera above the banana is broken.",
      "ipaTargets": ["ə"],
      "keyWords": ["camera", "above", "banana"],
      "contrast": "schwa reduction in unstressed syllables",
      "level": "B2"
    },
    {
      "id": "schwa-03",
      "focus": "schwa",
      "text": "Another problem is the temperature.",
      "ipaTargets": ["ə"],
      "keyWords": ["another", "problem", "temperature"],
      "contrast": "schwa reduction in unstressed syllables",
      "level": "B2"
    },
    {
      "id": "v-b-01",
      "focus": "v-b",
      "text": "Did you vote for the boat or the van?",
      "ipaTargets": ["v", "b"],
      "keyWords": ["vote", "boat", "van"],
      "contrast": "phonemic in English, allophonic in Spanish",
      "level": "B1"
    },
    {
      "id": "v-b-02",
      "focus": "v-b",
      "text": "Very best berries have value.",
      "ipaTargets": ["v", "b"],
      "keyWords": ["very", "best", "berries", "value"],
      "contrast": "phonemic in English, allophonic in Spanish",
      "level": "B2"
    },
    {
      "id": "v-b-03",
      "focus": "v-b",
      "text": "The brave driver bought a van.",
      "ipaTargets": ["v", "b"],
      "keyWords": ["brave", "driver", "bought", "van"],
      "contrast": "phonemic in English, allophonic in Spanish",
      "level": "B1"
    },
    {
      "id": "dzh-01",
      "focus": "dzh",
      "text": "John judged the large jar.",
      "ipaTargets": ["dʒ"],
      "keyWords": ["john", "judged", "large", "jar"],
      "contrast": "affricate absent in Spanish",
      "level": "B1"
    },
    {
      "id": "dzh-02",
      "focus": "dzh",
      "text": "The manager enjoys his job.",
      "ipaTargets": ["dʒ"],
      "keyWords": ["manager", "enjoys", "job"],
      "contrast": "affricate absent in Spanish",
      "level": "B1"
    },
    {
      "id": "dzh-03",
      "focus": "dzh",
      "text": "Just imagine a giant bridge.",
      "ipaTargets": ["dʒ"],
      "keyWords": ["just", "imagine", "giant", "bridge"],
      "contrast": "affricate absent in Spanish",
      "level": "B2"
    },
    {
      "id": "s-cluster-01",
      "focus": "s-cluster",
      "text": "She speaks Spanish in Spain every spring.",
      "ipaTargets": ["s"],
      "keyWords": ["speaks", "spanish", "spain", "spring"],
      "contrast": "Spanish epenthesis (spain -> espain)",
      "level": "B1"
    },
    {
      "id": "s-cluster-02",
      "focus": "s-cluster",
      "text": "The student studied a strange story.",
      "ipaTargets": ["s"],
      "keyWords": ["student", "studied", "strange", "story"],
      "contrast": "Spanish epenthesis (spain -> espain)",
      "level": "B1"
    },
    {
      "id": "s-cluster-03",
      "focus": "s-cluster",
      "text": "Stop the small van at the station.",
      "ipaTargets": ["s"],
      "keyWords": ["stop", "small", "station"],
      "contrast": "Spanish epenthesis (spain -> espain)",
      "level": "A2"
    },
    {
      "id": "ed-ending-01",
      "focus": "ed-ending",
      "text": "She walked, played, and wanted more.",
      "ipaTargets": ["t", "d", "ɪd"],
      "keyWords": ["walked", "played", "wanted"],
      "contrast": "/t/ /d/ /ɪd/ allomorphy",
      "level": "B1"
    },
    {
      "id": "ed-ending-02",
      "focus": "ed-ending",
      "text": "They asked, answered, and decided quickly.",
      "ipaTargets": ["t", "d", "ɪd"],
      "keyWords": ["asked", "answered", "decided"],
      "contrast": "/t/ /d/ /ɪd/ allomorphy",
      "level": "B2"
    },
    {
      "id": "ed-ending-03",
      "focus": "ed-ending",
      "text": "He watched the film and needed a break.",
      "ipaTargets": ["t", "d", "ɪd"],
      "keyWords": ["watched", "needed"],
      "contrast": "/t/ /d/ /ɪd/ allomorphy",
      "level": "B1"
    }
  ]
}
```

Save it as **UTF-8 without a BOM**. `readFileSync(..., "utf8")` + `JSON.parse` throws
`Unexpected token in JSON at position 0` on a BOM, and it would throw at server boot, not at
request time.

#### Step 9.4 — Implement the loader

Create `server/src/pron/prompts.js`:

```js
import { readFileSync } from "node:fs";
import { PRON_ERROR_CODES } from "./contract.js";

/**
 * Serves the curated drill set (design §4.1, §5). Reads a versioned JSON file
 * today; becomes ledger-derived in M3/M4 with no change to the route or the
 * client contract.
 *
 * The file is read once at module load. An unreadable or malformed file is a
 * boot failure, not a per-request 500.
 */
const CONTENT = Object.freeze(
  JSON.parse(readFileSync(new URL("../content/drills.v1.json", import.meta.url), "utf8")),
);

/** @type {readonly string[]} */
export const PROMPT_FOCUSES = Object.freeze([...CONTENT.focuses]);

/**
 * @param {{ focus?: string|null }} [opts]
 * @returns {{ ok: true, value: { version: number, updated: string, focuses: string[], prompts: object[] } }
 *          | { ok: false, status: number, code: string, error: string }}
 */
export function listPrompts({ focus } = {}) {
  if (focus !== undefined && focus !== null && focus !== "" && !PROMPT_FOCUSES.includes(focus)) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.UNKNOWN_FOCUS,
      error: `Unknown "focus". Valid values: ${PROMPT_FOCUSES.join(", ")}.`,
    };
  }
  const prompts = focus ? CONTENT.prompts.filter((prompt) => prompt.focus === focus) : CONTENT.prompts;
  return {
    ok: true,
    value: {
      version: CONTENT.version,
      updated: CONTENT.updated,
      // Always the complete list, even when the prompts are filtered — the
      // client renders the focus switcher from it.
      focuses: PROMPT_FOCUSES,
      prompts,
    },
  };
}
```

#### Step 9.5 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  6 passed (6)`, `Tests  82 passed (82)`.

If the keyWords case fails, the message names the failing prompt's tokens — fix the **content
file**, not the test.

#### Step 9.6 — Commit

```powershell
git add server/src/content/drills.v1.json server/src/pron/prompts.js server/src/pron/prompts.test.js
git show :server/src/content/drills.v1.json | Select-String '"ih-iy-01"'
git show :server/src/pron/prompts.js | Select-String "export function listPrompts"
git commit -m "feat(pron): versioned drill content and the prompts loader"
```

---

### Task 10: Extract `createApp()` so the routes are testable, and add `pron` to `/health`

`server/src/index.js` calls `app.listen` at import time and exports nothing, so no HTTP-level test
can touch it. This task splits the app from the listener and adds the fourth provider pill.

**Files:**
- Create: `server/src/app.js`
- Modify: `server/src/index.js`
- Test: `server/src/app.test.js`

**Interfaces:**
- Consumes: `currentProvider`, `currentTTSProvider`, `currentSTTProvider`, `currentPronProvider`, `turnRouter`
- Produces: `export function createApp(): import("express").Express` — built, not listening

> `server/src/app.test.js` is an addition to the frozen file manifest. It is a test file, not an
> exported symbol, and it is the only place the `/health` contract can be asserted.

#### Step 10.0 — VERIFICATION STEP (V8)

Confirm nothing imports `server/src/index.js` before moving code out of it:

```powershell
Select-String -Path server/src/*.js,server/src/**/*.js,client/src/**/*.js -Pattern "src/index.js|from \"\./index\.js\"" | Where-Object { $_.Path -notmatch "pron|brain|tts|stt" }
```

Expected: no rows. The only references to `src/index.js` are the `dev`/`start` scripts in
`server/package.json`.

#### Step 10.1 — Write the failing test

Create `server/src/app.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { currentPronProvider } from "./pron/index.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createApp — /health", () => {
  it("reports every provider slot including pron, in the frozen key order", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["status", "brain", "tts", "stt", "pron", "ts"]);
    expect(res.body.status).toBe("ok");
    expect(res.body.pron).toBe(currentPronProvider());
    expect(typeof res.body.ts).toBe("number");
  });
});

describe("createApp — wiring", () => {
  it("still mounts the turn router", async () => {
    const res = await request(createApp()).post("/turn").send({ utterance: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing "utterance" (non-empty string).');
  });

  it("returns a fresh app per call so tests never share state", () => {
    expect(createApp()).not.toBe(createApp());
  });

  it("does not start a listener on import", () => {
    const app = createApp();
    expect(typeof app.listen).toBe("function");
    expect(app.listening).toBeUndefined();
  });
});
```

#### Step 10.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Error: Failed to load url ./app.js` for `src/app.test.js`.

#### Step 10.3 — Implement

Create `server/src/app.js`:

```js
import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";
import { currentPronProvider } from "./pron/index.js";

/**
 * Builds the Express app without binding a port, so route contracts can be
 * exercised by supertest (design §8). src/index.js is the only listener.
 *
 * @returns {import("express").Express}
 */
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      brain: currentProvider(),
      tts: currentTTSProvider(),
      stt: currentSTTProvider(),
      pron: currentPronProvider(),
      ts: Date.now(),
    });
  });

  app.use("/turn", turnRouter);

  // Fallback error handler so nothing crashes the single-user server.
  app.use((err, _req, res, _next) => {
    console.error("[server] unhandled error:", err);
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
```

Replace the whole of `server/src/index.js` with:

```js
import { createApp } from "./app.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";
import { currentPronProvider } from "./pron/index.js";

const app = createApp();

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()}, pron: ${currentPronProvider()})`,
  );
});
```

#### Step 10.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  7 passed (7)`, `Tests  86 passed (86)`.

#### Step 10.5 — Prove the real server still boots

```powershell
npm --prefix server start
```

Expected line, then Ctrl+C:

```
[server] SpeakUp API → http://localhost:3001  (brain: mock, voice: kokoro, stt: none, pron: mock)
```

`pron: mock` must appear. If the process exits with
`Error: Cannot find module ... .env`, create `server/.env` from `server/.env.example` first.

#### Step 10.6 — Commit

```powershell
git add server/src/app.js server/src/index.js server/src/app.test.js
git show :server/src/index.js | Select-String "createApp"
git show :server/src/app.js | Select-String "pron: currentPronProvider"
git commit -m "refactor(server): extract createApp and report pron in /health"
```

---

### Task 11: `GET /pron/prompts` — the route, with `focus` optional

**Files:**
- Create: `server/src/routes/pron.js`
- Modify: `server/src/app.js`
- Test: `server/src/routes/pron.test.js`

**Interfaces:**
- Consumes: `listPrompts` from `../pron/prompts.js`
- Produces: `export default router` (Express `Router`), mounted at `/pron`

#### Step 11.1 — Write the failing test

Create `server/src/routes/pron.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /pron/prompts — the curated set", () => {
  it("returns the full set when focus is omitted", async () => {
    const res = await request(createApp()).get("/pron/prompts");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.focuses).toEqual([
      "ih-iy",
      "ae",
      "schwa",
      "v-b",
      "dzh",
      "s-cluster",
      "ed-ending",
    ]);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(21);
    expect(res.body.prompts[0]).toMatchObject({ id: "ih-iy-01", focus: "ih-iy" });
  });

  it("filters by focus and keeps the focus list complete", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=schwa");
    expect(res.status).toBe(200);
    expect(res.body.prompts.every((p) => p.focus === "schwa")).toBe(true);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(3);
    expect(res.body.focuses).toHaveLength(7);
  });

  it("treats an empty focus as no filter", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=");
    expect(res.status).toBe(200);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(21);
  });

  it("400s an unknown focus with a typed code and the valid values", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=nasal");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
      code: "UNKNOWN_FOCUS",
    });
  });
});
```

#### Step 11.2 — See it fail

```powershell
npm --prefix server test
```

Expected: four failures in `src/routes/pron.test.js`, each
`expected 404 to be 200` (Express has no `/pron` mount yet).

#### Step 11.3 — Implement

Create `server/src/routes/pron.js`:

```js
import { Router } from "express";
import { listPrompts } from "../pron/prompts.js";

const router = Router();

/**
 * GET /pron/prompts
 * query: focus? (one of the slugs in content/drills.v1.json; omitted -> full set)
 * resp:  { version, updated, focuses, prompts }
 *
 * The server owns the drill set so M3/M4 can make it ledger-derived without
 * touching the client (design §4.1).
 */
router.get("/prompts", (req, res) => {
  const result = listPrompts({ focus: req.query?.focus });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, code: result.code });
  }
  return res.json(result.value);
});

export default router;
```

In `server/src/app.js`, add the import after the `turnRouter` import:

```js
import pronRouter from "./routes/pron.js";
```

and mount it directly after the turn router:

```js
  app.use("/turn", turnRouter);
  app.use("/pron", pronRouter);
```

#### Step 11.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  8 passed (8)`, `Tests  90 passed (90)`.

#### Step 11.5 — Commit

```powershell
git add server/src/routes/pron.js server/src/routes/pron.test.js server/src/app.js
git show :server/src/app.js | Select-String 'app.use\("/pron"'
git commit -m "feat(pron): GET /pron/prompts with optional focus filter"
```

---

### Task 12: `POST /pron/assess` — the happy path and every input rejection

**Files:**
- Modify: `server/src/routes/pron.js`
- Test: `server/src/routes/pron.test.js`

**Interfaces:**
- Consumes: `getPron`, `currentPronProvider` from `../pron/index.js`; `MAX_AUDIO_BYTES`,
  `PRON_ERROR_CODES`, `validateAssessInput`, `validateReport` from `../pron/contract.js`; `multer`
- Produces: `POST /pron/assess` on the existing default-exported router

#### Step 12.1 — Write the failing test

At the **top** of `server/src/routes/pron.test.js`, above the existing imports of `createApp`, add
the provider seam. `vi.mock` is hoisted, so the stub is in place before `createApp` is imported:

```js
import { MockPron } from "../pron/mock.js";
import { MAX_AUDIO_BYTES } from "../pron/contract.js";

const assess = vi.fn();
vi.mock("../pron/index.js", () => ({
  getPron: () => ({ assess: (...args) => assess(...args) }),
  currentPronProvider: () => "mock",
}));
```

Extend the existing `beforeEach` so each test starts on the real deterministic mock provider:

```js
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  assess.mockReset();
  assess.mockImplementation((buffer, opts) => new MockPron().assess(buffer, opts));
});
```

Append these describes:

```js
const AUDIO = Buffer.alloc(16000 * 2 * 2, 7); // 2 s of pseudo-PCM
const TEXT = "The ship is full of sheep.";

function post(app) {
  return request(app).post("/pron/assess");
}

describe("POST /pron/assess — scripted scoring", () => {
  it("returns a full report tagged with the provider and the requested mode", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "drill.webm", contentType: "audio/webm" });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.mode).toBe("scripted");
    expect(res.body.pronProvider).toBe("mock");
    expect(res.body.model).toBe("mock");
    expect(res.body.overall).toEqual({
      accuracy: expect.any(Number),
      fluency: expect.any(Number),
      completeness: 100,
    });
    expect(res.body.prosody.f0MinHz).toBeNull();
    expect(res.body.words.map((w) => w.word)).toEqual([
      "The",
      "ship",
      "is",
      "full",
      "of",
      "sheep",
    ]);
    expect(res.body.words[0].phones.length).toBeGreaterThan(0);
  });

  it("forwards the trimmed text, the mode and the uploaded bytes to the provider", async () => {
    await post(createApp())
      .field("text", `  ${TEXT}  `)
      .attach("audio", AUDIO, { filename: "take-3.ogg", contentType: "audio/ogg" });

    const [buffer, opts] = assess.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBe(AUDIO.length);
    expect(opts).toEqual({ text: TEXT, mode: "scripted", filename: "take-3.ogg" });
  });

  it("defaults the filename when the client sends an unnamed part", async () => {
    await post(createApp()).field("text", TEXT).attach("audio", AUDIO, { filename: "" });
    expect(assess.mock.calls[0][1].filename).toBe("drill.webm");
  });
});

describe("POST /pron/assess — input rejections", () => {
  it("400s a request with no audio part", async () => {
    const res = await post(createApp()).field("text", TEXT);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing "audio" file.', code: "MISSING_AUDIO" });
    expect(assess).not.toHaveBeenCalled();
  });

  it("400s a zero-byte audio part", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", Buffer.alloc(0), { filename: "empty.webm" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_AUDIO");
  });

  it("400s a missing or blank reference sentence", async () => {
    const res = await post(createApp())
      .field("text", "   ")
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Missing "text" (the reference sentence, non-empty string).',
      code: "MISSING_TEXT",
    });
  });

  it("400s a sentence over 300 characters", async () => {
    const res = await post(createApp())
      .field("text", "a".repeat(301))
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TEXT_TOO_LONG");
  });

  it("400s an unknown mode", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .field("mode", "freestyle")
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: '"mode" must be "scripted" or "unscripted".',
      code: "INVALID_MODE",
    });
    expect(assess).not.toHaveBeenCalled();
  });

  it("413s an oversized upload instead of falling through to the 500 handler", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", Buffer.alloc(MAX_AUDIO_BYTES + 1024), { filename: "huge.webm" });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: "That recording is too large. Keep drill takes under 15 MB.",
      code: "AUDIO_TOO_LARGE",
    });
    expect(assess).not.toHaveBeenCalled();
  });
});
```

#### Step 12.2 — See it fail

```powershell
npm --prefix server test
```

Expected: nine failures in `src/routes/pron.test.js`, the first being
`expected 404 to be 200` — the router has no `/assess` handler yet.

#### Step 12.3 — Implement

Replace `server/src/routes/pron.js` with:

```js
import { Router } from "express";
import multer from "multer";
import { getPron, currentPronProvider } from "../pron/index.js";
import { listPrompts } from "../pron/prompts.js";
import {
  MAX_AUDIO_BYTES,
  PRON_ERROR_CODES,
  validateAssessInput,
  validateReport,
} from "../pron/contract.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

/**
 * multer surfaces an oversized part as a MulterError. turn.js lets that fall
 * through to the global 500 handler; the drill needs the typed 413 so the
 * client can tell the learner to record a shorter take.
 */
function uploadSingleAudio(req, res, next) {
  upload.single("audio")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "That recording is too large. Keep drill takes under 15 MB.",
        code: PRON_ERROR_CODES.AUDIO_TOO_LARGE,
      });
    }
    return next(err);
  });
}

/**
 * POST /pron/assess
 * multipart/form-data: audio (file), text (reference sentence), mode? ("scripted"|"unscripted")
 * resp: { version, mode, pronProvider, model, overall, prosody, words }
 *
 * `mode` is the design §3 switch: scripted shows phonemes, unscripted never
 * does. Stripping happens here, for every provider, so no provider can leak.
 */
router.post("/assess", uploadSingleAudio, async (req, res) => {
  const check = validateAssessInput({
    text: req.body?.text,
    mode: req.body?.mode,
    audioBytes: req.file?.buffer?.length,
  });
  if (!check.ok) {
    return res.status(check.status).json({ error: check.error, code: check.code });
  }
  const { text, mode } = check.value;

  let report;
  try {
    report = await getPron().assess(req.file.buffer, {
      text,
      mode,
      filename: req.file.originalname || "drill.webm",
    });
  } catch (err) {
    console.error("[pron/assess] provider error:", err);
    return res.status(502).json({
      error: "Pronunciation scoring is offline. The drill continues as listen-and-repeat.",
      code: PRON_ERROR_CODES.PRON_UNAVAILABLE,
      detail: String(err?.message ?? err),
    });
  }

  const valid = validateReport(report);
  if (!valid.ok) {
    console.error("[pron/assess] provider error:", valid.error);
    return res.status(502).json({
      error: "The pronunciation scorer returned an unreadable report.",
      code: PRON_ERROR_CODES.BAD_REPORT,
      detail: valid.error,
    });
  }

  return res.json({ ...report, mode, pronProvider: currentPronProvider() });
});

/**
 * GET /pron/prompts
 * query: focus? (one of the slugs in content/drills.v1.json; omitted -> full set)
 * resp:  { version, updated, focuses, prompts }
 *
 * The server owns the drill set so M3/M4 can make it ledger-derived without
 * touching the client (design §4.1).
 */
router.get("/prompts", (req, res) => {
  const result = listPrompts({ focus: req.query?.focus });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, code: result.code });
  }
  return res.json(result.value);
});

export default router;
```

The typed mapping for sidecar-originated codes lands in Task 14; right now every provider throw
becomes a 502, which the 413/validation tests above do not exercise.

#### Step 12.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  8 passed (8)`, `Tests  99 passed (99)`.

The 413 case allocates 16 MB and takes ~1 s. If it instead returns 500 with
`error: "Internal server error."`, `uploadSingleAudio` is not wired — check that the route uses the
wrapper and not `upload.single("audio")` directly.

#### Step 12.5 — Commit

```powershell
git add server/src/routes/pron.js server/src/routes/pron.test.js
git show :server/src/routes/pron.js | Select-String "uploadSingleAudio"
git commit -m "feat(pron): POST /pron/assess with multer and input validation"
```

---

### Task 13: Unscripted mode strips `words[].phones` — the leak test

This is the enforcement point for design §3. The test below **fails if a single phone survives**,
for any provider, at any depth.

**Files:**
- Modify: `server/src/routes/pron.js`
- Test: `server/src/routes/pron.test.js`

**Interfaces:**
- Consumes: `stripPhones` from `../pron/contract.js`
- Produces: no new symbol — behavior change on `POST /pron/assess`

#### Step 13.1 — Write the failing test

Append to `server/src/routes/pron.test.js`:

```js
describe("POST /pron/assess — unscripted never carries phonemes (design §3)", () => {
  async function unscripted(app = createApp()) {
    return post(app)
      .field("text", TEXT)
      .field("mode", "unscripted")
      .attach("audio", AUDIO, { filename: "drill.webm" });
  }

  it("strips phones from every word", async () => {
    const res = await unscripted();
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("unscripted");
    expect(res.body.words.length).toBeGreaterThan(0);
    for (const word of res.body.words) {
      expect(word).not.toHaveProperty("phones");
    }
  });

  it("leaves no phone-shaped data anywhere in the serialized body", async () => {
    const res = await unscripted();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('"phones"');
    expect(raw).not.toContain('"ipa"');
    expect(raw).not.toContain('"substituted"');
  });

  it("keeps the word-level and overall numbers, which do not depend on phonemes", async () => {
    const res = await unscripted();
    for (const word of res.body.words) {
      expect(typeof word.word).toBe("string");
      expect(Number.isInteger(word.accuracy)).toBe(true);
      expect(word.end).toBeGreaterThanOrEqual(word.start);
    }
    expect(res.body.overall.completeness).toBe(100);
    expect(res.body.prosody.pauseCount).toBeGreaterThanOrEqual(0);
  });

  it("strips even when the provider ignores mode and returns phones anyway", async () => {
    assess.mockResolvedValue({
      version: 1,
      mode: "scripted",
      model: "rogue-provider",
      overall: { accuracy: 50, fluency: 50, completeness: 50 },
      prosody: {
        speechRateWpm: 100,
        articulationRateSyllPerSec: 4,
        pauseCount: 0,
        pauseTotalSec: 0,
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: [
        {
          word: "sheep",
          start: 0,
          end: 1,
          accuracy: 50,
          phones: [{ ipa: "iː", score: 12, start: 0, end: 1, substituted: "ɪ" }],
        },
      ],
    });

    const res = await unscripted();
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("substituted");
    expect(res.body.words[0]).toEqual({ word: "sheep", start: 0, end: 1, accuracy: 50 });
  });

  it("still returns phones in scripted mode — the strip is mode-gated, not global", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .field("mode", "scripted")
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.body.words[0].phones.length).toBeGreaterThan(0);
  });
});
```

#### Step 13.2 — See it fail

```powershell
npm --prefix server test
```

Expected: four failures, the first reading
`expected { word: 'The', start: 0, …, phones: [ … ] } not to have property "phones"`.

#### Step 13.3 — Implement

In `server/src/routes/pron.js`, add `stripPhones` to the contract import:

```js
import {
  MAX_AUDIO_BYTES,
  PRON_ERROR_CODES,
  stripPhones,
  validateAssessInput,
  validateReport,
} from "../pron/contract.js";
```

and replace the final `return res.json(...)` of the `/assess` handler with:

```js
  // Design §3: without a trustworthy reference text a per-phoneme score is a
  // fabricated number. Strip after validation, for every provider, always.
  const body = mode === "unscripted" ? stripPhones(report) : report;
  return res.json({ ...body, mode, pronProvider: currentPronProvider() });
```

#### Step 13.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  8 passed (8)`, `Tests  104 passed (104)`.

#### Step 13.5 — Commit

```powershell
git add server/src/routes/pron.js server/src/routes/pron.test.js
git show :server/src/routes/pron.js | Select-String "stripPhones\(report\)"
git commit -m "feat(pron): strip phonemes in unscripted mode for every provider"
```

---

### Task 14: The degradation ladder — typed provider failures instead of a blanket 502

Design §7: sidecar down must produce a typed error the client can turn into listen-and-repeat, while
a learner-caused failure (silence, unpronounceable text) must not be blamed on the service.

**Files:**
- Modify: `server/src/routes/pron.js`
- Test: `server/src/routes/pron.test.js`

**Interfaces:**
- Consumes: `PRON_ERROR_CODES`
- Produces: no new symbol — module-private `PROVIDER_ERROR_RESPONSES` in `routes/pron.js`

#### Step 14.1 — Write the failing test

Append to `server/src/routes/pron.test.js`:

```js
function providerThrows(code, message = "boom") {
  assess.mockRejectedValue(Object.assign(new Error(message), code ? { code } : {}));
}

describe("POST /pron/assess — degradation ladder (design §7)", () => {
  async function scripted() {
    return post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "drill.webm" });
  }

  it("502s with PRON_UNAVAILABLE when the sidecar is unreachable", async () => {
    providerThrows("PRON_UNAVAILABLE", "fetch failed");
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(
      "Pronunciation scoring is offline. The drill continues as listen-and-repeat.",
    );
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
    expect(res.body.detail).toBe("fetch failed");
    expect(console.error).toHaveBeenCalledWith("[pron/assess] provider error:", expect.any(Error));
  });

  it("502s with PRON_UNAVAILABLE when the failure carries no code at all", async () => {
    providerThrows(undefined, "TypeError: nope");
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
  });

  it("422s NO_SPEECH — silence is the learner's recording, not an outage", async () => {
    providerThrows("NO_SPEECH", "sidecar says silence");
    const res = await scripted();
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Couldn't make out any speech in that recording.",
      code: "NO_SPEECH",
      detail: "sidecar says silence",
    });
  });

  it("400s UNPRONOUNCEABLE_TEXT — the sentence is the problem, not the service", async () => {
    providerThrows("UNPRONOUNCEABLE_TEXT", "no tokens for 'xyzzy'");
    const res = await scripted();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Couldn't turn that sentence into phonemes. Try plain English words.",
      code: "UNPRONOUNCEABLE_TEXT",
      detail: "no tokens for 'xyzzy'",
    });
  });

  it("502s a sidecar code the Node layer does not map", async () => {
    providerThrows("DECODE_FAILED", "ffmpeg exit 1");
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
    expect(res.body.detail).toBe("ffmpeg exit 1");
  });

  it("502s BAD_REPORT when the provider returns something the contract rejects", async () => {
    assess.mockResolvedValue({ version: 1, overall: {}, words: [] });
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("The pronunciation scorer returned an unreadable report.");
    expect(res.body.code).toBe("BAD_REPORT");
    expect(res.body.detail).toContain("report.overall");
  });

  it("502s BAD_REPORT when a provider emits substituted: null", async () => {
    assess.mockResolvedValue({
      version: 1,
      mode: "scripted",
      model: "rogue",
      overall: { accuracy: 50, fluency: 50, completeness: 50 },
      prosody: {
        speechRateWpm: 100,
        articulationRateSyllPerSec: 4,
        pauseCount: 0,
        pauseTotalSec: 0,
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: [
        {
          word: "sheep",
          start: 0,
          end: 1,
          accuracy: 50,
          phones: [{ ipa: "iː", score: 90, start: 0, end: 1, substituted: null }],
        },
      ],
    });
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("BAD_REPORT");
  });

  it("logs exactly one provider error per failed request", async () => {
    providerThrows("PRON_UNAVAILABLE");
    await scripted();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
```

#### Step 14.2 — See it fail

```powershell
npm --prefix server test
```

Expected: two failures — `expected 502 to be 422` for the NO_SPEECH case and
`expected 502 to be 400` for UNPRONOUNCEABLE_TEXT. The other six pass already; that is the point of
writing them now, so the mapping change cannot silently break the paths that were already right.

#### Step 14.3 — Implement

In `server/src/routes/pron.js`, add this module-level constant directly below `uploadSingleAudio`:

```js
/**
 * Codes the sidecar raises about the *submission* rather than about itself.
 * Anything absent from this table is an outage from the learner's point of
 * view and degrades to listen-and-repeat (design §7).
 */
const PROVIDER_ERROR_RESPONSES = Object.freeze({
  [PRON_ERROR_CODES.NO_SPEECH]: {
    status: 422,
    error: "Couldn't make out any speech in that recording.",
  },
  [PRON_ERROR_CODES.UNPRONOUNCEABLE_TEXT]: {
    status: 400,
    error: "Couldn't turn that sentence into phonemes. Try plain English words.",
  },
});
```

and replace the `catch` block of the `/assess` handler with:

```js
  } catch (err) {
    console.error("[pron/assess] provider error:", err);
    const mapped = PROVIDER_ERROR_RESPONSES[err?.code];
    if (mapped) {
      return res.status(mapped.status).json({
        error: mapped.error,
        code: err.code,
        detail: String(err?.message ?? err),
      });
    }
    return res.status(502).json({
      error: "Pronunciation scoring is offline. The drill continues as listen-and-repeat.",
      code: PRON_ERROR_CODES.PRON_UNAVAILABLE,
      detail: String(err?.message ?? err),
    });
  }
```

#### Step 14.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files  8 passed (8)`, `Tests  112 passed (112)`.

#### Step 14.5 — Commit

```powershell
git add server/src/routes/pron.js server/src/routes/pron.test.js
git show :server/src/routes/pron.js | Select-String "PROVIDER_ERROR_RESPONSES"
git commit -m "feat(pron): typed degradation for sidecar and learner-side failures"
```

---

### Task 15: `BudgetGuard` — the persisted monthly spend counter

**Added 2026-07-28** (design spec §13): Azure is now a manually-selected, budget-capped runtime
supplement, not calibration-only. This task builds the piece that makes "capped" a real, enforced
ceiling rather than a comment: a monthly counter that survives a server restart.

**Files:**
- Create: `server/src/pron/budgetGuard.js`
- Test: `server/src/pron/budgetGuard.test.js`
- Modify: `server/vitest.config.js` — add `"src/pron/budgetGuard.js"` to `coverage.include`
- Modify: root `.gitignore` — add `server/.pron-budget.json` (the default state-file path; never
  committed, same convention as `.env`)

**Interfaces:**
- Consumes: `node:fs` only.
- Produces: `BudgetGuard` — `new BudgetGuard({ statePath, capUsd, ratePerHourUsd, now? })`,
  `.spentUsd(): number`, `.isOverCap(): boolean`, `.recordUsage(audioSeconds: number): void`. Task 16
  consumes this exact shape.

#### Step 15.1 — Write the failing tests

Create `server/src/pron/budgetGuard.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard } from "./budgetGuard.js";

let statePath;

beforeEach(() => {
  statePath = path.join(
    os.tmpdir(),
    `pron-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
});

afterEach(() => {
  fs.rmSync(statePath, { force: true });
});

function guard(overrides = {}) {
  return new BudgetGuard({
    statePath,
    capUsd: 12,
    ratePerHourUsd: 0.66,
    now: () => new Date("2026-07-15T12:00:00Z"),
    ...overrides,
  });
}

describe("BudgetGuard", () => {
  it("starts at zero spend when no state file exists", () => {
    const g = guard();
    expect(g.spentUsd()).toBe(0);
    expect(g.isOverCap()).toBe(false);
  });

  it("computes spend from recorded audio seconds at the configured rate", () => {
    const g = guard();
    g.recordUsage(3600); // 1 hour
    expect(g.spentUsd()).toBeCloseTo(0.66, 5);
  });

  it("accumulates usage across multiple recordUsage calls", () => {
    const g = guard();
    g.recordUsage(1800);
    g.recordUsage(1800);
    expect(g.spentUsd()).toBeCloseTo(0.66, 5);
  });

  it("reports over cap once accumulated spend meets the cap", () => {
    const g = guard({ capUsd: 1 });
    g.recordUsage((1 / 0.66) * 3600); // exactly $1 at $0.66/hr
    expect(g.isOverCap()).toBe(true);
  });

  it("reports under cap while spend remains below the cap", () => {
    const g = guard({ capUsd: 1 });
    g.recordUsage(1000);
    expect(g.isOverCap()).toBe(false);
  });

  it("persists usage across separate instances pointed at the same file", () => {
    guard().recordUsage(3600);
    const fresh = guard();
    expect(fresh.spentUsd()).toBeCloseTo(0.66, 5);
  });

  it("resets to zero when the persisted state belongs to a prior month", () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ month: "2020-01", audioSecondsUsed: 99999 }),
      "utf8",
    );
    const g = guard(); // now() is fixed at 2026-07
    expect(g.spentUsd()).toBe(0);
  });

  it("treats a corrupt state file as a fresh start rather than throwing", () => {
    fs.writeFileSync(statePath, "{not json", "utf8");
    expect(() => guard().spentUsd()).not.toThrow();
    expect(guard().spentUsd()).toBe(0);
  });

  it("clamps a negative or non-numeric usage value to zero rather than reducing the total", () => {
    const g = guard();
    g.recordUsage(3600);
    g.recordUsage(-500);
    g.recordUsage(NaN);
    expect(g.spentUsd()).toBeCloseTo(0.66, 5);
  });
});
```

#### Step 15.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Cannot find module './budgetGuard.js'` (or Vitest's equivalent phrasing) — the module does
not exist yet. Same root cause every "see it fail" step in this plan has hit; the exact wording is
not the point.

#### Step 15.3 — Implement

Create `server/src/pron/budgetGuard.js`:

```js
import fs from "node:fs";

/**
 * Tracks cumulative audio-seconds submitted to a metered pronunciation
 * provider (Azure) during the current calendar month, backed by a small
 * JSON file — not the database, which M3 owns. Deliberately lock-free: a
 * personal, single-process app accepts a few seconds of overshoot under a
 * race rather than the locking scheme a multi-tenant billing system would
 * need. See design spec §13.2.
 */
export class BudgetGuard {
  /**
   * @param {{statePath: string, capUsd: number, ratePerHourUsd: number, now?: () => Date}} opts
   */
  constructor({ statePath, capUsd, ratePerHourUsd, now = () => new Date() }) {
    this.statePath = statePath;
    this.capUsd = capUsd;
    this.ratePerHourUsd = ratePerHourUsd;
    this.now = now;
  }

  _monthKey() {
    const d = this.now();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  _readState() {
    const month = this._monthKey();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (parsed.month === month && typeof parsed.audioSecondsUsed === "number") {
        return { month, audioSecondsUsed: parsed.audioSecondsUsed };
      }
    } catch {
      // missing file, corrupt JSON, or a prior month — start this month fresh.
    }
    return { month, audioSecondsUsed: 0 };
  }

  _writeState(state) {
    fs.writeFileSync(this.statePath, JSON.stringify(state), "utf8");
  }

  /** Estimated dollars spent so far this calendar month, at the configured rate. */
  spentUsd() {
    const { audioSecondsUsed } = this._readState();
    return (audioSecondsUsed / 3600) * this.ratePerHourUsd;
  }

  /** True once this month's estimated spend has met or passed the cap. */
  isOverCap() {
    return this.spentUsd() >= this.capUsd;
  }

  /** Record actual audio seconds billed for one completed metered call. */
  recordUsage(audioSeconds) {
    const state = this._readState();
    state.audioSecondsUsed += Math.max(0, Number(audioSeconds) || 0);
    this._writeState(state);
  }
}
```

In `server/vitest.config.js`, add `"src/pron/budgetGuard.js"` to the `coverage.include` array
(alongside the existing seven entries).

In the repo root `.gitignore`, add one line near the existing `.env` patterns:

```
server/.pron-budget.json
```

#### Step 15.4 — See it pass

```powershell
npm --prefix server test
```

Expected: all prior tests still pass, plus 9 new passing tests in `budgetGuard.test.js`.

#### Step 15.5 — Commit

```powershell
git add server/src/pron/budgetGuard.js server/src/pron/budgetGuard.test.js server/vitest.config.js .gitignore
git show :server/src/pron/budgetGuard.js | Select-String "class BudgetGuard"
git commit -m "feat(pron): BudgetGuard — persisted monthly spend counter for metered providers"
```

---

### Task 16: `BudgetCappedPron` — the decorator that enforces the cap without breaking degradation

**Files:**
- Create: `server/src/pron/budgetCappedPron.js`
- Test: `server/src/pron/budgetCappedPron.test.js`
- Modify: `server/vitest.config.js` — add `"src/pron/budgetCappedPron.js"` to `coverage.include`

**Interfaces:**
- Consumes: `BudgetGuard` (Task 15) by shape (`.isOverCap()`, `.recordUsage()`), not by import — any
  object with that shape works, which is what the tests exercise directly with stand-ins.
- Produces: `BudgetCappedPron` — `new BudgetCappedPron(metered, fallback, guard)`, `.assess(audioBuffer,
  opts): Promise<PronunciationReport>`, `.health(): Promise<object>`. Task 17 consumes this
  constructor signature directly.

**The property that matters (design §13.2):** a spending cap and a provider outage are different
failure classes. Over cap → silently serve the fallback (principle #3, "degrade, never break" — a
`mock`-labelled report is honest). A real provider error (bad key, network down) must **propagate**,
not be swallowed into a silent fallback — that path already 502s per Task 14, and a mocked score
standing in for a claimed-real one would be dishonest in a way self-imposed budgeting is not.

#### Step 16.1 — Write the failing tests

Create `server/src/pron/budgetCappedPron.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetCappedPron } from "./budgetCappedPron.js";
import { BudgetGuard } from "./budgetGuard.js";

function stubProvider(reportOverrides = {}) {
  return {
    assess: vi.fn().mockResolvedValue({ pronProvider: "azure", durationSec: 4.2, ...reportOverrides }),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubGuard(isOverCap = false) {
  return { isOverCap: vi.fn().mockReturnValue(isOverCap), recordUsage: vi.fn() };
}

describe("BudgetCappedPron", () => {
  it("delegates to the metered provider while under cap", async () => {
    const metered = stubProvider();
    const fallback = stubProvider({ pronProvider: "mock" });
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(false));
    const report = await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(metered.assess).toHaveBeenCalledWith(Buffer.from("x"), { text: "hi" });
    expect(fallback.assess).not.toHaveBeenCalled();
    expect(report.pronProvider).toBe("azure");
  });

  it("delegates to the fallback provider once over cap", async () => {
    const metered = stubProvider();
    const fallback = stubProvider({ pronProvider: "mock" });
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(true));
    const report = await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(fallback.assess).toHaveBeenCalledWith(Buffer.from("x"), { text: "hi" });
    expect(metered.assess).not.toHaveBeenCalled();
    expect(report.pronProvider).toBe("mock");
  });

  it("records the metered call's actual reported duration on success", async () => {
    const metered = stubProvider({ durationSec: 7.5 });
    const guard = stubGuard(false);
    const wrapped = new BudgetCappedPron(metered, stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).toHaveBeenCalledWith(7.5);
  });

  it("does not record usage when the metered report carries no durationSec", async () => {
    const metered = { assess: vi.fn().mockResolvedValue({ pronProvider: "azure" }), health: vi.fn() };
    const guard = stubGuard(false);
    const wrapped = new BudgetCappedPron(metered, stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).not.toHaveBeenCalled();
  });

  it("does not record usage on the fallback path — fallback calls are not metered", async () => {
    const guard = stubGuard(true);
    const wrapped = new BudgetCappedPron(stubProvider(), stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).not.toHaveBeenCalled();
  });

  it("propagates a metered provider's own failure rather than silently falling back", async () => {
    const metered = {
      assess: vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: "PRON_UNAVAILABLE" })),
      health: vi.fn(),
    };
    const fallback = stubProvider();
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(false));
    await expect(wrapped.assess(Buffer.from("x"), { text: "hi" })).rejects.toMatchObject({
      code: "PRON_UNAVAILABLE",
    });
    expect(fallback.assess).not.toHaveBeenCalled();
  });

  it("reports health from the metered provider, not the fallback", async () => {
    const metered = stubProvider();
    metered.health.mockResolvedValue({ ok: true, note: "azure" });
    const fallback = stubProvider();
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(false));
    const health = await wrapped.health();
    expect(health).toEqual({ ok: true, note: "azure" });
    expect(fallback.health).not.toHaveBeenCalled();
  });

  describe("integration with a real BudgetGuard", () => {
    let statePath;
    beforeEach(() => {
      statePath = path.join(
        os.tmpdir(),
        `pron-budget-cap-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
    });
    afterEach(() => {
      fs.rmSync(statePath, { force: true });
    });

    it("switches from metered to fallback once real recorded usage crosses the cap", async () => {
      // ratePerHourUsd chosen so that $1 of cap equals exactly 1 second of usage.
      const guard = new BudgetGuard({ statePath, capUsd: 1, ratePerHourUsd: 3600 });
      const metered = stubProvider({ durationSec: 2 }); // one call already exceeds the $1 cap
      const fallback = stubProvider({ pronProvider: "mock" });
      const wrapped = new BudgetCappedPron(metered, fallback, guard);

      const first = await wrapped.assess(Buffer.from("x"), { text: "hi" });
      expect(first.pronProvider).toBe("azure");

      const second = await wrapped.assess(Buffer.from("x"), { text: "hi" });
      expect(second.pronProvider).toBe("mock");
      expect(metered.assess).toHaveBeenCalledTimes(1);
    });
  });
});
```

#### Step 16.2 — See it fail

```powershell
npm --prefix server test
```

Expected: `Cannot find module './budgetCappedPron.js'`.

#### Step 16.3 — Implement

Create `server/src/pron/budgetCappedPron.js`:

```js
/**
 * Wraps a metered provider (Azure) with a monthly spend guard. Before
 * delegating, refuses to spend further once the guard reports over cap and
 * serves `fallback` instead — silently, from the caller's point of view, per
 * principle #3 ("degrade, never break"). This is a spending policy, not an
 * outage: unlike a real provider failure (which still 502s per design §7 /
 * Task 14), falling back to a legitimate, documented provider is honest — the
 * returned report's own `pronProvider` field says so. After a successful
 * metered call, records the provider's own reported `durationSec` as actual
 * usage, avoiding the need to probe audio duration before sending.
 */
export class BudgetCappedPron {
  constructor(metered, fallback, guard) {
    this.metered = metered;
    this.fallback = fallback;
    this.guard = guard;
  }

  async assess(audioBuffer, opts) {
    if (this.guard.isOverCap()) {
      return this.fallback.assess(audioBuffer, opts);
    }
    const report = await this.metered.assess(audioBuffer, opts);
    if (typeof report?.durationSec === "number") {
      this.guard.recordUsage(report.durationSec);
    }
    return report;
  }

  async health() {
    return this.metered.health();
  }
}
```

In `server/vitest.config.js`, add `"src/pron/budgetCappedPron.js"` to `coverage.include`.

#### Step 16.4 — See it pass

```powershell
npm --prefix server test
```

Expected: all prior tests pass, plus 8 new passing tests in `budgetCappedPron.test.js`.

#### Step 16.5 — Commit

```powershell
git add server/src/pron/budgetCappedPron.js server/src/pron/budgetCappedPron.test.js server/vitest.config.js
git show :server/src/pron/budgetCappedPron.js | Select-String "class BudgetCappedPron"
git commit -m "feat(pron): BudgetCappedPron — degrade to mock over budget, never mask a real failure"
```

---

### Task 17: Wire the budget cap into `getPron()`, and correct the now-stale "never runtime" comments

**This task touches Task 8's already-approved, mutation-tested factory.** Its guarantee — "Azure is
never selected by accident; `PRON_PROVIDER` must explicitly equal `\"azure\"`" — is **preserved
exactly**, and no existing test of that guarantee is weakened. What changes is only what happens
*inside* the already-true "explicit azure" branch: it now returns a spend-capped wrapper instead of
a raw `AzurePron`.

**Files:**
- Modify: `server/src/pron/index.js`
- Modify: `server/src/pron/index.test.js` — one existing assertion is deliberately changed; see Step
  17.1's note.
- Modify: `server/src/pron/azure.js` — one line of the header comment (documentation only; no
  behavioural change; `azure.test.js` needs no change)

**Interfaces:**
- Consumes: `BudgetGuard` (Task 15), `BudgetCappedPron` (Task 16).
- Produces: no new export. `getPron()`'s return type note gains `BudgetCappedPron` as a possible
  concrete type when `PRON_PROVIDER=azure`; `currentPronProvider()`'s contract (`"local"|"mock"|"azure"`)
  is unchanged — it still reports the *configured* provider, not the wrapper's internal state.

#### Step 17.1 — Write the failing tests

In `server/src/pron/index.test.js`, first **replace** the existing test at (current) lines 49-57:

```js
  it("selects azure only when a key is present", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "secret",
    });
    const { AzurePron } = await import("./azure.js");
    expect(getPron()).toBeInstanceOf(AzurePron);
    expect(currentPronProvider()).toBe("azure");
  });
```

with:

```js
  it("wraps azure in a spend guard when a key is present, keeping the reported provider name honest", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "secret",
    });
    const { AzurePron } = await import("./azure.js");
    const { MockPron } = await import("./mock.js");
    const { BudgetCappedPron } = await import("./budgetCappedPron.js");
    const pron = getPron();
    expect(pron).toBeInstanceOf(BudgetCappedPron);
    expect(pron.metered).toBeInstanceOf(AzurePron);
    expect(pron.fallback).toBeInstanceOf(MockPron);
    expect(currentPronProvider()).toBe("azure");
  });
```

This is a deliberate change to a previously-approved assertion, not a weakening: the property it
protects — "explicit `PRON_PROVIDER=azure` + a key selects Azure" — still holds; it is now expressed
against the wrapper type the design requires, with the wrapped instances checked explicitly so the
old guarantee is not merely renamed away.

Then **append** these new tests to the same `describe("pron factory — provider resolution", ...)`
block:

```js
  it("reads the azure spend cap, rate, and state-file path from env", async () => {
    const { getPron } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "secret",
      PRON_AZURE_MONTHLY_CAP_USD: "5",
      PRON_AZURE_RATE_PER_HOUR_USD: "1.5",
      PRON_BUDGET_STATE_FILE: "C:/tmp/test-budget.json",
    });
    const pron = getPron();
    expect(pron.guard.capUsd).toBe(5);
    expect(pron.guard.ratePerHourUsd).toBe(1.5);
    expect(pron.guard.statePath).toBe("C:/tmp/test-budget.json");
  });

  it("defaults the azure spend cap, rate, and state-file path when unset", async () => {
    const { getPron } = await loadPron({ PRON_PROVIDER: "azure", AZURE_SPEECH_KEY: "secret" });
    const pron = getPron();
    expect(pron.guard.capUsd).toBe(12);
    expect(pron.guard.ratePerHourUsd).toBe(0.66);
    expect(pron.guard.statePath).toBe(".pron-budget.json");
  });

  it("respects an explicit zero cap rather than silently substituting the default", async () => {
    // `0 || default` would wrongly discard an intentional "spend nothing" cap — this pins that.
    const { getPron } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "secret",
      PRON_AZURE_MONTHLY_CAP_USD: "0",
    });
    expect(getPron().guard.capUsd).toBe(0);
  });
```

None of this touches the test at (current) lines 80-89, `"never auto-selects azure from
AZURE_SPEECH_KEY presence alone"` — that path never reaches the `provider === "azure"` branch this
task changes, and it must still pass unmodified.

Also add these three env keys to the existing `beforeEach` cleanup block (lines 14-19 today) so they
cannot leak between test files:

```js
  delete process.env.PRON_AZURE_MONTHLY_CAP_USD;
  delete process.env.PRON_AZURE_RATE_PER_HOUR_USD;
  delete process.env.PRON_BUDGET_STATE_FILE;
```

None of these new cases call `.assess()` on the constructed provider, so `BudgetGuard`'s file I/O
(which only happens inside `spentUsd()`/`isOverCap()`/`recordUsage()`, never in its constructor) is
never triggered — these tests read config properties only and cannot leave a stray file behind.

#### Step 17.2 — See it fail

```powershell
npm --prefix server test
```

Expected: the rewritten test fails (`getPron()` still returns a raw `AzurePron`, not a
`BudgetCappedPron`); the three new tests fail (`pron.guard` is `undefined`).

#### Step 17.3 — Implement

In `server/src/pron/index.js`, replace the whole file with:

```js
import { MockPron } from "./mock.js";
import { LocalPron } from "./local.js";
import { AzurePron } from "./azure.js";
import { BudgetGuard } from "./budgetGuard.js";
import { BudgetCappedPron } from "./budgetCappedPron.js";

/**
 * Pluggable pronunciation-assessment factory (design §4.1, amended §13).
 *   local -> score via the sidecar container on :8899 (CAPT pipeline)
 *   mock  -> deterministic offline pseudo-scores, $0, no Docker (default)
 *   azure -> a manually-selected, budget-capped supplement (design §13) —
 *            still requires an explicit PRON_PROVIDER=azure + a key; wrapped
 *            in BudgetCappedPron, which falls back to mock once the monthly
 *            spend cap (PRON_AZURE_MONTHLY_CAP_USD) is met. Never the default,
 *            never selected by key presence alone.
 * Swap with PRON_PROVIDER in server/.env.
 */
let _pron = null;
let _provider = null;

const DEFAULT_AZURE_CAP_USD = 12;
const DEFAULT_AZURE_RATE_PER_HOUR_USD = 0.66;
const DEFAULT_BUDGET_STATE_FILE = ".pron-budget.json";

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveProvider() {
  const explicit = process.env.PRON_PROVIDER?.trim().toLowerCase();
  const hasAzureKey = !!process.env.AZURE_SPEECH_KEY?.trim();

  let provider = explicit || "mock";

  if (provider === "azure" && !hasAzureKey) {
    console.warn("[pron] PRON_PROVIDER=azure but AZURE_SPEECH_KEY is missing → falling back to mock.");
    provider = "mock";
  }
  if (provider !== "local" && provider !== "mock" && provider !== "azure") {
    console.warn(`[pron] unknown PRON_PROVIDER="${provider}" → falling back to mock.`);
    provider = "mock";
  }
  return provider;
}

function buildAzurePron() {
  const guard = new BudgetGuard({
    statePath: process.env.PRON_BUDGET_STATE_FILE?.trim() || DEFAULT_BUDGET_STATE_FILE,
    capUsd: numberEnv("PRON_AZURE_MONTHLY_CAP_USD", DEFAULT_AZURE_CAP_USD),
    ratePerHourUsd: numberEnv("PRON_AZURE_RATE_PER_HOUR_USD", DEFAULT_AZURE_RATE_PER_HOUR_USD),
  });
  return new BudgetCappedPron(new AzurePron(), new MockPron(), guard);
}

/**
 * @returns {MockPron|LocalPron|BudgetCappedPron} never null — the drill always has a scorer to call
 */
export function getPron() {
  if (_pron) return _pron;
  _provider = resolveProvider();
  _pron =
    _provider === "local"
      ? new LocalPron()
      : _provider === "azure"
        ? buildAzurePron()
        : new MockPron();
  console.log(`[pron] provider = ${_provider}`);
  return _pron;
}

/**
 * @returns {"local"|"mock"|"azure"}
 */
export function currentPronProvider() {
  if (!_provider) getPron();
  return _provider;
}
```

The `numberEnv` helper exists specifically so `PRON_AZURE_MONTHLY_CAP_USD=0` is respected (`0` is a
valid, deliberate "spend nothing" cap) rather than being treated as falsy and silently replaced by
the default — a plain `Number(x) || fallback` pattern would get this wrong.

In `server/src/pron/azure.js`, change only the first sentence of the header comment (line 4) from:

```
 * Azure Speech pronunciation-assessment adapter — CALIBRATION ONLY (design §2,
 * "Cloud as a runtime path" is a non-goal). This class enforces presence of
```

to:

```
 * Azure Speech pronunciation-assessment adapter — a manually-selected,
 * budget-capped runtime supplement (design §13), never the default and never
 * auto-selected. Wrapped in BudgetCappedPron by the factory (./index.js) when
 * explicitly chosen. This class enforces presence of
```

Leave the rest of that docblock (the "EXTERNAL CALL SITE — verified 2026-07-27" research notes and
everything below) untouched — that content is still accurate and still valuable.

#### Step 17.4 — See it pass

```powershell
npm --prefix server test
```

Expected: `Test Files 9 passed (9)`, all tests passing (the exact total is not worth hand-computing
here — several earlier tasks' predicted counts drifted from reality without indicating a problem;
what matters is zero failures).

#### Step 17.5 — Commit

```powershell
git add server/src/pron/index.js server/src/pron/index.test.js server/src/pron/azure.js
git show :server/src/pron/index.js | Select-String "buildAzurePron"
git commit -m "feat(pron): wire the spend cap into the factory; correct now-stale never-runtime comments"
```

---

### Task 18: Document the slot in `server/.env.example`

**Files:**
- Modify: `server/.env.example`
- Test: none — this file has no runtime reader. It is verified by the boot check in Step 15.3.

**Interfaces:**
- Consumes: nothing.
- Produces: documented env surface `PRON_PROVIDER`, `PRON_URL`, `PRON_TIMEOUT_MS`,
  `PRON_AZURE_MONTHLY_CAP_USD`, `PRON_AZURE_RATE_PER_HOUR_USD`, `PRON_BUDGET_STATE_FILE`, plus
  commented `PRON_MODEL`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_LOCALE`.

#### Step 18.1 — Edit

In `server/.env.example`, insert this block between the STT section (ends at
`# STT_PROVIDER=voicebox`) and `# --- Voicebox ---`, separated by one blank line on each side:

```
# --- Pronunciation (CAPT; consumed by POST /pron/assess) ---
# mock   -> deterministic offline pseudo-scores, $0, no Docker (default)
# local  -> score via the pronunciation sidecar container on :8899
# azure  -> a manually-selected, budget-capped supplement (design §13) — never
#           the default, never auto-selected by key presence alone. Wrapped in
#           a spend guard: once PRON_AZURE_MONTHLY_CAP_USD is met this month,
#           calls silently fall back to mock (degrade, never break).
PRON_PROVIDER=mock
PRON_URL=http://localhost:8899
PRON_TIMEOUT_MS=30000
# --- Azure spend guard (only consulted when PRON_PROVIDER=azure) ---
PRON_AZURE_MONTHLY_CAP_USD=12
PRON_AZURE_RATE_PER_HOUR_USD=0.66
PRON_BUDGET_STATE_FILE=.pron-budget.json
# Read by the SIDECAR container, not by the Node server. Listed here so the
# whole pron config lives in one place.
# PRON_MODEL=facebook/wav2vec2-lv-60-espeak-cv-ft
# AZURE_SPEECH_KEY=            # required to select PRON_PROVIDER=azure at all
# AZURE_SPEECH_REGION=westeurope
# AZURE_SPEECH_LOCALE=en-US
```

`PRON_PROVIDER=mock` — not `local` — is deliberate: the shipped default must let `npm run dev` work
with no Docker running. The spec's §4.1 sample shows `local`; §7's "PRON_PROVIDER unset → mock"
governs the default.

#### Step 18.2 — Verify the example is still parseable by Node's env loader

```powershell
Copy-Item server/.env.example $env:TEMP/pron-env-check.env -Force
node --env-file=$env:TEMP/pron-env-check.env -e "console.log(process.env.PRON_PROVIDER, process.env.PRON_URL, process.env.PRON_TIMEOUT_MS, process.env.PRON_AZURE_MONTHLY_CAP_USD, process.env.PRON_AZURE_RATE_PER_HOUR_USD, process.env.PRON_BUDGET_STATE_FILE)"
Remove-Item $env:TEMP/pron-env-check.env
```

Expected: `mock http://localhost:8899 30000 12 0.66 .pron-budget.json`.

#### Step 18.3 — Verify the running server picks it up

```powershell
Copy-Item server/.env.example server/.env -Force   # skip if server/.env already exists and you want to keep it
npm --prefix server start
```

Expected banner, then Ctrl+C:

```
[server] SpeakUp API → http://localhost:3001  (brain: mock, voice: kokoro, stt: none, pron: mock)
```

Then, in a second terminal while the server runs:

```powershell
curl.exe -s http://localhost:3001/health
curl.exe -s "http://localhost:3001/pron/prompts?focus=ih-iy"
curl.exe -s "http://localhost:3001/pron/prompts?focus=bogus"
```

Expected, respectively: a body containing `"pron":"mock"`; a body whose `prompts` array holds only
`ih-iy-*` entries; and `{"error":"Unknown \"focus\". Valid values: ...","code":"UNKNOWN_FOCUS"}`.

`server/.env` is gitignored — confirm with `git status --short server/.env`, which must print
nothing.

#### Step 18.4 — Commit

```powershell
git add server/.env.example
git show :server/.env.example | Select-String "PRON_AZURE_MONTHLY_CAP_USD"
git commit -m "docs(server): document the pronunciation env slot, including the azure spend cap"
```

---

### Task 19: Close the milestone's server surface — full suite and coverage gate

`server/vitest.config.js` sets 80 % thresholds over the nine pron source files (the original seven —
`contract.js`, `index.js`, `local.js`, `mock.js`, `azure.js`, `prompts.js`, `routes/pron.js` — plus
`budgetGuard.js` and `budgetCappedPron.js` from Tasks 15–16). This task proves the gate is met and
that nothing untracked crept in.

**Files:**
- Modify: none expected. If coverage fails, modify the test file the report names.
- Test: the whole server suite.

**Interfaces:**
- Consumes: everything built above.
- Produces: nothing new.

#### Step 19.1 — Run the coverage gate

```powershell
npm --prefix server run test:coverage
```

Expected: a table listing all nine files in `coverage.include` (`src/pron/contract.js`,
`src/pron/index.js`, `src/pron/local.js`, `src/pron/mock.js`, `src/pron/azure.js`,
`src/pron/prompts.js`, `src/pron/budgetGuard.js`, `src/pron/budgetCappedPron.js`,
`src/routes/pron.js`), every column ≥ 80, and no
`ERROR: Coverage for lines (…) does not meet global threshold (80%)` line.

If a threshold fails, the report names the uncovered lines. Add the missing case to the
corresponding `*.test.js` and re-run — do not lower the threshold and do not add the file to an
exclude list.

#### Step 19.2 — Run both suites the way CI would

```powershell
npm test
```

Expected: the server suite passes with zero failures (the exact total has drifted from every
predicted figure in this plan without indicating a problem — do not treat a different number as a
failure by itself), then the client suite runs and its existing 93 tests still pass. The client
suite is untouched by this chunk; a failure there means a sibling chunk's work is half-landed, not
this one's.

#### Step 19.3 — Prove the working tree is clean

```powershell
git status --short
```

Expected: empty, or entries only under `sidecar/`, `tools/`, or `client/` belonging to sibling
chunks. **Nothing under `server/` may be untracked or modified.** If `server/` shows anything,
find out which task's commit missed a path and amend that commit with the explicit path — this is
exactly the failure mode design §11 records.

#### Step 19.4 — No commit

This task produces no commit if everything passes. If Step 19.1 required a new test case:

```powershell
# Coverage can only be short in these six files. The report names one; map it to its test file:
#   src/pron/contract.js         -> server/src/pron/contract.test.js
#   src/pron/index.js            -> server/src/pron/index.test.js
#   src/pron/local.js            -> server/src/pron/local.test.js
#   src/pron/mock.js             -> server/src/pron/mock.test.js
#   src/pron/azure.js            -> server/src/pron/azure.test.js
#   src/pron/prompts.js          -> server/src/pron/prompts.test.js
#   src/pron/budgetGuard.js      -> server/src/pron/budgetGuard.test.js
#   src/pron/budgetCappedPron.js -> server/src/pron/budgetCappedPron.test.js
#   src/routes/pron.js           -> server/src/routes/pron.test.js
# Example, for a gap reported in src/pron/contract.js:
git add server/src/pron/contract.test.js
git show :server/src/pron/contract.test.js | Select-String "it("
git commit -m "test(pron): cover the remaining branches in contract.js"
```

