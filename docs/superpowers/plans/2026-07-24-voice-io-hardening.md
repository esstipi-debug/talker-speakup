# Voice I/O Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SpeakUp's hybrid voice loop (kokoro-fastapi TTS + browser Web Speech STT) trustworthy end-to-end — live interim → review/edit → send, with barge-in, replay, and clear status/error feedback — before building the grammar layer.

**Architecture:** Extract all conversation orchestration out of the 305-line `App.jsx` into a `useConversation` hook implementing an explicit state machine (`idle→listening→review→thinking→speaking→idle`). The recognizer runs `continuous=true`; the hook accumulates finalized chunks + a live interim tail into an editable `draft`. A single playback controller owns the coach-audio element and the speak-timeout so barge-in/replay can't desync. Server changes are config-only (`/turn` already returns audio).

**Tech Stack:** React 19, Vite 8, plain JS (`.jsx`/`.js`, no TypeScript), Vitest + React Testing Library + jsdom, Web Speech API, kokoro-fastapi (Docker), Express.

**Spec:** `docs/superpowers/specs/2026-07-24-voice-io-hardening-design.md`

## Global Constraints

- **Language/stack:** plain JavaScript in `.jsx`/`.js` (the client intentionally avoids TypeScript); React 19; Vite 8.
- **STT config:** `STT_PROVIDER` **unset** this milestone → client uses the browser recognizer only. Do NOT wire client Ruta B (server STT) — it is dormant on disk for M7.
- **TTS config:** `TTS_PROVIDER=kokoro`, `KOKORO_URL=http://localhost:8880/v1`, `KOKORO_VOICE=af_heart`, `KOKORO_FORMAT=mp3`.
- **Recognizer:** `continuous=true`, `interimResults=true`, `maxAlternatives=1`, `lang="en-US"`.
- **Coverage gate:** ≥80% (lines/functions/branches/statements) measured **only** on `client/src/hooks/useConversation.js` + `client/src/lib/speech.js` (via `coverage.include`). Components verified by Browser-pane E2E + a11y checks, not the line gate.
- **Style:** immutable state updates (spread, never mutate); files focused (<800 lines, target 200–400); no `console.log` in committed client code; JSDoc where it clarifies public functions.
- **Accessibility (required):** `aria-live="polite"` status region; `role="alert"` on error/fallback banners; focus management on `review` enter/exit; action-oriented MicButton `aria-label`; `prefers-reduced-motion` guard.
- **Commits:** conventional commits (`feat:`, `test:`, `chore:`, `refactor:`, `docs:`). Attribution is disabled globally — do **not** add co-author trailers.
- **Error surface model:** the hook's single `error` string carries transient per-turn failures (Brain 502, empty draft, Web Speech `no-speech`/`network`, mic permission); VoiceStatus renders derived capability/status (no-Web-Speech, live status); a sticky derived indicator (`ttsFallbackActive`) reflects the TTS fallback (browser voice in use) until a later turn returns real coach audio. Mic-permission-denied lives in `error` only (not duplicated).

## File Structure

**New:**
- `client/vitest.config.js` — Vitest config (jsdom, scoped coverage).
- `client/src/test/setup.js` — jsdom global stubs (SpeechRecognition, speechSynthesis, SpeechSynthesisUtterance, HTMLMediaElement) + RTL cleanup; exports test helpers.
- `client/src/hooks/useConversation.js` — the state machine + all orchestration.
- `client/src/hooks/useConversation.test.js` — unit tests for the hook.
- `client/src/lib/speech.test.js` — unit tests for recognizer + playback helpers.
- `client/src/components/TranscriptReview.jsx` — editable review textarea (Send/Re-record/Cancel).
- `client/src/components/TranscriptReview.test.jsx` — unit tests (Task 6).
- `client/src/components/VoiceStatus.jsx` — status line + banners (aria-live, role=alert).
- `client/src/components/VoiceStatus.test.jsx` — unit tests (Task 7).
- `client/src/components/MicButton.test.jsx` — unit tests (Task 8).
- `client/src/App.test.jsx` — App-level focus-return test (Task 9).
- `client/src/components/__a11y__.test.jsx` — axe checks across states.

**Modified:**
- `server/.env` — switch to kokoro, unset STT.
- `server/.env.example`, `server/src/stt/index.js` — refresh stale STT docs.
- `client/package.json` — test deps + scripts.
- `client/src/lib/speech.js` — recognizer (continuous/interim/onInterim/onStart), new-final-chunk emission.
- `client/src/components/MicButton.jsx` — listening/interim + barge-in aria-label.
- `client/src/components/StatHeader.jsx` — TTS badge title → "configured coach voice".
- `client/src/index.css` — reduced-motion guard.
- `client/src/App.jsx` — slim to consume the hook; remove Ruta B; wire components; aria-live; gate replay to idle.

**Untouched (dormant, M7):** `server/src/routes/turn.js` `/turn/audio`, `server/src/stt/voicebox.js`, `client/src/lib/audio.js`, `client/src/lib/api.js postTurnAudio`.

---

## Task 1: Bring up kokoro-fastapi and switch server config

**Files:**
- Modify: `server/.env`
- Modify: `server/.env.example`
- Modify: `server/src/stt/index.js:3-9` (stale comment)

**Interfaces:**
- Produces: a running TTS backend at `http://localhost:8880/v1` and a server reporting `tts=kokoro`, `stt=none` at `/health`. Later tasks assume `postTurn` can return real `audio`.

- [ ] **Step 1: Start kokoro-fastapi on :8880**

Run (Docker; CPU image — adjust tag if a GPU image is preferred):
```bash
docker run -d --name kokoro-fastapi -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```
Expected: container starts. If the image/tag differs in this environment, use whatever kokoro-fastapi image is available so long as it serves the OpenAI-compatible `/v1/audio/speech` endpoint on `:8880`.

- [ ] **Step 2: Smoke-test the TTS endpoint**

Run:
```bash
curl -s -o /tmp/kokoro-smoke.mp3 -w "%{http_code}\n" http://localhost:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","voice":"af_heart","input":"Hello from SpeakUp.","response_format":"mp3"}'
```
Expected: prints `200` and `/tmp/kokoro-smoke.mp3` is a non-empty MP3 (`ls -l /tmp/kokoro-smoke.mp3` > 0 bytes). If this fails, the break-glass path is TTS via the already-running voicebox container or browser voice — but resolve kokoro before proceeding since the whole milestone targets it.

- [ ] **Step 3: Switch `server/.env` to the target config**

Set exactly these values (replace the current `TTS_PROVIDER=voicebox` / `STT_PROVIDER=voicebox` block):
```
TTS_PROVIDER=kokoro
KOKORO_URL=http://localhost:8880/v1
KOKORO_VOICE=af_heart
KOKORO_MODEL=kokoro
KOKORO_FORMAT=mp3

# STT unset -> client uses browser Web Speech (Ruta A)
# STT_PROVIDER=
```
Leave `MISTRAL_API_KEY`/brain and `DATABASE_URL`/`PORT` as they are. `VOICEBOX_*` vars may remain (inert).

- [ ] **Step 4: Refresh stale STT docs**

In `server/src/stt/index.js`, replace the stale header comment lines 3-9 (which say "No route consumes this yet — routes/turn.js still only accepts a text utterance") with:
```js
/**
 * Pluggable STT factory, mirrors brain/tts.
 *   voicebox -> server transcribes audio via a local voicebox instance (Whisper),
 *               consumed by the POST /turn/audio route (dormant this milestone).
 *   (unset)  -> no server-side STT; the client relies on the Web Speech API only.
 * Swap with STT_PROVIDER in server/.env.
 */
```
In `server/.env.example`, change the STT comment `# --- STT (speech-to-text, optional server-side path — not yet wired into /turn) ---` to `# --- STT (server-side path, consumed by POST /turn/audio; unset -> browser Web Speech) ---`.

- [ ] **Step 5: Restart the server and verify `/health`**

Run (from repo root, server only):
```bash
npm run dev:server
```
In another shell:
```bash
curl -s http://localhost:3001/health
```
Expected JSON contains `"tts":"kokoro"` and `"stt":"none"`. Stop the dev server after verifying.

- [ ] **Step 6: Commit**

```bash
git add server/.env.example server/src/stt/index.js
git commit -m "chore: target kokoro TTS + browser STT; refresh stale STT docs"
```
(`server/.env` is gitignored — not committed. Note in the PR/handoff that the local `.env` was switched.)

---

## Task 2: Client test harness (Vitest + RTL + jsdom)

**Files:**
- Modify: `client/package.json`
- Create: `client/vitest.config.js`
- Create: `client/src/test/setup.js`
- Create: `client/src/test/harness.smoke.test.jsx` (temporary sanity test)

**Interfaces:**
- Produces: `npm --prefix client run test` and `test:coverage`; global browser-API stubs; test helpers `MockSpeechRecognition` (with `.instances`, `emitResult`, `emitError`, `emitEnd`), `makeResults(list)`, and `lastRecognizer()`.

- [ ] **Step 1: Add dev deps and scripts to `client/package.json`**

Add to `devDependencies` (exact set — `@testing-library/dom` is a required RTL v16 peer, `@vitest/coverage-v8` is the provider Vitest doesn't bundle):
```json
"vitest": "^4.1.10",
"@vitest/coverage-v8": "^4.1.10",
"@testing-library/react": "^16.3.0",
"@testing-library/dom": "^10.4.0",
"@testing-library/jest-dom": "^6.6.3",
"@testing-library/user-event": "^14.5.2",
"jest-axe": "^9.0.0",
"jsdom": "^25.0.1"
```
Add to `scripts`:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```
Then install:
```bash
npm --prefix client install
```
Expected: install succeeds with no ERESOLVE — Vitest 4 peers on Vite `^8`, matching this project's Vite 8 (Vitest 3 would ERESOLVE against Vite 8); `@vitest/coverage-v8` shares vitest's major.

- [ ] **Step 2: Create `client/vitest.config.js`**

```js
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.js so the tailwind plugin isn't pulled into the test transform.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/hooks/useConversation.js", "src/lib/speech.js"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
```

- [ ] **Step 3: Create `client/src/test/setup.js`**

```js
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// --- Mock SpeechRecognition (jsdom has none) ---
export class MockSpeechRecognition {
  constructor() {
    this.lang = "";
    this.interimResults = false;
    this.continuous = false;
    this.maxAlternatives = 1;
    this.onstart = this.onresult = this.onerror = this.onend = null;
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
    MockSpeechRecognition.instances.push(this);
  }
  start() {
    this.started += 1;
    this.onstart?.();
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  // test helpers
  emitResult(results, resultIndex = 0) {
    this.onresult?.({ results, resultIndex });
  }
  emitError(error) {
    this.onerror?.({ error });
  }
  emitEnd() {
    this.onend?.();
  }
}
MockSpeechRecognition.instances = [];

export function lastRecognizer() {
  const list = MockSpeechRecognition.instances;
  return list[list.length - 1];
}

/** Build a SpeechRecognitionResultList-like array from [{transcript, isFinal}]. */
export function makeResults(list) {
  return list.map((r) => {
    const alt = { transcript: r.transcript };
    return Object.assign([alt], { isFinal: !!r.isFinal });
  });
}

beforeEach(() => {
  MockSpeechRecognition.instances = [];
  vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
  vi.stubGlobal("webkitSpeechRecognition", MockSpeechRecognition);
  vi.stubGlobal("speechSynthesis", {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [{ lang: "en-US", name: "Test EN" }],
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(text) {
        this.text = text;
        this.lang = "";
        this.voice = null;
        this.rate = 1;
        this.pitch = 1;
        this.onstart = this.onend = this.onerror = null;
      }
    },
  );
  // jsdom's HTMLMediaElement.play() is unimplemented — make it a resolved Promise.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
```

- [ ] **Step 4: Create a smoke test to prove the harness runs**

`client/src/test/harness.smoke.test.jsx`:
```jsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MockSpeechRecognition, makeResults } from "./setup.js";

function Hello() {
  return <p>hello harness</p>;
}

describe("test harness", () => {
  it("renders JSX via RTL (proves @vitejs/plugin-react works under Vitest 4)", () => {
    render(<Hello />);
    expect(screen.getByText("hello harness")).toBeInTheDocument();
  });

  it("provides Web Speech globals", () => {
    expect(typeof SpeechRecognition).toBe("function");
    expect(typeof SpeechSynthesisUtterance).toBe("function");
    expect(window.speechSynthesis.getVoices()[0].lang).toBe("en-US");
  });

  it("MockSpeechRecognition records instances and drives callbacks", () => {
    const rec = new SpeechRecognition();
    let got = null;
    rec.onresult = (e) => (got = e.results[e.resultIndex][0].transcript);
    rec.start();
    expect(rec.started).toBe(1);
    rec.emitResult(makeResults([{ transcript: "hi", isFinal: true }]), 0);
    expect(got).toBe("hi");
    expect(MockSpeechRecognition.instances).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run:
```bash
npm --prefix client run test -- src/test/harness.smoke.test.jsx
```
Expected: 3 tests PASS — including the JSX render, which proves `@vitejs/plugin-react` works under Vitest 4 before Tasks 6+ depend on it.

- [ ] **Step 6: Remove the smoke test and commit the harness**

Delete `client/src/test/harness.smoke.test.jsx` (it was scaffolding to prove the setup).
```bash
git add client/package.json client/package-lock.json client/vitest.config.js client/src/test/setup.js
git commit -m "test: add Vitest + RTL + jsdom harness with Web Speech stubs"
```

---

## Task 3: Recognizer + playback in speech.js

**Files:**
- Modify: `client/src/lib/speech.js`
- Create: `client/src/lib/speech.test.js`

**Interfaces:**
- Produces:
  - `createRecognizer({ lang?, onResult, onInterim, onStart, onError, onEnd }) -> recognizer | null`. `onResult(finalChunk: string)` fires once per newly-finalized segment (the NEW chunk only, not the cumulative text). `onInterim(tail: string)` fires with the current non-final tail. Recognizer is created with `continuous=true`, `interimResults=true`.
  - Existing `isSTTSupported()`, `isTTSSupported()`, `warmUpVoices()`, `speak(text, {lang?, onStart?, onEnd?})`, `stopSpeaking()`, `playAudio(base64, {format?, onStart?, onEnd?, onError?}) -> HTMLAudioElement | null` — unchanged signatures.
- Consumes: nothing (leaf module).

- [ ] **Step 1: Write failing tests for the recognizer**

`client/src/lib/speech.test.js`:
```js
import { describe, it, expect, vi } from "vitest";
import { createRecognizer, playAudio, isSTTSupported } from "./speech.js";
import { lastRecognizer, makeResults } from "../test/setup.js";

describe("createRecognizer", () => {
  it("configures a continuous, interim recognizer", () => {
    createRecognizer({});
    const rec = lastRecognizer();
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe("en-US");
  });

  it("emits only the newly finalized chunk via onResult", () => {
    const finals = [];
    createRecognizer({ onResult: (c) => finals.push(c) });
    const rec = lastRecognizer();
    // first event: one final "hello"
    rec.emitResult(makeResults([{ transcript: "hello", isFinal: true }]), 0);
    // second event: results advanced; new final "world" at index 1
    rec.emitResult(
      makeResults([
        { transcript: "hello", isFinal: true },
        { transcript: "world", isFinal: true },
      ]),
      1,
    );
    expect(finals).toEqual(["hello", "world"]);
  });

  it("emits the non-final tail via onInterim", () => {
    const interims = [];
    createRecognizer({ onInterim: (t) => interims.push(t) });
    const rec = lastRecognizer();
    rec.emitResult(makeResults([{ transcript: "how are", isFinal: false }]), 0);
    expect(interims.at(-1)).toBe("how are");
  });

  it("calls onStart/onEnd/onError passthroughs", () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    createRecognizer({ onStart, onEnd, onError });
    const rec = lastRecognizer();
    rec.start();
    rec.emitEnd();
    rec.emitError("no-speech");
    expect(onStart).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("no-speech");
  });
});

describe("playAudio", () => {
  it("returns null and calls onEnd when base64 is empty", () => {
    const onEnd = vi.fn();
    expect(playAudio("", { onEnd })).toBeNull();
    expect(onEnd).toHaveBeenCalled();
  });

  it("builds a wav data URI for format=wav", () => {
    const el = playAudio("AAAA", { format: "wav" });
    expect(el).toBeInstanceOf(HTMLAudioElement);
    expect(el.src.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  it("defaults to audio/mpeg for mp3", () => {
    const el = playAudio("AAAA", { format: "mp3" });
    expect(el.src.startsWith("data:audio/mpeg;base64,")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm --prefix client run test -- src/lib/speech.test.js
```
Expected: FAIL — `createRecognizer` currently sets `interimResults=false`/`continuous=false`, has no `onInterim`/`onStart`, and emits cumulative (not per-chunk) results.

- [ ] **Step 3: Rewrite `createRecognizer` in `client/src/lib/speech.js`**

Replace the existing `createRecognizer` (lines 16-41) with:
```js
/**
 * Create a continuous recognizer. It keeps listening across pauses until the
 * caller stops it. Emits each NEWLY finalized segment via onResult(chunk) and
 * the current non-final tail via onInterim(tail). Returns null if the browser
 * lacks Web Speech (use the text fallback then).
 */
export function createRecognizer({
  lang = "en-US",
  onResult,
  onInterim,
  onStart,
  onError,
  onEnd,
} = {}) {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => onStart?.();
  rec.onresult = (event) => {
    let finalizedChunk = "";
    let interimTail = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const res = event.results[i];
      const text = res[0]?.transcript ?? "";
      if (res.isFinal) finalizedChunk += text;
      else interimTail += text;
    }
    const finalTrimmed = finalizedChunk.trim();
    if (finalTrimmed) onResult?.(finalTrimmed);
    onInterim?.(interimTail.trim());
  };
  rec.onerror = (event) => onError?.(event.error || "speech-error");
  rec.onend = () => onEnd?.();

  return rec;
}
```
Leave `speak`, `stopSpeaking`, `playAudio`, `pickEnglishVoice`, `warmUpVoices`, `isSTTSupported`, `isTTSSupported` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm --prefix client run test -- src/lib/speech.test.js
```
Expected: all PASS.

- [ ] **Step 5: Add branch-coverage tests for playback/voice helpers**

Append to `client/src/lib/speech.test.js`:
```js
import { speak, pickEnglishVoiceForTest } from "./speech.js"; // pickEnglishVoiceForTest added below

describe("speak", () => {
  it("no-ops and calls onEnd when text is empty", () => {
    const onEnd = vi.fn();
    speak("", { onEnd });
    expect(onEnd).toHaveBeenCalled();
  });

  it("speaks via speechSynthesis for non-empty text", () => {
    speak("hello");
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
  });
});
```
To make `pickEnglishVoice` testable across its three branches, export a thin test alias at the bottom of `speech.js`:
```js
// Exposed for unit tests only.
export const pickEnglishVoiceForTest = pickEnglishVoice;
```
Then append:
```js
describe("pickEnglishVoiceForTest", () => {
  it("prefers en-US, then any en, then null", () => {
    window.speechSynthesis.getVoices = () => [{ lang: "fr-FR" }, { lang: "en-GB" }];
    expect(pickEnglishVoiceForTest().lang).toBe("en-GB");
    window.speechSynthesis.getVoices = () => [{ lang: "en-US" }, { lang: "en-GB" }];
    expect(pickEnglishVoiceForTest().lang).toBe("en-US");
    window.speechSynthesis.getVoices = () => [{ lang: "de-DE" }];
    expect(pickEnglishVoiceForTest()).toBeNull();
  });
});
```

- [ ] **Step 6: Run full speech.js suite and verify pass**

Run:
```bash
npm --prefix client run test -- src/lib/speech.test.js
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/speech.js client/src/lib/speech.test.js
git commit -m "feat: continuous interim recognizer + speech.js unit tests"
```

---

## Task 4: useConversation — turn engine (text path, playback controller, fallback)

**Files:**
- Create: `client/src/hooks/useConversation.js`
- Create: `client/src/hooks/useConversation.test.js`

**Interfaces:**
- Consumes: `postTurn`, `getHealth` from `api.js`; `speak`, `stopSpeaking`, `playAudio`, `warmUpVoices`, `isSTTSupported` from `speech.js`.
- Produces (this task): a hook returning `{ messages, status, totalXp, error, providers, ttsFallbackActive, sttSupported, turns, submitText, clearError }`. Full speech actions land in Task 5.

- [ ] **Step 1: Write failing tests for the text path + fallback**

`client/src/hooks/useConversation.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", () => ({
  postTurn: vi.fn(),
  getHealth: vi.fn(),
}));
vi.mock("../lib/speech.js", async () => {
  const actual = await vi.importActual("../lib/speech.js");
  return {
    ...actual,
    warmUpVoices: vi.fn(),
    isSTTSupported: vi.fn(() => true),
    speak: vi.fn((_t, o) => o?.onEnd?.()),
    stopSpeaking: vi.fn(),
    playAudio: vi.fn(() => ({ pause: vi.fn() })),
    createRecognizer: vi.fn(),
  };
});

import { postTurn, getHealth } from "../lib/api.js";
import { playAudio, speak } from "../lib/speech.js";
import { useConversation } from "./useConversation.js";

beforeEach(() => {
  getHealth.mockResolvedValue({ brain: "mock", tts: "kokoro", stt: "none" });
  postTurn.mockReset();
  playAudio.mockClear();
  speak.mockClear();
});

describe("useConversation — text path", () => {
  it("pushes the user bubble immediately, then the coach reply, and adds XP", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Nice!", xp: 10, audio: "AAAA", audioFormat: "mp3" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("I went hiking"));
    // user bubble optimistic
    expect(result.current.messages.at(-1)).toMatchObject({ role: "user", text: "I went hiking" });
    expect(result.current.status).toBe("thinking");

    await waitFor(() => expect(result.current.status).toBe("speaking"));
    expect(result.current.messages.at(-1)).toMatchObject({ role: "coach", text: "Nice!" });
    expect(result.current.totalXp).toBe(10);
    expect(playAudio).toHaveBeenCalled();
  });

  it("plays browser voice and flags fallback when audio is null for a kokoro provider", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Ok", xp: 5, audio: null });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("hello"));
    // The browser-voice mock fires onEnd synchronously, so "speaking" collapses to
    // "idle" in one React batch and is never an observable commit — assert the
    // fallback was invoked and flagged instead of the transient state.
    await waitFor(() => expect(speak).toHaveBeenCalled());
    expect(result.current.ttsFallbackActive).toBe(true);
  });

  it("rolls back the optimistic bubble and repopulates the draft on brain failure", async () => {
    postTurn.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("hello"));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.messages).toHaveLength(1); // optimistic bubble rolled back (greeting only)
    expect(result.current.draft).toBe("hello"); // repopulated for retry
  });

  it("ignores submitText when not idle or empty", async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));
    act(() => result.current.submitText("   "));
    expect(result.current.messages).toHaveLength(1); // greeting only
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm --prefix client run test -- src/hooks/useConversation.test.js
```
Expected: FAIL — `useConversation` does not exist.

- [ ] **Step 3: Create `client/src/hooks/useConversation.js` (turn engine)**

```js
import { useEffect, useRef, useState } from "react";
import { postTurn, getHealth } from "../lib/api.js";
import {
  isSTTSupported,
  playAudio,
  speak,
  stopSpeaking,
  warmUpVoices,
} from "../lib/speech.js";

const GREETING =
  "Hi! I'm your SpeakUp coach. Tap the mic and tell me about your day — let's practice some English.";

/**
 * Owns the whole conversation loop: providers, the turn round-trip, and a
 * single playback controller for the coach voice. Speech capture + the review
 * state machine are added in a later slice.
 */
export function useConversation() {
  const [messages, setMessages] = useState([{ role: "coach", text: GREETING }]);
  const [status, setStatus] = useState("idle"); // idle|listening|review|thinking|speaking
  const [totalXp, setTotalXp] = useState(0);
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState({ brain: null, tts: null, stt: null });
  const [ttsFallbackActive, setTtsFallbackActive] = useState(false);
  const [draft, setDraft] = useState(""); // repopulated on error so the user can retry

  const currentAudioRef = useRef(null);
  const speakTimerRef = useRef(null);
  const statusRef = useRef("idle");
  const messagesRef = useRef(messages);
  const providersRef = useRef(providers);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);

  useEffect(() => {
    warmUpVoices();
    getHealth().then((h) => {
      if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt });
    });
  }, []);

  // --- playback controller: sole owner of currentAudioRef + speakTimerRef + speaking status ---
  function stopPlayback() {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    stopSpeaking();
    clearTimeout(speakTimerRef.current);
  }

  function playCoach(text, audio, audioFormat) {
    clearTimeout(speakTimerRef.current);
    setStatus("speaking");
    const toIdle = () => setStatus((s) => (s === "speaking" ? "idle" : s));
    const fallbackMs = Math.max(4000, text.split(/\s+/).length * 450 + 2500);
    speakTimerRef.current = setTimeout(toIdle, fallbackMs);
    const done = () => {
      clearTimeout(speakTimerRef.current);
      toIdle();
    };
    if (audio) {
      currentAudioRef.current = playAudio(audio, {
        format: audioFormat,
        onEnd: done,
        onError: () => speak(text, { onEnd: done }),
      });
    } else {
      speak(text, { onEnd: done });
    }
  }

  // --- turn engine (shared by text + speech paths) ---
  async function runTurn(utterance) {
    setError(null);
    const userMsg = { role: "user", text: utterance };
    const historyBefore = messagesRef.current;
    setMessages((prev) => [...prev, userMsg]); // optimistic user bubble
    setStatus("thinking");
    try {
      const { coach_reply, xp, audio, audioFormat } = await postTurn({
        utterance,
        history: [...historyBefore, userMsg],
      });
      setMessages((prev) => [...prev, { role: "coach", text: coach_reply, audio, audioFormat }]);
      if (typeof xp === "number") setTotalXp((v) => v + xp);

      const expectedServerVoice = providersRef.current.tts && providersRef.current.tts !== "browser";
      if (!audio && expectedServerVoice) setTtsFallbackActive(true);
      else if (audio) setTtsFallbackActive(false);
      playCoach(coach_reply, audio, audioFormat);
    } catch (err) {
      // Optimistic rollback: drop the just-pushed user bubble, then drop into
      // review with the text repopulated so the retry re-adds exactly one turn.
      setMessages(historyBefore);
      setError(err.message || "The coach brain failed to respond.");
      setDraft(utterance);
      setStatus("review");
    }
  }

  function submitText(text) {
    const t = text?.trim();
    if (statusRef.current !== "idle" || !t) return;
    runTurn(t);
  }

  const sttSupported = isSTTSupported();

  return {
    messages,
    status,
    totalXp,
    error,
    providers,
    ttsFallbackActive,
    sttSupported,
    turns: messages.filter((m) => m.role === "user").length,
    submitText,
    clearError: () => setError(null),
  };
}
```
> Note: Task 5 replaces this file wholesale with the full speech state machine; this turn-engine version is the intermediate, independently-testable slice.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm --prefix client run test -- src/hooks/useConversation.test.js
```
Expected: the four text-path tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js
git commit -m "feat: useConversation turn engine (text path, playback controller, TTS fallback)"
```

---

## Task 5: useConversation — speech capture + full state machine

**Files:**
- Modify: `client/src/hooks/useConversation.js` (replace with the final version below)
- Modify: `client/src/hooks/useConversation.test.js` (add speech-machine tests)

**Interfaces:**
- Consumes: `createRecognizer` from `speech.js` (Task 3).
- Produces (final public API): the hook returns
  `{ messages, status, draft, interim, liveTranscript, totalXp, error, providers, ttsFallbackActive, sttSupported, turns, startListening, stopListening, editDraft, send, reRecord, cancel, interrupt, submitText, replay, clearError }`.

- [ ] **Step 1: Write failing tests for the speech state machine**

Append to `client/src/hooks/useConversation.test.js`. First extend the `speech.js` mock so `createRecognizer` produces a controllable fake and records callbacks — replace the existing `vi.mock("../lib/speech.js", …)` block's `createRecognizer` with a factory that captures handlers:
```js
// at top-level of the test file, after imports:
let recHandlers = null;
let nextRecognizerNull = false; // flip true to force createRecognizer -> null once
```
In the `speech.js` mock, change `createRecognizer` to (the `nextRecognizerNull` check lets one test cover the unsupported branch; both module flags are read only inside this deferred arrow, so there is no vi.mock hoisting issue):
```js
    createRecognizer: (handlers) => {
      if (nextRecognizerNull) {
        nextRecognizerNull = false;
        return null;
      }
      recHandlers = handlers;
      return {
        start: () => handlers.onStart?.(),
        stop: () => handlers.onEnd?.(),
        abort: () => {},
      };
    },
```
Then append **only** the new describe block below — do NOT re-import `useConversation` (it is already imported from Task 4 at the top of the file; a duplicate identical import is a `SyntaxError` that fails the whole file to parse):
```js
describe("useConversation — speech machine", () => {
  async function mounted() {
    const utils = renderHook(() => useConversation());
    await waitFor(() => expect(utils.result.current.providers.tts).toBe("kokoro"));
    return utils;
  }

  it("startListening enters listening and streams interim + final into the draft", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    expect(result.current.status).toBe("listening");

    act(() => recHandlers.onResult("Yesterday I"));
    act(() => recHandlers.onInterim("went to the"));
    expect(result.current.liveTranscript).toBe("Yesterday I went to the");

    act(() => recHandlers.onResult("went to the park")); // new finalized chunk appended
    expect(result.current.draft).toBe("Yesterday I went to the park");
  });

  it("user stop with a non-empty draft goes to review", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("Hello there"));
    act(() => result.current.stopListening()); // fake stop() -> onEnd
    expect(result.current.status).toBe("review");
    expect(result.current.draft).toBe("Hello there");
  });

  it("user stop with an empty draft returns to idle with a message", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => result.current.stopListening());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/didn't catch that/i);
  });

  it("auto onend without a user stop keeps listening (restart)", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    // simulate Chrome self-terminating on silence: onEnd fires, userStopped=false
    act(() => recHandlers.onEnd());
    expect(result.current.status).toBe("listening");
  });

  it("send posts the edited draft and clears it", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("i like it"));
    act(() => result.current.stopListening());
    act(() => result.current.editDraft("I like it a lot"));
    act(() => result.current.send());
    expect(result.current.messages.at(-1)).toMatchObject({ role: "user", text: "I like it a lot" });
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    expect(result.current.draft).toBe("");
  });

  it("barge-in during speaking stops playback and re-enters listening", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    act(() => result.current.submitText("hello"));
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    act(() => result.current.interrupt());
    expect(stopSpeaking).toHaveBeenCalled();
    expect(result.current.status).toBe("listening");
  });

  it("replay is only allowed from idle and does not change state", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening()); // now listening
    act(() => result.current.replay({ text: "hi", audio: "AAAA", audioFormat: "mp3" }));
    expect(result.current.status).toBe("listening"); // ignored while listening
    expect(playAudio).not.toHaveBeenCalled();
  });

  it("fatal mic error surfaces the permission message and stops listening", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onError("not-allowed"));
    act(() => recHandlers.onEnd());
    expect(result.current.error).toMatch(/permission/i);
    expect(result.current.status).toBe("idle");
  });
});
```
Add `stopSpeaking` to the imported names from the `speech.js` mock at the top of the file:
```js
import { playAudio, speak, stopSpeaking } from "../lib/speech.js";
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm --prefix client run test -- src/hooks/useConversation.test.js
```
Expected: the new speech-machine tests FAIL (no `startListening`/`send`/etc.).

- [ ] **Step 3: Replace `client/src/hooks/useConversation.js` with the final version**

```js
import { useEffect, useRef, useState } from "react";
import { postTurn, getHealth } from "../lib/api.js";
import {
  createRecognizer,
  isSTTSupported,
  playAudio,
  speak,
  stopSpeaking,
  warmUpVoices,
} from "../lib/speech.js";

const GREETING =
  "Hi! I'm your SpeakUp coach. Tap the mic and tell me about your day — let's practice some English.";

const MAX_LISTEN_MS = 120000; // hard cap so a stuck session can't listen forever
const MAX_EMPTY_RESTARTS = 6; // guard against tight restart loops on a silent/broken mic
const NO_SPEECH_MSG = "Didn't catch that — try again or type.";

/**
 * Owns the whole conversation loop: providers, the turn round-trip, a single
 * playback controller for the coach voice, and the speech capture state
 * machine (idle -> listening -> review -> thinking -> speaking -> idle).
 */
export function useConversation() {
  const [messages, setMessages] = useState([{ role: "coach", text: GREETING }]);
  const [status, setStatus] = useState("idle");
  const [draft, setDraft] = useState(""); // finalized text, then editable in review
  const [interim, setInterim] = useState(""); // live non-final tail during listening
  const [totalXp, setTotalXp] = useState(0);
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState({ brain: null, tts: null, stt: null });
  const [ttsFallbackActive, setTtsFallbackActive] = useState(false);

  const recognizerRef = useRef(null);
  const userStoppedRef = useRef(false);
  const fatalRef = useRef(false);
  const listenStartRef = useRef(0);
  const emptyRestartsRef = useRef(0);
  const currentAudioRef = useRef(null);
  const speakTimerRef = useRef(null);

  const statusRef = useRef("idle");
  const draftRef = useRef("");
  const interimRef = useRef("");
  const messagesRef = useRef(messages);
  const providersRef = useRef(providers);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { interimRef.current = interim; }, [interim]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { providersRef.current = providers; }, [providers]);

  useEffect(() => {
    warmUpVoices();
    getHealth().then((h) => {
      if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt });
    });
  }, []);

  // ---------------- playback controller ----------------
  function stopPlayback() {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    stopSpeaking();
    clearTimeout(speakTimerRef.current);
  }

  function playCoach(text, audio, audioFormat) {
    clearTimeout(speakTimerRef.current);
    setStatus("speaking");
    const toIdle = () => setStatus((s) => (s === "speaking" ? "idle" : s));
    const fallbackMs = Math.max(4000, text.split(/\s+/).length * 450 + 2500);
    speakTimerRef.current = setTimeout(toIdle, fallbackMs);
    const done = () => {
      clearTimeout(speakTimerRef.current);
      toIdle();
    };
    if (audio) {
      currentAudioRef.current = playAudio(audio, {
        format: audioFormat,
        onEnd: done,
        onError: () => speak(text, { onEnd: done }),
      });
    } else {
      speak(text, { onEnd: done });
    }
  }

  // ---------------- turn engine ----------------
  async function runTurn(utterance) {
    setError(null);
    const userMsg = { role: "user", text: utterance };
    const historyBefore = messagesRef.current;
    setMessages((prev) => [...prev, userMsg]);
    setStatus("thinking");
    try {
      const { coach_reply, xp, audio, audioFormat } = await postTurn({
        utterance,
        history: [...historyBefore, userMsg],
      });
      setMessages((prev) => [...prev, { role: "coach", text: coach_reply, audio, audioFormat }]);
      if (typeof xp === "number") setTotalXp((v) => v + xp);

      const expectedServerVoice = providersRef.current.tts && providersRef.current.tts !== "browser";
      if (!audio && expectedServerVoice) setTtsFallbackActive(true);
      else if (audio) setTtsFallbackActive(false);
      playCoach(coach_reply, audio, audioFormat);
    } catch (err) {
      setMessages(historyBefore); // optimistic rollback (retry re-adds exactly one turn)
      setError(err.message || "The coach brain failed to respond.");
      setDraft(utterance);
      setStatus("review");
    }
  }

  // ---------------- speech capture ----------------
  function finishListening(announceEmpty) {
    const combined = `${draftRef.current} ${interimRef.current}`.trim();
    setInterim("");
    if (combined) {
      setDraft(combined);
      setStatus("review");
    } else {
      setStatus("idle");
      if (announceEmpty) setError(NO_SPEECH_MSG);
    }
  }

  function handleSpeechError(code) {
    if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
      fatalRef.current = true;
      setError("Microphone permission denied — allow the mic or use the text box.");
    } else if (code === "network") {
      fatalRef.current = true;
      setError("Speech service unavailable — try again or type.");
    } else if (code === "no-speech" || code === "aborted") {
      // non-fatal (paused) / self-initiated (barge-in, reRecord) — handled by onend
    } else {
      setError(`Speech error: ${code}`);
    }
  }

  function handleRecognizerEnd() {
    if (statusRef.current !== "listening") return;
    if (fatalRef.current) {
      fatalRef.current = false;
      setInterim("");
      setStatus("idle");
      return;
    }
    const overTime = Date.now() - listenStartRef.current > MAX_LISTEN_MS;
    const tooManyRestarts = emptyRestartsRef.current >= MAX_EMPTY_RESTARTS;
    if (userStoppedRef.current || overTime || tooManyRestarts) {
      finishListening(userStoppedRef.current || tooManyRestarts);
      return;
    }
    // silence self-termination: keep listening (continuity), preserving the draft
    emptyRestartsRef.current += 1;
    try {
      recognizerRef.current?.start();
    } catch {
      finishListening(false);
    }
  }

  function startListening() {
    if (statusRef.current === "listening" || statusRef.current === "thinking") return;
    stopPlayback();
    setError(null);
    setDraft("");
    setInterim("");
    userStoppedRef.current = false;
    fatalRef.current = false;
    emptyRestartsRef.current = 0;
    listenStartRef.current = Date.now();
    const rec = createRecognizer({
      onStart: () => setStatus("listening"),
      onResult: (chunk) => {
        emptyRestartsRef.current = 0;
        setDraft((d) => `${d} ${chunk}`.trim());
      },
      onInterim: (tail) => setInterim(tail),
      onError: (code) => handleSpeechError(code),
      onEnd: () => handleRecognizerEnd(),
    });
    if (!rec) {
      setError("Speech recognition isn't supported here — use the text box (Chrome/Edge work best).");
      setStatus("idle");
      return;
    }
    recognizerRef.current = rec;
    try {
      rec.start();
    } catch {
      setStatus("idle");
    }
  }

  function stopListening() {
    if (statusRef.current !== "listening") return;
    userStoppedRef.current = true;
    try {
      recognizerRef.current?.stop();
    } catch {
      finishListening(true);
    }
  }

  function editDraft(text) {
    setDraft(text);
  }

  function send() {
    if (statusRef.current !== "review") return;
    const t = draftRef.current.trim();
    if (!t) {
      setStatus("idle");
      return;
    }
    setDraft("");
    runTurn(t);
  }

  function reRecord() {
    if (statusRef.current !== "review") return;
    setDraft("");
    setInterim("");
    startListening();
  }

  function cancel() {
    if (statusRef.current !== "review") return;
    recognizerRef.current?.abort?.();
    setDraft("");
    setInterim("");
    setError(null);
    setStatus("idle");
  }

  function interrupt() {
    if (statusRef.current !== "speaking") return;
    stopPlayback();
    startListening();
  }

  function submitText(text) {
    const t = text?.trim();
    if (statusRef.current !== "idle" || !t) return;
    runTurn(t);
  }

  function replay(message) {
    if (statusRef.current !== "idle" || !message) return;
    stopPlayback();
    if (message.audio) {
      currentAudioRef.current = playAudio(message.audio, { format: message.audioFormat });
    } else {
      speak(message.text);
    }
  }

  return {
    messages,
    status,
    draft,
    interim,
    liveTranscript: `${draft} ${interim}`.trim(),
    totalXp,
    error,
    providers,
    ttsFallbackActive,
    sttSupported: isSTTSupported(),
    turns: messages.filter((m) => m.role === "user").length,
    startListening,
    stopListening,
    editDraft,
    send,
    reRecord,
    cancel,
    interrupt,
    submitText,
    replay,
    clearError: () => setError(null),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm --prefix client run test -- src/hooks/useConversation.test.js
```
Expected: all text-path AND speech-machine tests PASS.

- [ ] **Step 5: Add coverage-filler tests, then confirm the gate**

The happy-path tests don't exercise every branch of the two included files, so the 80% gate will fail until these are added. Append inside the speech-machine `describe` in `useConversation.test.js`:
```js
  it("reRecord clears the draft and restarts listening; cancel returns to idle", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("hello"));
    act(() => result.current.stopListening()); // -> review
    act(() => result.current.reRecord());
    expect(result.current.status).toBe("listening");
    expect(result.current.draft).toBe("");
    act(() => recHandlers.onResult("again"));
    act(() => result.current.stopListening()); // -> review
    act(() => result.current.cancel());
    expect(result.current.status).toBe("idle");
    expect(result.current.draft).toBe("");
  });

  it("network and no-speech errors set the right messages", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onError("network"));
    act(() => recHandlers.onEnd());
    expect(result.current.error).toMatch(/speech service unavailable/i);
    act(() => result.current.startListening());
    act(() => recHandlers.onError("no-speech")); // non-fatal
    act(() => result.current.stopListening());   // user stop, empty -> idle + message
    expect(result.current.error).toMatch(/didn't catch that/i);
  });

  it("replay from idle plays the coach audio", async () => {
    const { result } = await mounted();
    act(() => result.current.replay({ text: "hi", audio: "AAAA", audioFormat: "mp3" }));
    expect(playAudio).toHaveBeenCalled();
  });

  it("finalizes to review once past the max session cap", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("something"));
    nowSpy.mockReturnValue(200000); // past MAX_LISTEN_MS
    act(() => recHandlers.onEnd());  // auto onend past the cap -> finalize
    expect(result.current.status).toBe("review");
    nowSpy.mockRestore();
  });

  it("returns to idle with a message when the recognizer is unsupported", async () => {
    const { result } = await mounted();
    nextRecognizerNull = true;
    act(() => result.current.startListening());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/isn't supported/i);
  });

  it("error then successful resend yields exactly one user bubble", async () => {
    postTurn.mockRejectedValueOnce(new Error("boom"));
    postTurn.mockResolvedValueOnce({ coach_reply: "ok", xp: 1, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    act(() => result.current.submitText("my answer"));
    await waitFor(() => expect(result.current.status).toBe("review")); // rolled back
    expect(result.current.draft).toBe("my answer");
    act(() => result.current.send());
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
```
And append to `speech.test.js` (add `warmUpVoices`, `stopSpeaking` to its imports from `./speech.js`):
```js
describe("voice helpers coverage", () => {
  it("warmUpVoices and stopSpeaking are safe to call", () => {
    warmUpVoices();
    stopSpeaking();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  it("playAudio builds an ogg data URI for opus", () => {
    const el = playAudio("AAAA", { format: "opus" });
    expect(el.src.startsWith("data:audio/ogg;base64,")).toBe(true);
  });
});
```
Then run:
```bash
npm --prefix client run test:coverage
```
Expected: PASS with ≥80% (lines/functions/branches/statements) on `useConversation.js` and `speech.js`. If a branch is still under, add a focused test — do not lower the threshold.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js
git commit -m "feat: useConversation speech machine (listening/review/barge-in/replay)"
```

---

## Task 6: TranscriptReview component

**Files:**
- Create: `client/src/components/TranscriptReview.jsx`
- Create: `client/src/components/TranscriptReview.test.jsx`

**Interfaces:**
- Consumes: props `{ draft, onEdit(text), onSend(), onReRecord(), onCancel() }`.
- Produces: the review UI shown when `status === "review"`.

- [ ] **Step 1: Write failing tests**

`client/src/components/TranscriptReview.test.jsx`:
```js
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TranscriptReview from "./TranscriptReview.jsx";

function setup(props = {}) {
  const handlers = { onEdit: vi.fn(), onSend: vi.fn(), onReRecord: vi.fn(), onCancel: vi.fn() };
  render(<TranscriptReview draft="hello world" {...handlers} {...props} />);
  return handlers;
}

describe("TranscriptReview", () => {
  it("renders the draft in an autofocused textarea", () => {
    setup();
    const ta = screen.getByRole("textbox");
    expect(ta).toHaveValue("hello world");
    expect(ta).toHaveFocus();
  });

  it("calls onEdit as the user types", async () => {
    const { onEdit } = setup({ draft: "" });
    await userEvent.type(screen.getByRole("textbox"), "hi");
    expect(onEdit).toHaveBeenCalled();
  });

  it("Enter sends, Shift+Enter does not, Esc cancels", async () => {
    const { onSend, onCancel } = setup();
    const ta = screen.getByRole("textbox");
    ta.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("Send button is disabled for an empty draft", () => {
    setup({ draft: "   " });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm --prefix client run test -- src/components/TranscriptReview.test.jsx
```
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create `client/src/components/TranscriptReview.jsx`**

```jsx
import { useEffect, useRef } from "react";

/**
 * Editable review of the recognized utterance. Shown in the `review` state.
 * Enter sends, Shift+Enter inserts a newline, Esc cancels.
 */
export default function TranscriptReview({ draft, onEdit, onSend, onReRecord, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const canSend = draft.trim().length > 0;

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor="transcript-review" className="text-xs text-muted">
        Review what you said, edit if needed, then send:
      </label>
      <textarea
        id="transcript-review"
        ref={ref}
        value={draft}
        onChange={(e) => onEdit(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        className="w-full bg-ink-2 border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-coach/50 resize-none"
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 rounded-xl border border-line text-sm text-muted hover:text-ink transition"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onReRecord}
          className="px-3 py-2 rounded-xl border border-line text-sm hover:border-coach/60 hover:text-coach-soft transition"
        >
          Re-record
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="px-4 py-2 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm --prefix client run test -- src/components/TranscriptReview.test.jsx
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TranscriptReview.jsx client/src/components/TranscriptReview.test.jsx
git commit -m "feat: TranscriptReview component (edit-before-send)"
```

---

## Task 7: VoiceStatus component

**Files:**
- Create: `client/src/components/VoiceStatus.jsx`
- Create: `client/src/components/VoiceStatus.test.jsx`

**Interfaces:**
- Consumes: props `{ status, liveTranscript, error, ttsFallbackActive, sttSupported, onDismissError() }`.
- Produces: an `aria-live="polite"` status region + `role="alert"` banners per the error surface model. No "synthesizing…" state.

- [ ] **Step 1: Write failing tests**

`client/src/components/VoiceStatus.test.jsx`:
```js
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import VoiceStatus from "./VoiceStatus.jsx";

const base = {
  status: "idle",
  liveTranscript: "",
  error: null,
  ttsFallbackActive: false,
  sttSupported: true,
  onDismissError: vi.fn(),
};

describe("VoiceStatus", () => {
  it("has a polite live region", () => {
    const { container } = render(<VoiceStatus {...base} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it("shows the live transcript while listening", () => {
    render(<VoiceStatus {...base} status="listening" liveTranscript="hello wor" />);
    expect(screen.getByText(/hello wor/)).toBeInTheDocument();
  });

  it("renders the error as an alert", () => {
    render(<VoiceStatus {...base} error="Microphone permission denied" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/permission denied/i);
  });

  it("shows the browser-voice fallback notice as an alert", () => {
    render(<VoiceStatus {...base} ttsFallbackActive />);
    expect(screen.getByRole("alert")).toHaveTextContent(/using browser voice/i);
  });

  it("warns when Web Speech is unsupported", () => {
    render(<VoiceStatus {...base} sttSupported={false} />);
    expect(screen.getByText(/chrome/i)).toBeInTheDocument();
  });

  it("does not render a 'synthesizing' state", () => {
    render(<VoiceStatus {...base} status="thinking" />);
    expect(screen.queryByText(/synthesiz/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm --prefix client run test -- src/components/VoiceStatus.test.jsx
```
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create `client/src/components/VoiceStatus.jsx`**

```jsx
const STATUS_LABEL = {
  idle: "",
  listening: "Listening… tap stop when you're done",
  review: "Review and send",
  thinking: "Coach is composing a reply…",
  speaking: "Coach is speaking",
};

/**
 * Status line (aria-live) + banners. The single `error` string is a transient
 * per-turn failure; the TTS fallback is an event notice; no-Web-Speech is a
 * derived capability warning. There is no client-observable synthesis phase.
 */
export default function VoiceStatus({
  status,
  liveTranscript,
  error,
  ttsFallbackActive,
  sttSupported,
  onDismissError,
}) {
  return (
    <div className="space-y-2">
      <div aria-live="polite" className="min-h-4 text-xs text-muted">
        {status === "listening" && liveTranscript
          ? liveTranscript
          : STATUS_LABEL[status] || ""}
      </div>

      {!sttSupported && (
        <p className="text-xs text-muted">
          This browser lacks speech recognition — use the text box (Chrome/Edge work best).
        </p>
      )}

      {ttsFallbackActive && (
        <div
          role="alert"
          className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2"
        >
          Coach voice unavailable — using browser voice.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            className="text-red-300/70 hover:text-red-200"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm --prefix client run test -- src/components/VoiceStatus.test.jsx
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/VoiceStatus.jsx client/src/components/VoiceStatus.test.jsx
git commit -m "feat: VoiceStatus component (aria-live status + alert banners)"
```

---

## Task 8: MicButton, StatHeader, and reduced-motion tweaks

**Files:**
- Modify: `client/src/components/MicButton.jsx`
- Modify: `client/src/components/StatHeader.jsx:49-60`
- Modify: `client/src/index.css`
- Create: `client/src/components/MicButton.test.jsx`

**Interfaces:**
- Consumes: MicButton props `{ status, onClick, disabled }` (unchanged) plus new state semantics.
- Produces: an action-oriented `aria-label` per state; StatHeader TTS badge titled "configured coach voice".

- [ ] **Step 1: Write a failing test for the barge-in label**

`client/src/components/MicButton.test.jsx`:
```js
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MicButton from "./MicButton.jsx";

describe("MicButton aria-label", () => {
  it("is action-oriented per state", () => {
    const { rerender } = render(<MicButton status="idle" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Tap to speak");

    rerender(<MicButton status="listening" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Stop recording");

    rerender(<MicButton status="speaking" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Interrupt coach and speak");
  });

  it("is clickable during speaking (barge-in), not disabled", () => {
    render(<MicButton status="speaking" onClick={() => {}} />);
    expect(screen.getByRole("button")).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm --prefix client run test -- src/components/MicButton.test.jsx
```
Expected: FAIL — current labels are `{idle:"Tap to speak", listening:"Listening…", thinking:"Coach is thinking", speaking:"Coach is speaking"}` and `speaking` is treated as `busy` (disabled).

- [ ] **Step 3: Update `client/src/components/MicButton.jsx`**

Replace the top `LABELS` map and the `busy` logic. New file:
```jsx
const LABELS = {
  idle: "Tap to speak",
  listening: "Stop recording",
  thinking: "Coach is thinking",
  speaking: "Interrupt coach and speak",
};

export default function MicButton({ status = "idle", onClick, disabled, ref }) {
  const isListening = status === "listening";
  const isSpeaking = status === "speaking";
  // Only `thinking` blocks the button; `speaking` is the barge-in control.
  const blocked = status === "thinking";

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <div className="relative grid place-items-center">
        {isListening && (
          <span className="absolute w-20 h-20 rounded-full bg-user/40 animate-pulse-ring" />
        )}
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          disabled={disabled || blocked}
          aria-label={LABELS[status]}
          className={`relative grid place-items-center w-20 h-20 rounded-full text-3xl transition-all duration-200 ring-1
            ${
              isListening
                ? "bg-user text-ink ring-user/60 scale-105"
                : isSpeaking
                ? "bg-coach/70 text-white ring-coach/50 hover:scale-105"
                : blocked
                ? "bg-surface-2 text-muted ring-line cursor-not-allowed"
                : "bg-coach text-white ring-coach/50 hover:scale-105 hover:shadow-[0_0_30px_-4px] hover:shadow-coach active:scale-95"
            }`}
        >
          {blocked ? <ThinkingDots /> : isListening ? "■" : isSpeaking ? "✋" : "🎤"}
        </button>
      </div>
      <span className="text-xs text-muted h-4">{LABELS[status]}</span>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="flex items-end gap-1 text-coach-soft text-lg leading-none">
      <span className="dot">•</span>
      <span className="dot">•</span>
      <span className="dot">•</span>
    </span>
  );
}
```

- [ ] **Step 4: Update StatHeader TTS badge title**

In `client/src/components/StatHeader.jsx`, change the TTS badge `title` (line 51) from `title="active coach voice"` to `title="configured coach voice"`.

- [ ] **Step 5: Add the reduced-motion guard to `client/src/index.css`**

Append at the end of the file:
```css
@media (prefers-reduced-motion: reduce) {
  .animate-pulse-ring,
  .animate-bob,
  .dot {
    animation: none !important;
  }
}
```
(If `.animate-bob` is not defined in this project, keep only the selectors that exist — `.animate-pulse-ring` and `.dot` are referenced in MicButton.)

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
npm --prefix client run test -- src/components/MicButton.test.jsx
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/MicButton.jsx client/src/components/MicButton.test.jsx client/src/components/StatHeader.jsx client/src/index.css
git commit -m "feat: barge-in mic affordance, configured-voice badge, reduced-motion guard"
```

---

## Task 9: Rewire App.jsx onto the hook

**Files:**
- Modify: `client/src/App.jsx` (full rewrite)

**Interfaces:**
- Consumes: `useConversation` (Task 5), `TranscriptReview` (Task 6), `VoiceStatus` (Task 7), `MicButton`/`StatHeader` (Task 8), `MessageBubble` (existing).
- Produces: the thin container. Removes Ruta B (`useServerSTT`, `startListeningServer`, `handleAudioTurn`, `postTurnAudio` import, `audio.js` import). Gates replay to `idle`.

- [ ] **Step 1: Rewrite `client/src/App.jsx`**

```jsx
import { useEffect, useRef, useState } from "react";
import StatHeader from "./components/StatHeader.jsx";
import MessageBubble from "./components/MessageBubble.jsx";
import MicButton from "./components/MicButton.jsx";
import TranscriptReview from "./components/TranscriptReview.jsx";
import VoiceStatus from "./components/VoiceStatus.jsx";
import { useConversation } from "./hooks/useConversation.js";

export default function App() {
  const c = useConversation();
  const [textInput, setTextInput] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [c.messages, c.status, c.liveTranscript]);

  const busy = c.status === "thinking";
  const micButtonRef = useRef(null);
  const prevStatusRef = useRef(c.status);

  // Return focus to the mic button when leaving review (cancel/reRecord land on
  // an enabled button; send -> thinking leaves it disabled, where focus() is a
  // harmless no-op). Satisfies the spec's focus-return requirement.
  useEffect(() => {
    if (prevStatusRef.current === "review" && c.status !== "review") {
      micButtonRef.current?.focus();
    }
    prevStatusRef.current = c.status;
  }, [c.status]);

  function handleMicClick() {
    if (c.status === "listening") c.stopListening();
    else if (c.status === "speaking") c.interrupt();
    else if (c.status === "idle") c.startListening();
  }

  function handleTextSubmit(e) {
    e.preventDefault();
    if (c.status !== "idle" || !textInput.trim()) return;
    const text = textInput;
    setTextInput("");
    c.submitText(text);
  }

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      <StatHeader
        totalXp={c.totalXp}
        turns={c.turns}
        brain={c.providers.brain}
        tts={c.providers.tts}
        stt={c.providers.stt}
      />

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        {c.messages.map((m, i) => (
          <MessageBubble
            key={i}
            role={m.role}
            text={m.text}
            onReplay={m.role === "coach" && c.status === "idle" ? () => c.replay(m) : undefined}
          />
        ))}
        {c.status === "thinking" && (
          <p className="text-xs text-muted pl-1">coach is composing a reply…</p>
        )}
      </main>

      <footer className="px-5 pt-3 pb-5 border-t border-line/70 space-y-4">
        <VoiceStatus
          status={c.status}
          liveTranscript={c.liveTranscript}
          error={c.error}
          ttsFallbackActive={c.ttsFallbackActive}
          sttSupported={c.sttSupported}
          onDismissError={c.clearError}
        />

        {c.status === "review" ? (
          <TranscriptReview
            draft={c.draft}
            onEdit={c.editDraft}
            onSend={c.send}
            onReRecord={c.reRecord}
            onCancel={c.cancel}
          />
        ) : (
          <>
            <div className="flex justify-center">
              <MicButton ref={micButtonRef} status={c.status} onClick={handleMicClick} />
            </div>

            <form onSubmit={handleTextSubmit} className="flex gap-2">
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                disabled={busy}
                placeholder={c.sttSupported ? "…or type your reply" : "Type your reply (no mic detected)"}
                className="flex-1 bg-ink-2 border border-line rounded-xl px-4 py-2.5 text-sm placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-coach/50 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy || !textInput.trim()}
                className="px-4 py-2.5 rounded-xl bg-surface-2 border border-line text-sm font-medium hover:border-coach/60 hover:text-coach-soft transition disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </>
        )}
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Verify the client builds and the unit suite still passes**

Run:
```bash
npm --prefix client run build && npm --prefix client run test
```
Expected: build succeeds (no leftover imports of `postTurnAudio`/`audio.js`/`speech` helpers removed from App); all unit tests PASS.

- [ ] **Step 3: Add the focus-return test**

`client/src/App.test.jsx` (mocks the hook so status transitions are controllable):
```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./hooks/useConversation.js", () => ({ useConversation: vi.fn() }));
import { useConversation } from "./hooks/useConversation.js";
import App from "./App.jsx";

function hookState(over = {}) {
  return {
    messages: [{ role: "coach", text: "hi" }],
    status: "review",
    draft: "x",
    interim: "",
    liveTranscript: "",
    totalXp: 0,
    error: null,
    providers: { brain: "mock", tts: "kokoro", stt: "none" },
    ttsFallbackActive: false,
    sttSupported: true,
    turns: 0,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    editDraft: vi.fn(),
    send: vi.fn(),
    reRecord: vi.fn(),
    cancel: vi.fn(),
    interrupt: vi.fn(),
    submitText: vi.fn(),
    replay: vi.fn(),
    clearError: vi.fn(),
    ...over,
  };
}

describe("App focus management", () => {
  it("returns focus to the mic button when leaving review", () => {
    useConversation.mockReturnValue(hookState({ status: "review" }));
    const { rerender } = render(<App />);
    useConversation.mockReturnValue(hookState({ status: "idle" }));
    rerender(<App />);
    expect(screen.getByRole("button", { name: "Tap to speak" })).toHaveFocus();
  });
});
```
Run:
```bash
npm --prefix client run test -- src/App.test.jsx
```
Expected: PASS — focus lands on the mic button after review exits.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.jsx client/src/App.test.jsx
git commit -m "refactor: App consumes useConversation; remove client Ruta B; focus-return + gate replay to idle"
```

---

## Task 10: Automated accessibility checks

**Files:**
- Create: `client/src/components/__a11y__.test.jsx`

**Interfaces:**
- Consumes: `TranscriptReview`, `VoiceStatus` (axe over rendered states).

- [ ] **Step 1: Write axe tests**

`client/src/components/__a11y__.test.jsx`:
```js
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import VoiceStatus from "./VoiceStatus.jsx";
import TranscriptReview from "./TranscriptReview.jsx";

const vs = {
  status: "idle",
  liveTranscript: "",
  error: null,
  ttsFallbackActive: false,
  sttSupported: true,
  onDismissError: vi.fn(),
};

describe("accessibility", () => {
  it("VoiceStatus has no axe violations (idle)", async () => {
    const { container } = render(<VoiceStatus {...vs} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("VoiceStatus has no axe violations (error banner)", async () => {
    const { container } = render(<VoiceStatus {...vs} error="Microphone permission denied" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("TranscriptReview has no axe violations", async () => {
    const { container } = render(
      <TranscriptReview draft="hello" onEdit={vi.fn()} onSend={vi.fn()} onReRecord={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
```
Register the axe matcher: add to `client/src/test/setup.js` (top, after the jest-dom import):
```js
import { toHaveNoViolations } from "jest-axe";
import { expect } from "vitest";
expect.extend(toHaveNoViolations);
```

- [ ] **Step 2: Run tests to verify they pass (fix any real violations)**

Run:
```bash
npm --prefix client run test -- src/components/__a11y__.test.jsx
```
Expected: PASS. If axe flags the dismiss button or the label association, fix the component (e.g. ensure `aria-label` present) until green.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/__a11y__.test.jsx client/src/test/setup.js
git commit -m "test: axe accessibility checks for VoiceStatus and TranscriptReview"
```

---

## Task 11: End-to-end verification (Browser pane) + manual mic checklist

**Files:**
- Create: `docs/superpowers/plans/voice-io-verification-checklist.md`

**Interfaces:**
- Consumes: the running app (`npm run dev`) + kokoro-fastapi (Task 1).

> This task has no unit test — its deliverable is verified behavior + a recorded checklist. Use the Browser pane tools (`preview_start` with the `client` dev server) for the automatable checks; the Web Speech mic hop is manual.

- [ ] **Step 1: Start the full stack**

Ensure kokoro-fastapi is up (Task 1). Then:
```bash
npm run dev
```
Open the client (Vite serves `:5173`, proxying `/turn` + `/health` to `:3001`).

- [ ] **Step 2: Automated checks (Browser pane, no mic)**
Verify and note the result of each:
  1. StatHeader shows the "🔊 kokoro" badge (title "configured coach voice"); no STT badge (stt=none).
  2. Type "I went hiking yesterday" → Send → the **user bubble appears immediately**, then the coach bubble; coach audio plays (check the network panel: `/turn` returns a non-null `audio`; console has no errors).
  3. Kokoro-down fallback: temporarily set `KOKORO_URL` to a dead port in `server/.env`, restart the server, send a turn → reply still arrives, browser voice speaks, the "using browser voice" alert shows, and the badge still reads "kokoro" (no contradiction). Restore `KOKORO_URL` after.
  4. Error state: with Web Speech stubbed unsupported (or in a non-Chrome engine), confirm the "lacks speech recognition — use the text box" note renders and the text path still works.

- [ ] **Step 3: Manual mic checklist (real Chrome)**
Run through and check off:
  - Tap mic → grant permission → "Listening…" shows.
  - Speak two sentences with a pause in the middle → the session stays open across the pause (does not drop to review early); the live transcript updates.
  - Tap stop → the transcript appears editable in the review box, reasonably accurate.
  - Edit a word → Send → hear the Kokoro coach voice; XP increments.
  - While the coach is speaking, tap the mic (✋) → audio stops and it starts listening (barge-in).
  - Deny mic permission once → the permission alert shows and the text box still works.

- [ ] **Step 4: Record the checklist**

Create `docs/superpowers/plans/voice-io-verification-checklist.md` capturing the Step 2–3 items as a checked list with pass/fail + notes (kokoro image used, browser/version, any accent mis-recognition observed). This is the milestone's verification artifact.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/voice-io-verification-checklist.md
git commit -m "docs: voice I/O E2E + manual mic verification checklist"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 stack → Task 1; §4 config → Task 1; §5.1 state machine → Tasks 4–5; §5.2 hook/error-surface/playback controller → Tasks 4–5; §5.3 speech.js/MicButton/TranscriptReview/VoiceStatus/StatHeader → Tasks 3, 6, 7, 8; §5.4 remove client Ruta B → Task 9; §5.5 accessibility → Tasks 7, 8, 9 (focus-return), 10; §6 data flow (optimistic user bubble) → Tasks 4–5, verified Task 11; §7 error table (banner predicate, onerror taxonomy, silence restart, replay guard) → Tasks 5, 7; §8 testing (deps, jsdom stubs, scoped coverage, a11y) → Tasks 2, 3, 5, 10; §9 risks (silence onend, playback races) → Task 5; §10 file map → all; §11 DoD → Task 11.

**Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N"; every code step shows complete code.

**Type/name consistency:** `createRecognizer` callback names (`onResult`, `onInterim`, `onStart`, `onError`, `onEnd`) match between Task 3 and Task 5; hook API names (`startListening`, `stopListening`, `editDraft`, `send`, `reRecord`, `cancel`, `interrupt`, `submitText`, `replay`, `liveTranscript`, `ttsFallbackActive`, `sttSupported`, `clearError`) match between Tasks 4/5 and their consumers in Tasks 6–9. `providers.tts` used consistently.

---
*Not a git repo caveat resolved: the repo was `git init`-ed on 2026-07-24; each task commits independently.*
