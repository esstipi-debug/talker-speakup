# Pronunciation Drill Client Implementation Plan (M7 · plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-aloud drill UI: capture audio, score it, and surface at most three actionable errors ranked by intelligibility impact.

**Architecture:** A `usePronunciationDrill` hook with its own state machine (`prompt→recording→scoring→result`), deliberately separate from `useConversation`, which has a review/edit step and a brain call the drill has neither of. A fresh `lib/recorder.js` MediaRecorder primitive, a `lib/pronErrors.js` ranking function (spec §12 A8), and three components. Degrades to listen-and-repeat when scoring is unavailable.

**Tech Stack:** React 19, Vite, Tailwind v4, Vitest + Testing Library + jsdom, jest-axe, MediaRecorder API.

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

# M7 Pronunciation Layer — Chunk 3: The Client

Repo root (`REPO`): `C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e`
All paths below are absolute. All commands run **from `REPO`** in PowerShell.

**Read this before Task 1.** The client is plain JavaScript (no TypeScript, no PropTypes).
Hooks are **named** exports; components are **default** exports; every relative import carries an
explicit `.js` / `.jsx` extension. Tests import `describe/it/expect/vi` explicitly from `"vitest"`
even though `globals: true`. Test files sit **beside** their source. Real timers by default; fake
timers only inside `try { … } finally { vi.useRealTimers(); }`.

`client/src/hooks/useConversation.js` and `client/src/hooks/useConversation.test.js` are **not
touched by any task in this chunk**. The last task proves it with a `git diff`.

`client/src/lib/audio.js` is dead code (zero importers). It stays dead. Do **not** import it, edit
it, or delete it. `client/src/lib/recorder.js` is written from scratch.

---

### Task 1: Recorder test harness + capability probe

**Files:**
- Create: `REPO/client/src/lib/recorder.js`
- Create: `REPO/client/src/lib/recorder.test.js`
- Modify: `REPO/client/src/test/setup.js`

**Interfaces:**
- Consumes: `navigator.mediaDevices.getUserMedia`, global `MediaRecorder` (both stubbed in jsdom).
- Produces:
  - `export const MAX_DRILL_MS` — `15000`
  - `export const MIN_DRILL_MS` — `300`
  - `export function isRecordingSupported(): boolean`
  - `export class MockMediaRecorder` (test setup), `export function lastRecorder(): MockMediaRecorder`, `export function lastMicTrack(): { stop: Mock }` (test setup)

#### Step 1.1 — Add the MediaRecorder harness to the shared setup file

jsdom has no `MediaRecorder` and no `navigator.mediaDevices`. Mirror the existing
`MockSpeechRecognition` / `lastRecognizer()` pattern.

In `REPO/client/src/test/setup.js`, insert this block immediately after the `makeResults` function
(i.e. after the closing `}` on the line before `beforeEach(() => {`):

```js
// --- Mock MediaRecorder (jsdom has none) ---
export class MockMediaRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/webm";
    this.state = "inactive";
    this.ondataavailable = this.onstop = this.onerror = null;
    this.started = 0;
    this.stopped = 0;
    MockMediaRecorder.instances.push(this);
  }
  start() {
    this.started += 1;
    this.state = "recording";
  }
  stop() {
    this.stopped += 1;
    // The real API throws InvalidStateError when stopping an inactive recorder.
    if (this.state === "inactive") throw new Error("InvalidStateError");
    this.state = "inactive";
    // The real API fires onstop asynchronously; a microtask keeps that shape
    // without needing fake timers in every recorder test.
    queueMicrotask(() => this.onstop?.());
  }
  // test helpers
  emitData(blob) {
    this.ondataavailable?.({ data: blob });
  }
  emitError(name) {
    this.onerror?.({ error: name === undefined ? undefined : { name } });
  }
}
MockMediaRecorder.instances = [];
MockMediaRecorder.isTypeSupported = (type) => type === "audio/webm;codecs=opus";

export function lastRecorder() {
  const list = MockMediaRecorder.instances;
  return list[list.length - 1];
}

let micTrack = null;
/** The single MediaStreamTrack handed out by the stubbed getUserMedia this test. */
export function lastMicTrack() {
  return micTrack;
}
```

Then, inside the **existing** `beforeEach`, immediately after the line
`window.Element.prototype.scrollTo = vi.fn();`, add:

```js
  // --- mic capture stubs (jsdom has neither) ---
  MockMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  micTrack = { kind: "audio", stop: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [micTrack] }) },
  });
  // jsdom's Blob has no arrayBuffer(); FormData upload paths poke at it.
  window.Blob.prototype.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(8));
  // Assigned, not vi.stubGlobal({...URL}) — spreading URL drops its constructor.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
```

#### Step 1.2 — Write the failing test

Create `REPO/client/src/lib/recorder.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { isRecordingSupported, MAX_DRILL_MS, MIN_DRILL_MS } from "./recorder.js";

describe("recorder — capability probe", () => {
  it("reports support when both getUserMedia and MediaRecorder exist", () => {
    expect(isRecordingSupported()).toBe(true);
  });

  it("reports no support when MediaRecorder is missing", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(isRecordingSupported()).toBe(false);
  });

  it("reports no support when getUserMedia is missing", () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    expect(isRecordingSupported()).toBe(false);
  });

  it("caps a drill take at 15s and treats sub-300ms takes as mis-taps", () => {
    expect(MAX_DRILL_MS).toBe(15000);
    expect(MIN_DRILL_MS).toBe(300);
    expect(MIN_DRILL_MS).toBeLessThan(MAX_DRILL_MS);
  });
});
```

#### Step 1.3 — Run it and watch it fail

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected failure (the module does not exist yet):

```
Error: Failed to load url ./recorder.js (resolved id: .../client/src/lib/recorder.js)
in /client/src/lib/recorder.test.js. Does the file exist?
```

#### Step 1.4 — Minimal implementation

Create `REPO/client/src/lib/recorder.js`:

```js
/** Isolated MediaRecorder wrapper for the pronunciation drill. Rebuilt from
 *  scratch (design §10) — deliberately NOT restored from the removed Ruta B
 *  orchestration. lib/audio.js is untouched and stays dead. */

export const MAX_DRILL_MS = 15000; // hard cap so a stuck drill take can't record forever
export const MIN_DRILL_MS = 300; // shorter than this is a mis-tap, not an attempt

export function isRecordingSupported() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}
```

#### Step 1.5 — Run it and watch it pass

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected: `Test Files  1 passed (1)` / `Tests  4 passed (4)`.

#### Step 1.6 — Regression check + commit

```
npm --prefix client test
```

Expected: all pre-existing suites still pass (97 tests: the 93 that existed plus these 4).

```
git add client/src/lib/recorder.js client/src/lib/recorder.test.js client/src/test/setup.js
git diff --cached --name-only
git show :client/src/test/setup.js
git commit -m "feat(client): mic capture probe + MediaRecorder test harness"
```

`git diff --cached --name-only` must list exactly those three paths and nothing else.
`git show :<path>` reads the **staged** blob — this repo has shipped a commit referencing an
untracked file, so verify the index, not the worktree (spec §11).

---

### Task 2: `startRecording` happy path

**Files:**
- Modify: `REPO/client/src/lib/recorder.js`
- Test: `REPO/client/src/lib/recorder.test.js`

**Interfaces:**
- Consumes: `MockMediaRecorder`, `lastRecorder()` from `client/src/test/setup.js`.
- Produces: `export async function startRecording({ maxMs = MAX_DRILL_MS, onError, onAutoStop } = {}): Promise<RecorderHandle|null>`
  where `RecorderHandle = { mimeType: string, state: () => "recording"|"stopped"|"cancelled", stop: () => Promise<{ blob: Blob, durationMs: number }|null>, cancel: () => void }`.

#### Step 2.1 — Write the failing test

Append to `REPO/client/src/lib/recorder.test.js`:

```js
import { startRecording } from "./recorder.js";
import { lastRecorder, lastMicTrack } from "../test/setup.js";

describe("recorder — happy path", () => {
  it("negotiates a supported mime type and reports it on the handle", async () => {
    const handle = await startRecording();
    expect(handle.mimeType).toBe("audio/webm;codecs=opus");
    expect(handle.state()).toBe("recording");
    expect(lastRecorder().started).toBe(1);
  });

  it("resolves the captured blob and the elapsed duration on stop()", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const handle = await startRecording();
      lastRecorder().emitData(new Blob(["abc"]));
      nowSpy.mockReturnValue(2500);
      const take = await handle.stop();
      expect(take.blob.size).toBe(3);
      expect(take.durationMs).toBe(1500);
      expect(handle.state()).toBe("stopped");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("releases every microphone track once the take is stopped", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    await handle.stop();
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
  });
});
```

Note the second import statement is deliberate: the file already imports the constants at the top.
Move `startRecording` into the existing `./recorder.js` import line if you prefer — the test result
is identical.

#### Step 2.2 — Run it and watch it fail

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected failure:

```
TypeError: startRecording is not a function
```

#### Step 2.3 — Implementation

Append to `REPO/client/src/lib/recorder.js`:

```js
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pickSupportedMimeType() {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Requests the mic and starts a drill take. Resolves null (never throws) when
 * recording is unsupported or permission is refused — `onError` has already
 * fired in that case and the caller falls back to listen-and-repeat.
 *
 * @param {{ maxMs?: number, onError?: (code: string) => void, onAutoStop?: () => void }} [opts]
 * @returns {Promise<RecorderHandle|null>}
 */
export async function startRecording({ maxMs = MAX_DRILL_MS, onError, onAutoStop } = {}) {
  if (!isRecordingSupported()) {
    onError?.("unsupported");
    return null;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const startedAt = Date.now();

  let state = "recording";
  let handed = false; // a stop() result has already been handed to a caller
  let released = false;
  let maxTimer = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  function release() {
    if (released) return;
    released = true;
    if (maxTimer !== null) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
    stream.getTracks().forEach((track) => track.stop());
  }

  recorder.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => onError?.(e.error?.name || "recorder-error");
  recorder.onstop = () => {
    release();
    if (state === "cancelled") {
      resolveStopped(null);
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "" });
    if (blob.size === 0) {
      onError?.("empty-recording");
      resolveStopped(null);
      return;
    }
    resolveStopped({ blob, durationMs: Date.now() - startedAt });
  };

  recorder.start();
  maxTimer = setTimeout(() => {
    maxTimer = null;
    if (state !== "recording") return;
    state = "stopped";
    onAutoStop?.();
    recorder.stop();
  }, maxMs);

  return {
    mimeType: recorder.mimeType || mimeType || "",
    state: () => state,
    stop() {
      if (handed) return Promise.resolve(null);
      handed = true;
      if (state === "recording") {
        state = "stopped";
        recorder.stop();
      }
      return stopped;
    },
    cancel() {
      if (state === "cancelled") return;
      const wasRecording = state === "recording";
      state = "cancelled";
      chunks.length = 0;
      release();
      if (wasRecording) recorder.stop();
      resolveStopped(null);
    },
  };
}
```

#### Step 2.4 — Run it and watch it pass

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected: `Tests  7 passed (7)`.

#### Step 2.5 — Commit

```
git add client/src/lib/recorder.js client/src/lib/recorder.test.js
git diff --cached --name-only
git show :client/src/lib/recorder.js
git commit -m "feat(client): startRecording returns a blob + duration handle"
```

---

### Task 3: Permission refusal and capture failures

**Files:**
- Modify: `REPO/client/src/lib/recorder.js`
- Test: `REPO/client/src/lib/recorder.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports. `startRecording` gains its `null`-resolving failure branches; the
  `onError` code vocabulary becomes exactly `"unsupported" | <DOMException.name> | "recorder-error" | "empty-recording"`.

#### Step 3.1 — Write the failing test

Append to `REPO/client/src/lib/recorder.test.js`:

```js
describe("recorder — failure paths", () => {
  it("resolves null and reports 'unsupported' when MediaRecorder is missing", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const onError = vi.fn();
    await expect(startRecording({ onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("unsupported");
  });

  it("resolves null with the DOMException name when the user refuses the mic", async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const onError = vi.fn();
    await expect(startRecording({ onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("NotAllowedError");
  });

  it("falls back to 'mic-error' when the rejection carries no name", async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce({});
    const onError = vi.fn();
    await expect(startRecording({ onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("mic-error");
  });

  it("forwards recorder errors, defaulting to 'recorder-error'", async () => {
    const onError = vi.fn();
    await startRecording({ onError });
    lastRecorder().emitError("SecurityError");
    lastRecorder().emitError(undefined);
    expect(onError).toHaveBeenNthCalledWith(1, "SecurityError");
    expect(onError).toHaveBeenNthCalledWith(2, "recorder-error");
  });

  it("resolves null and reports 'empty-recording' when nothing was captured", async () => {
    const onError = vi.fn();
    const handle = await startRecording({ onError });
    await expect(handle.stop()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("empty-recording");
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
  });
});
```

#### Step 3.2 — Run it and watch it fail

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected failure (the `getUserMedia` rejection is currently unhandled):

```
× recorder — failure paths > resolves null with the DOMException name when the user refuses the mic
  → denied
```

The `unsupported`, `recorder-error` and `empty-recording` cases already pass — only the two
rejection tests fail. That is the correct RED: it isolates the missing `try/catch`.

#### Step 3.3 — Implementation

In `REPO/client/src/lib/recorder.js`, replace this line:

```js
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
```

with:

```js
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    onError?.(err?.name || "mic-error");
    return null;
  }
```

#### Step 3.4 — Run it and watch it pass

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected: `Tests  12 passed (12)`.

#### Step 3.5 — Commit

```
git add client/src/lib/recorder.js client/src/lib/recorder.test.js
git diff --cached --name-only
git show :client/src/lib/recorder.js
git commit -m "feat(client): recorder degrades to null on refused mic"
```

---

### Task 4: Recorder races — idempotent stop, cancel, and the 15s cap

**Files:**
- Test: `REPO/client/src/lib/recorder.test.js`

**Interfaces:**
- Consumes / Produces: no signature change. This task pins timing-shaped behaviour that Task 2's
  implementation already provides; it is the regression net for the drill's start/stop races.

#### Step 4.1 — Write the failing test

Append to `REPO/client/src/lib/recorder.test.js`:

```js
describe("recorder — races", () => {
  it("stop() is idempotent: the second call resolves null and does not re-stop", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    const first = await handle.stop();
    expect(first.blob.size).toBe(3);
    await expect(handle.stop()).resolves.toBeNull();
    expect(lastRecorder().stopped).toBe(1);
  });

  it("cancel() discards the take, releases the mic, and makes a later stop() resolve null", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    handle.cancel();
    expect(handle.state()).toBe("cancelled");
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
    await expect(handle.stop()).resolves.toBeNull();
  });

  it("cancel() is idempotent", async () => {
    const handle = await startRecording();
    handle.cancel();
    handle.cancel();
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
    expect(lastRecorder().stopped).toBe(1);
  });

  it("cancel() racing an in-flight stop() resolves that stop() with null", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    const pending = handle.stop(); // recorder.stop() queued its onstop microtask
    handle.cancel(); // lands synchronously, before onstop runs
    await expect(pending).resolves.toBeNull();
  });

  it("auto-stops at maxMs, notifies, and still hands the take to a later stop()", async () => {
    // Fake timers must be installed before startRecording, because the cap timer
    // is armed inside it. No waitFor runs under them, so this is safe.
    vi.useFakeTimers();
    try {
      const onAutoStop = vi.fn();
      const handle = await startRecording({ maxMs: 500, onAutoStop });
      lastRecorder().emitData(new Blob(["abcd"]));
      vi.advanceTimersByTime(500);
      expect(onAutoStop).toHaveBeenCalledTimes(1);
      expect(handle.state()).toBe("stopped");
      const take = await handle.stop();
      expect(take.blob.size).toBe(4);
      expect(lastRecorder().stopped).toBe(1); // the cap stopped it, stop() did not re-stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the cap after a manual stop", async () => {
    vi.useFakeTimers();
    try {
      const onAutoStop = vi.fn();
      const handle = await startRecording({ maxMs: 500, onAutoStop });
      lastRecorder().emitData(new Blob(["abcd"]));
      await handle.stop();
      vi.advanceTimersByTime(5000);
      expect(onAutoStop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

#### Step 4.2 — Run it

```
npm --prefix client test -- src/lib/recorder.test.js
```

Expected: `Tests  18 passed (18)`.

These pass against the Task 2 implementation. **That is intentional and it is not a stub-passing
test** — each one asserts an observable outcome (`stopped` call count, track release count,
resolved value) that a naive implementation gets wrong. To confirm the net has teeth before
committing, break it on purpose and watch it go red:

Temporarily change `cancel()`'s guard from `if (state === "cancelled") return;` to
`if (false) return;` and re-run. Expected failure:

```
× recorder — races > cancel() is idempotent
  → expected "spy" to be called 1 times, but got 2 times
```

Revert the change and re-run to green before committing.

#### Step 4.3 — Commit

```
git add client/src/lib/recorder.test.js
git diff --cached --name-only
git show :client/src/lib/recorder.test.js
git commit -m "test(client): pin recorder stop/cancel/cap races"
```

---

### Task 5: `postPronAssess` / `getPronPrompts` + the `/pron` dev proxy

**Files:**
- Modify: `REPO/client/src/lib/api.js`
- Modify: `REPO/client/vite.config.js`
- Test: `REPO/client/src/lib/api.pron.test.js` (create)

**Interfaces:**
- Consumes: server routes `POST /pron/assess` and `GET /pron/prompts` (chunk 2), the module-private
  `extensionFor(mimeType)` already in `api.js`.
- Produces:
  - `export async function postPronAssess({ blob, text, mode = "scripted" }): Promise<PronunciationReport>`
  - `export async function getPronPrompts({ focus } = {}): Promise<PromptSet>`
  - Both throw an `Error` carrying `.code` (from the server body, default `"PRON_UNAVAILABLE"`) and `.status`.

`api.js` has no test file today and is excluded from coverage. These two functions get one anyway:
they are the only place the typed `err.code` contract is materialised, and the whole
listen-and-repeat degradation hangs off it.

#### Step 5.1 — Write the failing test

Create `REPO/client/src/lib/api.pron.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { postPronAssess, getPronPrompts } from "./api.js";

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}
function errJson(status, body) {
  return { ok: false, status, json: async () => body };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("postPronAssess — request shape", () => {
  it("posts multipart audio/text/mode with a container-derived filename", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, pronProvider: "mock" }));
    const blob = new Blob(["take"], { type: "audio/ogg;codecs=opus" });

    await postPronAssess({ blob, text: "The ship is full of sheep." });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/pron/assess");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined(); // the browser owns the multipart boundary
    expect(init.body.get("text")).toBe("The ship is full of sheep.");
    expect(init.body.get("mode")).toBe("scripted");
    expect(init.body.get("audio").name).toBe("drill.ogg");
  });

  it("forwards an explicit mode", async () => {
    fetch.mockResolvedValue(okJson({ version: 1 }));
    await postPronAssess({ blob: new Blob(["x"]), text: "hi", mode: "unscripted" });
    expect(fetch.mock.calls[0][1].body.get("mode")).toBe("unscripted");
  });

  it("returns the parsed report on 200", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, pronProvider: "local", overall: { accuracy: 71 } }));
    const report = await postPronAssess({ blob: new Blob(["x"]), text: "hi" });
    expect(report.overall.accuracy).toBe(71);
  });
});

describe("postPronAssess — typed errors", () => {
  it("throws the server message and code", async () => {
    fetch.mockResolvedValue(
      errJson(422, { error: "Couldn't make out any speech in that recording.", code: "NO_SPEECH" }),
    );
    await expect(postPronAssess({ blob: new Blob(["x"]), text: "hi" })).rejects.toMatchObject({
      message: "Couldn't make out any speech in that recording.",
      code: "NO_SPEECH",
      status: 422,
    });
  });

  it("defaults to PRON_UNAVAILABLE and a generic message when the body is unreadable", async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });
    await expect(postPronAssess({ blob: new Blob(["x"]), text: "hi" })).rejects.toMatchObject({
      message: "Server error 502",
      code: "PRON_UNAVAILABLE",
      status: 502,
    });
  });
});

describe("getPronPrompts", () => {
  it("requests the full set when no focus is given", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, prompts: [] }));
    await getPronPrompts();
    expect(fetch).toHaveBeenCalledWith("/pron/prompts");
  });

  it("url-encodes the focus slug", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, prompts: [] }));
    await getPronPrompts({ focus: "s-cluster" });
    expect(fetch).toHaveBeenCalledWith("/pron/prompts?focus=s-cluster");
  });

  it("throws the typed UNKNOWN_FOCUS error", async () => {
    fetch.mockResolvedValue(errJson(400, { error: 'Unknown "focus".', code: "UNKNOWN_FOCUS" }));
    await expect(getPronPrompts({ focus: "nope" })).rejects.toMatchObject({
      code: "UNKNOWN_FOCUS",
      status: 400,
    });
  });
});
```

#### Step 5.2 — Run it and watch it fail

```
npm --prefix client test -- src/lib/api.pron.test.js
```

Expected failure:

```
SyntaxError: The requested module './api.js' does not provide an export named 'postPronAssess'
```

#### Step 5.3 — Implementation

Append to `REPO/client/src/lib/api.js` (after `postTurnAudio`, keeping every existing export
byte-identical):

```js
/**
 * Pronunciation drill scoring (design §4.4). Uploads the raw take together with
 * the reference sentence the learner was asked to read. Rejects with an Error
 * carrying `.code` (a PRON_ERROR_CODES member) so the caller can tell "offline"
 * from "we heard nothing".
 *
 * @param {{ blob: Blob, text: string, mode?: "scripted"|"unscripted" }} args
 */
export async function postPronAssess({ blob, text, mode = "scripted" }) {
  const form = new FormData();
  form.append("audio", blob, `drill.${extensionFor(blob.type)}`);
  form.append("text", text);
  form.append("mode", mode);

  const res = await fetch("/pron/assess", { method: "POST", body: form });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Server error ${res.status}`);
    err.code = data.code || "PRON_UNAVAILABLE";
    err.status = res.status;
    throw err;
  }
  return res.json(); // { version, mode, pronProvider, model, overall, prosody, words }
}

/** Curated drill set. `focus` omitted returns every prompt. */
export async function getPronPrompts({ focus } = {}) {
  const res = await fetch(`/pron/prompts${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`);

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Server error ${res.status}`);
    err.code = data.code || "PRON_UNAVAILABLE";
    err.status = res.status;
    throw err;
  }
  return res.json(); // { version, updated, focuses, prompts }
}
```

Also update the `getHealth` trailing comment in the same file — `/health` now reports `pron`:

```js
    return res.json(); // { status, brain, tts, stt, pron, ts }
```

#### Step 5.4 — Run it and watch it pass

```
npm --prefix client test -- src/lib/api.pron.test.js
```

Expected: `Tests  8 passed (8)`.

#### Step 5.5 — Add the dev proxy

In `REPO/client/vite.config.js`, the `proxy` block becomes:

```js
    proxy: {
      "/turn": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/progress": "http://localhost:3001",
      "/pron": "http://localhost:3001",
    },
```

Vite config is not exercised by the test run; verify by eye that all four prefixes are present.

#### Step 5.6 — Commit

```
npm --prefix client test
git add client/src/lib/api.js client/src/lib/api.pron.test.js client/vite.config.js
git diff --cached --name-only
git show :client/src/lib/api.js
git commit -m "feat(client): postPronAssess + getPronPrompts with typed error codes"
```

---

### Task 6: `rankPronErrors` — intelligibility impact beats score magnitude

**Files:**
- Create: `REPO/client/src/lib/pronErrors.js`
- Create: `REPO/client/src/lib/pronErrors.test.js`

**Interfaces:**
- Consumes: a `PronunciationReport` (`{ words: [{ word, accuracy, phones?: [{ ipa, score, substituted? }] }] }`).
- Produces:
  - `export const MAX_REPORTED_ERRORS` — `3`
  - `export const ERROR_SCORE_CEILING` — `60`
  - `export const MEANING_CHANGING_PAIRS: Readonly<Record<string, readonly string[]>>`
  - `export function rankPronErrors(report, { limit = MAX_REPORTED_ERRORS } = {}): PronError[]`
    where `PronError = { word, wordIndex, phoneIndex, ipa, substituted: string|null, score: number, impact: 2|1|0 }`.

This is design §6 in code: **at most 3 errors, ranked by intelligibility impact, not by score
deviation.** A meaning-changing substitution outranks a badly-scored phone that nobody would
misunderstand.

#### Step 6.1 — Write the failing test

Create `REPO/client/src/lib/pronErrors.test.js`:

```js
import { describe, it, expect } from "vitest";
import { rankPronErrors, MAX_REPORTED_ERRORS, ERROR_SCORE_CEILING } from "./pronErrors.js";

/** Report builder: words is [[word, [[ipa, score, substituted?], ...]], ...]. */
function report(words) {
  return {
    version: 1,
    mode: "scripted",
    model: "mock",
    overall: { accuracy: 50, fluency: 50, completeness: 100 },
    words: words.map(([word, phones]) => ({
      word,
      start: 0,
      end: 1,
      accuracy: 50,
      phones: phones.map(([ipa, score, substituted]) => ({
        ipa,
        score,
        start: 0,
        end: 0.1,
        ...(substituted === undefined ? {} : { substituted }),
      })),
    })),
  };
}

describe("rankPronErrors — intelligibility impact", () => {
  it("ranks the ship/sheep merge above a much worse-scoring dental /t/", () => {
    // The /t/ scores 12 — far worse in magnitude — but nobody misunderstands a
    // dental /t/. The iː -> ɪ substitution turns "sheep" into "ship".
    const errors = rankPronErrors(
      report([
        ["what", [["t", 12]]],
        ["sheep", [["iː", 55, "ɪ"]]],
      ]),
    );
    expect(errors.map((e) => e.ipa)).toEqual(["iː", "t"]);
    expect(errors[0]).toMatchObject({ word: "sheep", substituted: "ɪ", impact: 2 });
    expect(errors[1]).toMatchObject({ word: "what", substituted: null, impact: 0 });
  });

  it("ranks an unrecognised substitution between meaning-changing and accent-only", () => {
    const errors = rankPronErrors(
      report([
        ["butter", [["t", 20, "ɾ"]]], // substitution, not in the meaning-changing table -> 1
        ["thing", [["θ", 50, "s"]]], // meaning-changing -> 2
        ["park", [["k", 10]]], // no substitution -> 0
      ]),
    );
    expect(errors.map((e) => e.impact)).toEqual([2, 1, 0]);
    expect(errors.map((e) => e.word)).toEqual(["thing", "butter", "park"]);
  });

  it("breaks impact ties by the lower score first", () => {
    const errors = rankPronErrors(
      report([
        ["vote", [["v", 45, "b"]]],
        ["very", [["v", 12, "b"]]],
      ]),
    );
    expect(errors.map((e) => e.word)).toEqual(["very", "vote"]);
  });

  it("ignores phones at or above the error ceiling", () => {
    const errors = rankPronErrors(
      report([["sheep", [["iː", ERROR_SCORE_CEILING, "ɪ"], ["p", ERROR_SCORE_CEILING - 1]]]]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].ipa).toBe("p");
  });

  it("carries the indices needed to point back into the report", () => {
    const errors = rankPronErrors(report([["a", [["æ", 90]]], ["judge", [["dʒ", 20, "j"]]]]));
    expect(errors[0]).toMatchObject({ wordIndex: 1, phoneIndex: 0 });
  });

  it("caps the list at 3 by default", () => {
    const errors = rankPronErrors(
      report([["x", [["t", 1], ["d", 2], ["k", 3], ["p", 4], ["b", 5]]]]),
    );
    expect(errors).toHaveLength(MAX_REPORTED_ERRORS);
    expect(errors.map((e) => e.score)).toEqual([1, 2, 3]);
  });
});
```

#### Step 6.2 — Run it and watch it fail

```
npm --prefix client test -- src/lib/pronErrors.test.js
```

Expected failure:

```
Error: Failed to load url ./pronErrors.js (resolved id: .../client/src/lib/pronErrors.js)
in /client/src/lib/pronErrors.test.js. Does the file exist?
```

#### Step 6.3 — Implementation

Create `REPO/client/src/lib/pronErrors.js`:

```js
/** Presentation rule (design §6): at most 3 errors per attempt, ranked by
 *  intelligibility impact — not by score deviation. A phoneme error that changes
 *  the word outranks one that merely sounds foreign, however badly it scored. */

export const MAX_REPORTED_ERRORS = 3;
export const ERROR_SCORE_CEILING = 60; // at or above this a phone is not an "error"

/** Expected IPA -> substitutions that change the word, not just the accent. */
export const MEANING_CHANGING_PAIRS = Object.freeze({
  "iː": Object.freeze(["ɪ"]),
  ɪ: Object.freeze(["iː"]),
  æ: Object.freeze(["e", "ɛ", "ɑː"]),
  v: Object.freeze(["b"]),
  b: Object.freeze(["v"]),
  "dʒ": Object.freeze(["j", "ʒ", "tʃ"]),
  θ: Object.freeze(["t", "s"]),
  ð: Object.freeze(["d", "z"]),
  z: Object.freeze(["s"]),
});

/**
 * @typedef {object} PronError
 * @property {string} word
 * @property {number} wordIndex
 * @property {number} phoneIndex
 * @property {string} ipa             the expected phone
 * @property {string|null} substituted what was heard instead, or null when unknown
 * @property {number} score           0-100
 * @property {2|1|0} impact           2 = meaning-changing, 1 = substitution, 0 = accent-only
 */

/**
 * @param {import("./api.js").PronunciationReport} report
 * @param {{ limit?: number }} [opts]
 * @returns {PronError[]}
 */
export function rankPronErrors(report, { limit = MAX_REPORTED_ERRORS } = {}) {
  const words = report?.words;
  if (!Array.isArray(words)) return [];
  // Unscripted reports have no phones at all — render nothing rather than invent errors.
  if (!words.some((w) => Array.isArray(w.phones))) return [];

  const candidates = [];
  words.forEach((word, wordIndex) => {
    if (!Array.isArray(word.phones)) return;
    word.phones.forEach((phone, phoneIndex) => {
      if (!(phone.score < ERROR_SCORE_CEILING)) return;
      const substituted = phone.substituted ?? null;
      const impact = !substituted ? 0 : MEANING_CHANGING_PAIRS[phone.ipa]?.includes(substituted) ? 2 : 1;
      candidates.push({
        word: word.word,
        wordIndex,
        phoneIndex,
        ipa: phone.ipa,
        substituted,
        score: phone.score,
        impact,
      });
    });
  });

  candidates.sort(
    (a, b) =>
      b.impact - a.impact ||
      a.score - b.score ||
      a.wordIndex - b.wordIndex ||
      a.phoneIndex - b.phoneIndex,
  );
  return candidates.slice(0, limit);
}
```

#### Step 6.4 — Run it and watch it pass

```
npm --prefix client test -- src/lib/pronErrors.test.js
```

Expected: `Tests  6 passed (6)`.

#### Step 6.5 — Commit

```
git add client/src/lib/pronErrors.js client/src/lib/pronErrors.test.js
git diff --cached --name-only
git show :client/src/lib/pronErrors.js
git commit -m "feat(client): rank pronunciation errors by intelligibility impact"
```

---

### Task 7: `rankPronErrors` edge cases — stripped phones, determinism, custom limit

**Files:**
- Test: `REPO/client/src/lib/pronErrors.test.js`

**Interfaces:**
- Consumes / Produces: no signature change. Pins the unscripted contract (§3: "unscripted mode
  never shows phonemes") at the presentation boundary.

#### Step 7.1 — Write the failing test

Append to `REPO/client/src/lib/pronErrors.test.js`:

```js
describe("rankPronErrors — degenerate input", () => {
  it("returns [] for a null or empty report", () => {
    expect(rankPronErrors(null)).toEqual([]);
    expect(rankPronErrors(undefined)).toEqual([]);
    expect(rankPronErrors({})).toEqual([]);
    expect(rankPronErrors({ words: [] })).toEqual([]);
  });

  it("returns [] for an unscripted report where every word had its phones stripped", () => {
    const stripped = {
      version: 1,
      mode: "unscripted",
      model: "mock",
      overall: { accuracy: 40, fluency: 60, completeness: 100 },
      words: [
        { word: "the", start: 0, end: 0.2, accuracy: 30 },
        { word: "sheep", start: 0.2, end: 0.9, accuracy: 20 },
      ],
    };
    expect(rankPronErrors(stripped)).toEqual([]);
  });

  it("skips phone-less words in a mixed report instead of throwing", () => {
    const mixed = report([["sheep", [["iː", 20, "ɪ"]]]]);
    mixed.words.push({ word: "quiet", start: 1, end: 2, accuracy: 10 });
    const errors = rankPronErrors(mixed);
    expect(errors).toHaveLength(1);
    expect(errors[0].word).toBe("sheep");
  });

  it("is deterministic — two runs on the same report produce the same order", () => {
    const r = report([
      ["a", [["t", 30], ["d", 30]]],
      ["b", [["k", 30]]],
    ]);
    expect(rankPronErrors(r)).toEqual(rankPronErrors(r));
    expect(rankPronErrors(r).map((e) => `${e.wordIndex}:${e.phoneIndex}`)).toEqual([
      "0:0",
      "0:1",
      "1:0",
    ]);
  });

  it("honours an explicit limit", () => {
    const errors = rankPronErrors(report([["x", [["t", 1], ["d", 2], ["k", 3]]]]), { limit: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0].ipa).toBe("t");
  });

  it("does not mutate the report it was given", () => {
    const r = report([["sheep", [["iː", 20, "ɪ"]]]]);
    const snapshot = JSON.stringify(r);
    rankPronErrors(r);
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});
```

#### Step 7.2 — Run it

```
npm --prefix client test -- src/lib/pronErrors.test.js
```

Expected: `Tests  12 passed (12)`. All pass against Task 6's implementation.

To prove the unscripted guard is load-bearing rather than incidental, temporarily delete this line
from `pronErrors.js`:

```js
  if (!words.some((w) => Array.isArray(w.phones))) return [];
```

and re-run. The suite stays green — the `forEach` guard already skips phone-less words — which
tells you the early return is a **readability** guard, not a correctness one. Restore it (the
frozen contract requires it) and note that the real protection is the per-word
`if (!Array.isArray(word.phones)) return;`, which the "mixed report" test does cover: delete *that*
line instead and re-run to see

```
× rankPronErrors — degenerate input > skips phone-less words in a mixed report instead of throwing
  → Cannot read properties of undefined (reading 'forEach')
```

Restore it and confirm green before committing.

#### Step 7.3 — Commit

```
git add client/src/lib/pronErrors.test.js
git diff --cached --name-only
git show :client/src/lib/pronErrors.test.js
git commit -m "test(client): pin unscripted + degenerate ranking input"
```

---

### Task 8: `usePronunciationDrill` — mount, prompt load, and the no-microphone stop

**Files:**
- Create: `REPO/client/src/hooks/usePronunciationDrill.js`
- Create: `REPO/client/src/hooks/usePronunciationDrill.test.js`

**Interfaces:**
- Consumes: `getPronPrompts`, `postPronAssess` (`../lib/api.js`); `isRecordingSupported`,
  `startRecording`, `MIN_DRILL_MS` (`../lib/recorder.js`); `rankPronErrors` (`../lib/pronErrors.js`).
- Produces: `export function usePronunciationDrill({ focus = null } = {}): DrillApi` — the flat bag
  documented in Step 8.3. This task lands the whole file; Tasks 9–12 add tests that pin the rest of
  its branches without changing the signature.

The hook mirrors `useConversation.js`'s **ref-mirror** discipline: every value read inside a
callback that outlives its render is read from a ref, never from the state variable. Without it the
recorder's `onAutoStop`, the post-`await` writes, and the unmount cleanup all read a frozen render.

#### Step 8.1 — Write the failing test

Create `REPO/client/src/hooks/usePronunciationDrill.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// --- steering flags, mutated per test (mirrors useConversation.test.js) ---
let micSupported = true;
let nextHandleNull = false; // force the next startRecording() -> null once
let takeResult = null; // what the next handle.stop() resolves
let lastHandle = null;
let lastStartOpts = null;

function makeHandle() {
  let state = "recording";
  lastHandle = {
    mimeType: "audio/webm",
    state: () => state,
    stop: vi.fn(async () => {
      state = "stopped";
      return takeResult;
    }),
    cancel: vi.fn(() => {
      state = "cancelled";
    }),
  };
  return lastHandle;
}

vi.mock("../lib/api.js", () => ({
  getPronPrompts: vi.fn(),
  postPronAssess: vi.fn(),
}));

vi.mock("../lib/recorder.js", async () => {
  const actual = await vi.importActual("../lib/recorder.js");
  return {
    ...actual,
    isRecordingSupported: () => micSupported,
    startRecording: async (opts) => {
      lastStartOpts = opts;
      if (nextHandleNull) {
        nextHandleNull = false;
        return null;
      }
      return makeHandle();
    },
  };
});

import { getPronPrompts, postPronAssess } from "../lib/api.js";
import { usePronunciationDrill } from "./usePronunciationDrill.js";

const PROMPTS = {
  version: 1,
  updated: "2026-07-27",
  focuses: ["ih-iy", "v-b"],
  prompts: [
    {
      id: "ih-iy-01",
      focus: "ih-iy",
      text: "The ship is full of sheep.",
      ipaTargets: ["ɪ", "iː"],
      keyWords: ["ship", "sheep"],
      contrast: "vowel length + quality",
      level: "B2",
    },
    {
      id: "v-b-01",
      focus: "v-b",
      text: "Vote for the boat.",
      ipaTargets: ["v", "b"],
      keyWords: ["vote", "boat"],
      contrast: "phonemic in English, allophonic in Spanish",
      level: "B1",
    },
  ],
};

const REPORT = {
  version: 1,
  mode: "scripted",
  pronProvider: "mock",
  model: "mock",
  overall: { accuracy: 62, fluency: 71, completeness: 100 },
  prosody: {
    speechRateWpm: 120,
    articulationRateSyllPerSec: 4,
    pauseCount: 0,
    pauseTotalSec: 0,
    f0MinHz: null,
    f0MaxHz: null,
    f0RangeSemitones: null,
  },
  words: [
    { word: "the", start: 0, end: 0.2, accuracy: 90, phones: [{ ipa: "ð", score: 90, start: 0, end: 0.2 }] },
    {
      word: "sheep",
      start: 0.2,
      end: 0.8,
      accuracy: 48,
      phones: [
        { ipa: "ʃ", score: 88, start: 0.2, end: 0.35 },
        { ipa: "iː", score: 31, start: 0.35, end: 0.6, substituted: "ɪ" },
        { ipa: "p", score: 25, start: 0.6, end: 0.8 },
      ],
    },
  ],
};

beforeEach(() => {
  micSupported = true;
  nextHandleNull = false;
  lastHandle = null;
  lastStartOpts = null;
  takeResult = { blob: new Blob(["take"]), durationMs: 1200 };
  getPronPrompts.mockReset();
  getPronPrompts.mockResolvedValue(PROMPTS);
  postPronAssess.mockReset();
  postPronAssess.mockResolvedValue(REPORT);
});

/** Mount and wait out the prompt fetch, so every test starts settled. */
async function mounted(opts) {
  const utils = renderHook(() => usePronunciationDrill(opts));
  await waitFor(() => expect(utils.result.current.status).toBe("prompt"));
  return utils;
}

describe("usePronunciationDrill — mount", () => {
  it("loads the prompt set and lands on the first prompt", async () => {
    const { result } = await mounted();
    expect(getPronPrompts).toHaveBeenCalledWith({ focus: null });
    expect(result.current.prompts).toHaveLength(2);
    expect(result.current.promptIndex).toBe(0);
    expect(result.current.prompt.text).toBe("The ship is full of sheep.");
    expect(result.current.report).toBeNull();
    expect(result.current.errors).toEqual([]);
    expect(result.current.attempts).toBe(0);
    expect(result.current.micSupported).toBe(true);
  });

  it("passes the focus filter through to the server", async () => {
    await mounted({ focus: "v-b" });
    expect(getPronPrompts).toHaveBeenCalledWith({ focus: "v-b" });
  });

  it("disables the drill with an explicit reason when there is no microphone", async () => {
    micSupported = false;
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBe(
      "No microphone available — the drill needs audio it can score.",
    );
    expect(result.current.micSupported).toBe(false);
    // It cannot fall back to typing — there is no audio to score, so it must not
    // even ask the server for prompts.
    expect(getPronPrompts).not.toHaveBeenCalled();
  });

  it("degrades to unavailable when the prompt fetch fails", async () => {
    getPronPrompts.mockRejectedValueOnce(new Error("Server error 500"));
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBe("Server error 500");
    expect(result.current.prompt).toBeNull();
  });

  it("degrades to unavailable when the server returns an empty prompt set", async () => {
    getPronPrompts.mockResolvedValueOnce({ ...PROMPTS, prompts: [] });
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBe("No drill prompts are available right now.");
    expect(result.current.promptIndex).toBe(-1);
  });
});
```

#### Step 8.2 — Run it and watch it fail

```
npm --prefix client test -- src/hooks/usePronunciationDrill.test.js
```

Expected failure:

```
Error: Failed to load url ./usePronunciationDrill.js
(resolved id: .../client/src/hooks/usePronunciationDrill.js)
in /client/src/hooks/usePronunciationDrill.test.js. Does the file exist?
```

#### Step 8.3 — Implementation (the whole hook)

Create `REPO/client/src/hooks/usePronunciationDrill.js`:

```js
import { useEffect, useRef, useState } from "react";
import { getPronPrompts, postPronAssess } from "../lib/api.js";
import {
  isRecordingSupported,
  startRecording as startRecorder,
  MIN_DRILL_MS,
} from "../lib/recorder.js";
import { rankPronErrors } from "../lib/pronErrors.js";

const SCORING_TIMEOUT_MS = 35000; // client-side guard sitting above the server's PRON_TIMEOUT_MS
const NO_MIC_MSG = "No microphone available — the drill needs audio it can score.";
const NO_PROMPTS_MSG = "No drill prompts are available right now.";
const SIDECAR_DOWN_MSG = "Scoring is offline. Listen and repeat — no score this round.";
const TOO_SHORT_MSG = "That take was too short — read the whole sentence out loud.";
const MIC_DENIED_MSG = "Microphone access was refused. Allow it, then try again.";

/**
 * Owns the drill loop end to end: prompt selection, a single recorder handle,
 * the assess round-trip, and the ranked result. State machine:
 * prompt -> recording -> scoring -> result, with `unavailable` as the
 * listen-and-repeat degradation branch (design §7).
 *
 * `useConversation` is deliberately untouched — its machine has a review step
 * and a brain call, this one has neither.
 *
 * @param {{ focus?: string|null }} [opts]
 */
export function usePronunciationDrill({ focus = null } = {}) {
  const [status, setStatus] = useState("loading");
  const [prompts, setPrompts] = useState([]);
  const [promptIndex, setPromptIndex] = useState(-1);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [scoringUnavailable, setScoringUnavailable] = useState(false);
  const [pronProvider, setPronProvider] = useState(null);
  const [attempts, setAttempts] = useState(0);

  const prompt = promptIndex >= 0 ? (prompts[promptIndex] ?? null) : null;
  const micSupported = isRecordingSupported();

  // imperative refs
  const recorderRef = useRef(null);
  const mountedRef = useRef(true);
  const attemptSeqRef = useRef(0);

  // state mirrors — read from callbacks that outlive their render
  const statusRef = useRef("loading");
  const promptRef = useRef(null);
  const promptsRef = useRef([]);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  useEffect(() => { promptsRef.current = prompts; }, [prompts]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isRecordingSupported()) {
      // Nothing to fetch: without a mic there is no audio to score, and the
      // drill cannot fall back to the text input.
      setError(NO_MIC_MSG);
      setStatus("unavailable");
      return () => {
        mountedRef.current = false;
      };
    }
    getPronPrompts({ focus })
      .then((set) => {
        if (!mountedRef.current) return;
        const list = set?.prompts ?? [];
        setPrompts(list);
        setPromptIndex(list.length > 0 ? 0 : -1);
        if (list.length === 0) {
          setError(NO_PROMPTS_MSG);
          setStatus("unavailable");
          return;
        }
        setStatus("prompt");
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(err.message);
        setStatus("unavailable");
      });
    return () => {
      mountedRef.current = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, [focus]);

  // ---------------- scoring ----------------

  async function scoreTake(blob, seq) {
    let guard = null;
    try {
      const scored = await Promise.race([
        postPronAssess({ blob, text: promptRef.current.text, mode: "scripted" }),
        new Promise((_, reject) => {
          guard = setTimeout(() => {
            const err = new Error(SIDECAR_DOWN_MSG);
            err.code = "PRON_UNAVAILABLE";
            reject(err);
          }, SCORING_TIMEOUT_MS);
        }),
      ]);
      if (!mountedRef.current || attemptSeqRef.current !== seq) return;
      setReport(scored);
      setPronProvider(scored.pronProvider ?? null);
      setAttempts((n) => n + 1);
      setStatus("result");
    } catch (err) {
      if (!mountedRef.current || attemptSeqRef.current !== seq) return;
      if (err.code === "PRON_UNAVAILABLE") {
        setScoringUnavailable(true);
        setError(SIDECAR_DOWN_MSG);
        setStatus("unavailable");
        return;
      }
      setError(err.message);
      setStatus("prompt");
    } finally {
      if (guard !== null) clearTimeout(guard);
    }
  }

  // ---------------- capture ----------------

  function handleRecorderError(code) {
    if (!mountedRef.current) return;
    setError(code === "NotAllowedError" ? MIC_DENIED_MSG : `Recording failed (${code}).`);
  }

  async function startRecording() {
    if (statusRef.current !== "prompt") return;
    setError(null);
    attemptSeqRef.current += 1;
    setStatus("recording");

    const handle = await startRecorder({
      onError: handleRecorderError,
      onAutoStop: () => stopRecording(),
    });

    if (!mountedRef.current) {
      handle?.cancel();
      return;
    }
    if (!handle) {
      setStatus("prompt");
      return;
    }
    // The learner may have cancelled while the permission prompt was open.
    if (statusRef.current !== "recording") {
      handle.cancel();
      return;
    }
    recorderRef.current = handle;
  }

  async function stopRecording() {
    if (statusRef.current !== "recording") return;
    const handle = recorderRef.current;
    if (!handle) {
      setStatus("prompt");
      return;
    }
    const seq = attemptSeqRef.current;
    setStatus("scoring"); // also the re-entrancy guard against a double tap

    const take = await handle.stop();
    recorderRef.current = null;
    if (!mountedRef.current || attemptSeqRef.current !== seq) return;
    if (!take) {
      setStatus("prompt"); // the recorder already reported why via onError
      return;
    }
    if (take.durationMs < MIN_DRILL_MS) {
      setError(TOO_SHORT_MSG);
      setStatus("prompt");
      return;
    }
    await scoreTake(take.blob, seq);
  }

  function cancelRecording() {
    if (statusRef.current !== "recording") return;
    attemptSeqRef.current += 1; // invalidate anything already in flight for this take
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setError(null);
    setStatus("prompt");
  }

  // ---------------- navigation ----------------

  function retry() {
    if (statusRef.current !== "result" && statusRef.current !== "unavailable") return;
    if (!promptRef.current) return; // no-mic / no-prompts has nothing to retry
    setReport(null);
    setError(null);
    setStatus("prompt");
  }

  function nextPrompt() {
    if (statusRef.current === "recording" || statusRef.current === "scoring") return;
    const list = promptsRef.current;
    if (list.length === 0) return;
    setPromptIndex((i) => (i + 1) % list.length);
    setReport(null);
    setError(null);
    setStatus("prompt");
  }

  function selectPrompt(id) {
    if (statusRef.current === "recording" || statusRef.current === "scoring") return;
    const index = promptsRef.current.findIndex((p) => p.id === id);
    if (index === -1) return;
    setPromptIndex(index);
    setReport(null);
    setError(null);
    setStatus("prompt");
  }

  return {
    status,
    prompt,
    prompts,
    promptIndex,
    report,
    errors: rankPronErrors(report),
    error,
    micSupported,
    scoringUnavailable,
    pronProvider,
    attempts,
    startRecording,
    stopRecording,
    cancelRecording,
    retry,
    nextPrompt,
    selectPrompt,
    clearError: () => setError(null),
  };
}
```

#### Step 8.4 — Run it and watch it pass

```
npm --prefix client test -- src/hooks/usePronunciationDrill.test.js
```

Expected: `Tests  5 passed (5)`.

#### Step 8.5 — Commit

```
git add client/src/hooks/usePronunciationDrill.js client/src/hooks/usePronunciationDrill.test.js
git diff --cached --name-only
git show :client/src/hooks/usePronunciationDrill.js
git commit -m "feat(client): drill state machine with prompt load + no-mic stop"
```

---

### Task 9: Drill happy path — record, score, ranked result

**Files:**
- Test: `REPO/client/src/hooks/usePronunciationDrill.test.js`

**Interfaces:**
- Consumes: the mocked `startRecording` handle and `postPronAssess` from Task 8's test module.
- Produces: no new exports.

#### Step 9.1 — Write the failing test

Append to `REPO/client/src/hooks/usePronunciationDrill.test.js`:

```js
describe("usePronunciationDrill — scoring round trip", () => {
  it("walks prompt -> recording -> scoring -> result", async () => {
    const { result } = await mounted();

    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));

    act(() => result.current.stopRecording());
    await waitFor(() => expect(result.current.status).toBe("result"));

    expect(lastHandle.stop).toHaveBeenCalledTimes(1);
    expect(result.current.report.overall.accuracy).toBe(62);
    expect(result.current.pronProvider).toBe("mock");
    expect(result.current.attempts).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("sends the reference sentence of the active prompt in scripted mode", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => result.current.stopRecording());
    await waitFor(() => expect(result.current.status).toBe("result"));

    expect(postPronAssess).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      text: "The ship is full of sheep.",
      mode: "scripted",
    });
  });

  it("exposes at most 3 errors, meaning-changing first", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => result.current.stopRecording());
    await waitFor(() => expect(result.current.status).toBe("result"));

    expect(result.current.errors).toHaveLength(2);
    expect(result.current.errors[0]).toMatchObject({ ipa: "iː", substituted: "ɪ", impact: 2 });
    expect(result.current.errors[1]).toMatchObject({ ipa: "p", substituted: null, impact: 0 });
  });

  it("counts a second successful attempt", async () => {
    const { result } = await mounted();
    for (const _ of [0, 1]) {
      act(() => result.current.startRecording());
      await waitFor(() => expect(result.current.status).toBe("recording"));
      act(() => result.current.stopRecording());
      await waitFor(() => expect(result.current.status).toBe("result"));
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.status).toBe("prompt"));
    }
    expect(result.current.attempts).toBe(2);
    expect(result.current.report).toBeNull(); // retry clears the previous score
  });
});
```

#### Step 9.2 — Run it

```
npm --prefix client test -- src/hooks/usePronunciationDrill.test.js
```

Expected: `Tests  9 passed (9)` — the machine from Task 8 already implements this path. To prove
these are behaviour assertions rather than stub-passers, temporarily change `scoreTake`'s
`setStatus("result")` to `setStatus("prompt")` and re-run:

```
× usePronunciationDrill — scoring round trip > walks prompt -> recording -> scoring -> result
  → Timed out in waitFor: expected 'prompt' to be 'result'
```

Revert and confirm green.

#### Step 9.3 — Commit

```
git add client/src/hooks/usePronunciationDrill.test.js
git diff --cached --name-only
git show :client/src/hooks/usePronunciationDrill.test.js
git commit -m "test(client): pin the drill record->score->result path"
```

---

### Task 10: Listen-and-repeat degradation when scoring is offline

**Files:**
- Test: `REPO/client/src/hooks/usePronunciationDrill.test.js`

**Interfaces:**
- Consumes: `postPronAssess` rejections carrying `.code`.
- Produces: no new exports. Pins design §7 row 1 — sidecar down ⇒ the drill keeps running as
  listen-and-repeat rather than breaking.

#### Step 10.1 — Write the failing test

Append to `REPO/client/src/hooks/usePronunciationDrill.test.js`:

```js
/** Drive one full take and stop awaiting at `until`. */
async function take(result, until) {
  act(() => result.current.startRecording());
  await waitFor(() => expect(result.current.status).toBe("recording"));
  act(() => result.current.stopRecording());
  await waitFor(() => expect(result.current.status).toBe(until));
}

describe("usePronunciationDrill — degradation", () => {
  it("falls back to listen-and-repeat when the scorer is offline", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("Pronunciation scoring is offline."), { code: "PRON_UNAVAILABLE" }),
    );

    await take(result, "unavailable");

    expect(result.current.scoringUnavailable).toBe(true);
    expect(result.current.error).toBe(
      "Scoring is offline. Listen and repeat — no score this round.",
    );
    expect(result.current.report).toBeNull();
    expect(result.current.errors).toEqual([]);
    expect(result.current.attempts).toBe(0); // an unscored take is not an attempt
  });

  it("lets the learner retry straight back into the same prompt after going offline", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("offline"), { code: "PRON_UNAVAILABLE" }),
    );
    await take(result, "unavailable");

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("prompt"));
    expect(result.current.prompt.id).toBe("ih-iy-01");
    // The offline flag is sticky for the session so the UI keeps the notice.
    expect(result.current.scoringUnavailable).toBe(true);
  });

  it("recovers to a real score once the sidecar answers again", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("offline"), { code: "PRON_UNAVAILABLE" }),
    );
    await take(result, "unavailable");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("prompt"));

    await take(result, "result");
    expect(result.current.report.overall.accuracy).toBe(62);
    expect(result.current.attempts).toBe(1);
  });

  it("keeps a non-fatal scoring error on the prompt screen", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("Couldn't make out any speech in that recording."), {
        code: "NO_SPEECH",
      }),
    );

    await take(result, "prompt");

    expect(result.current.error).toBe("Couldn't make out any speech in that recording.");
    expect(result.current.scoringUnavailable).toBe(false);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("treats a hung scorer as offline once the client guard fires", async () => {
    const { result } = await mounted();
    postPronAssess.mockImplementationOnce(() => new Promise(() => {})); // never settles

    // Timer *spy*, not fake timers: mounted() already used a real-timer waitFor,
    // and this is the repo's idiom for firing a deferred callback by hand.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      act(() => result.current.startRecording());
      await waitFor(() => expect(result.current.status).toBe("recording"));
      act(() => result.current.stopRecording());
      await waitFor(() => expect(result.current.status).toBe("scoring"));

      const armed = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 35000);
      expect(armed).toBeDefined();
      act(() => armed[0]());

      await waitFor(() => expect(result.current.status).toBe("unavailable"));
      expect(result.current.scoringUnavailable).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("reports a refused microphone and returns to the prompt", async () => {
    const { result } = await mounted();
    nextHandleNull = true;
    act(() => result.current.startRecording());
    // startRecording resolved null -> the machine bounces back without recording.
    await waitFor(() => expect(result.current.status).toBe("prompt"));
    act(() => lastStartOpts.onError("NotAllowedError"));
    expect(result.current.error).toBe("Microphone access was refused. Allow it, then try again.");
  });

  it("surfaces any other recorder error verbatim", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => lastStartOpts.onError("empty-recording"));
    expect(result.current.error).toBe("Recording failed (empty-recording).");
  });

  it("returns to the prompt when the recorder hands back no take", async () => {
    const { result } = await mounted();
    takeResult = null;
    await take(result, "prompt");
    expect(postPronAssess).not.toHaveBeenCalled();
  });

  it("rejects a mis-tap shorter than the minimum take", async () => {
    const { result } = await mounted();
    takeResult = { blob: new Blob(["t"]), durationMs: 120 };
    await take(result, "prompt");
    expect(result.current.error).toBe(
      "That take was too short — read the whole sentence out loud.",
    );
    expect(postPronAssess).not.toHaveBeenCalled();
  });
});
```

#### Step 10.2 — Run it

```
npm --prefix client test -- src/hooks/usePronunciationDrill.test.js
```

Expected: `Tests  18 passed (18)`.

Prove the degradation branch is real: temporarily delete the
`if (err.code === "PRON_UNAVAILABLE") { … return; }` block from `scoreTake` and re-run.

```
× usePronunciationDrill — degradation > falls back to listen-and-repeat when the scorer is offline
  → Timed out in waitFor: expected 'prompt' to be 'unavailable'
```

Restore it and confirm green.

#### Step 10.3 — Commit

```
git add client/src/hooks/usePronunciationDrill.test.js
git diff --cached --name-only
git show :client/src/hooks/usePronunciationDrill.test.js
git commit -m "test(client): pin listen-and-repeat degradation + recorder errors"
```

---

### Task 11: Timing-shaped failures — unmount during scoring, stale takes, cancel races

**Files:**
- Test: `REPO/client/src/hooks/usePronunciationDrill.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports. This is the drill's equivalent of the voice loop's race suite; the
  spec calls these failure modes out by name (§8: "recorder start/stop races, unmount during
  scoring").

#### Step 11.1 — Write the failing test

Append to `REPO/client/src/hooks/usePronunciationDrill.test.js`:

```js
describe("usePronunciationDrill — races", () => {
  it("does not write state after unmounting mid-scoring", async () => {
    let settle;
    postPronAssess.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const errorSpy = vi.spyOn(console, "error");
    try {
      const { result, unmount } = await mounted();
      act(() => result.current.startRecording());
      await waitFor(() => expect(result.current.status).toBe("recording"));
      act(() => result.current.stopRecording());
      await waitFor(() => expect(result.current.status).toBe("scoring"));

      unmount();
      await act(async () => {
        settle(REPORT);
      });

      // No "state update on an unmounted component" warning, and the last
      // rendered snapshot never advanced past `scoring`.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(result.current.status).toBe("scoring");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("cancels the live recorder when the component unmounts mid-take", async () => {
    const { result, unmount } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    const handle = lastHandle;
    unmount();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it("discards a stale response when the take was cancelled and restarted", async () => {
    const slow = { ...REPORT, overall: { ...REPORT.overall, accuracy: 11 } };
    let settleSlow;
    postPronAssess.mockImplementationOnce(() => new Promise((resolve) => { settleSlow = resolve; }));

    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => result.current.stopRecording());
    await waitFor(() => expect(result.current.status).toBe("scoring"));

    // A fresh take starts (attemptSeq moves) before the first response lands.
    // `scoring` blocks startRecording, so the learner reaches it via the guard-free
    // path the UI actually offers: the request is invalidated by the next attempt.
    act(() => result.current.selectPrompt("v-b-01"));
    await waitFor(() => expect(result.current.prompt.id).toBe("v-b-01"));
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));

    await act(async () => {
      settleSlow(slow);
    });

    expect(result.current.report).toBeNull(); // the stale 11 never landed
    expect(result.current.status).toBe("recording");
  });

  it("cancelRecording releases the mic and returns to the prompt", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    const handle = lastHandle;

    act(() => result.current.cancelRecording());

    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("prompt");
    expect(result.current.error).toBeNull();
    expect(handle.stop).not.toHaveBeenCalled();
  });

  it("cancelling while the permission prompt is open releases the late handle", async () => {
    // startRecording sets `recording` before awaiting getUserMedia, so a cancel
    // can land first. The handle must be released, not adopted.
    const { result } = await mounted();
    act(() => {
      result.current.startRecording();
      result.current.cancelRecording();
    });
    await waitFor(() => expect(result.current.status).toBe("prompt"));
    await waitFor(() => expect(lastHandle.cancel).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("prompt");
  });

  it("a second stopRecording tap during scoring is a no-op", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => {
      result.current.stopRecording();
      result.current.stopRecording();
    });
    await waitFor(() => expect(result.current.status).toBe("result"));
    expect(lastHandle.stop).toHaveBeenCalledTimes(1);
    expect(postPronAssess).toHaveBeenCalledTimes(1);
  });

  it("the recorder's own cap drives a stop through the same path", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));

    act(() => lastStartOpts.onAutoStop());

    await waitFor(() => expect(result.current.status).toBe("result"));
    expect(lastHandle.stop).toHaveBeenCalledTimes(1);
  });
});
```

#### Step 11.2 — Run it

```
npm --prefix client test -- src/hooks/usePronunciationDrill.test.js
```

Expected: `Tests  25 passed (25)`.

Prove the mount guards are load-bearing: temporarily delete
`if (!mountedRef.current || attemptSeqRef.current !== seq) return;` from `scoreTake`'s `try` block
and re-run.

```
× usePronunciationDrill — races > discards a stale response when the take was cancelled and restarted
  → expected null to be { version: 1, … }
```

Restore it and confirm green.

#### Step 11.3 — Commit

```
git add client/src/hooks/usePronunciationDrill.test.js
git diff --cached --name-only
git show :client/src/hooks/usePronunciationDrill.test.js
git commit -m "test(client): pin unmount-during-scoring and recorder races"
```

---

### Task 12: Prompt navigation and the status guards

**Files:**
- Test: `REPO/client/src/hooks/usePronunciationDrill.test.js`

**Interfaces:**
- Consumes / Produces: no signature change.

#### Step 12.1 — Write the failing test

Append to `REPO/client/src/hooks/usePronunciationDrill.test.js`:

```js
describe("usePronunciationDrill — navigation and guards", () => {
  it("advances through the set and wraps", async () => {
    const { result } = await mounted();
    act(() => result.current.nextPrompt());
    expect(result.current.prompt.id).toBe("v-b-01");
    act(() => result.current.nextPrompt());
    expect(result.current.prompt.id).toBe("ih-iy-01");
    expect(result.current.promptIndex).toBe(0);
  });

  it("selects a prompt by id and ignores an unknown id", async () => {
    const { result } = await mounted();
    act(() => result.current.selectPrompt("v-b-01"));
    expect(result.current.promptIndex).toBe(1);
    act(() => result.current.selectPrompt("does-not-exist"));
    expect(result.current.promptIndex).toBe(1);
  });

  it("clears the previous score when moving to the next prompt", async () => {
    const { result } = await mounted();
    await take(result, "result");
    act(() => result.current.nextPrompt());
    expect(result.current.status).toBe("prompt");
    expect(result.current.report).toBeNull();
    expect(result.current.errors).toEqual([]);
  });

  it("refuses to start a take unless it is on the prompt screen", async () => {
    const { result } = await mounted();
    await take(result, "result");
    act(() => result.current.startRecording());
    expect(result.current.status).toBe("result");
    expect(lastHandle.stop).toHaveBeenCalledTimes(1); // no second take began
  });

  it("refuses to stop or cancel when nothing is recording", async () => {
    const { result } = await mounted();
    act(() => result.current.stopRecording());
    act(() => result.current.cancelRecording());
    expect(result.current.status).toBe("prompt");
    expect(lastHandle).toBeNull();
  });

  it("refuses to navigate while recording or scoring", async () => {
    const { result } = await mounted();
    act(() => result.current.startRecording());
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => result.current.nextPrompt());
    act(() => result.current.selectPrompt("v-b-01"));
    expect(result.current.prompt.id).toBe("ih-iy-01");
    expect(result.current.status).toBe("recording");
  });

  it("refuses to retry from the prompt screen", async () => {
    const { result } = await mounted();
    act(() => result.current.retry());
    expect(result.current.status).toBe("prompt");
  });

  it("refuses to retry or navigate out of the no-microphone stop", async () => {
    micSupported = false;
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    act(() => result.current.retry());
    act(() => result.current.nextPrompt());
    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toBe(
      "No microphone available — the drill needs audio it can score.",
    );
  });
});
```

#### Step 12.2 — Run it

```
npm --prefix client test -- src/hooks/usePronunciationDrill.test.js
```

Expected: `Tests  33 passed (33)`.

Prove a guard: temporarily change `retry()`'s `if (!promptRef.current) return;` to
`if (false) return;` and re-run.

```
× usePronunciationDrill — navigation and guards > refuses to retry or navigate out of the no-microphone stop
  → expected 'prompt' to be 'unavailable'
```

Restore it and confirm green.

#### Step 12.3 — Commit

```
git add client/src/hooks/usePronunciationDrill.test.js
git diff --cached --name-only
git show :client/src/hooks/usePronunciationDrill.test.js
git commit -m "test(client): pin drill navigation and status guards"
```

---

### Task 13: Bring the three new modules under the coverage gate

**Files:**
- Modify: `REPO/client/vitest.config.js`

**Interfaces:**
- Consumes: `src/hooks/usePronunciationDrill.js`, `src/lib/recorder.js`, `src/lib/pronErrors.js`.
- Produces: no exports. `coverage.include` is an allowlist — until a file is listed, its
  thresholds are not enforced at all.

#### Step 13.1 — See the gap before closing it

```
npm --prefix client run test:coverage
```

Expected today: the report lists only `useConversation.js` and `speech.js`. Confirm the three new
files are **absent** from the table — that is the hole this task closes.

#### Step 13.2 — Widen the allowlist

In `REPO/client/vitest.config.js`, the `include` array becomes:

```js
      include: [
        "src/hooks/useConversation.js",
        "src/lib/speech.js",
        "src/hooks/usePronunciationDrill.js",
        "src/lib/recorder.js",
        "src/lib/pronErrors.js",
      ],
```

`thresholds` is unchanged at `{ lines: 80, functions: 80, branches: 80, statements: 80 }`.

#### Step 13.3 — Run coverage and read the table

```
npm --prefix client run test:coverage
```

Expected: all five files listed, every threshold met, exit code 0.

If a threshold misses, the gap is almost certainly one of these three, in this order of likelihood:
1. `recorder.js` branches — the `recorder.mimeType || mimeType || ""` fallbacks. Add a test that
   stubs `MockMediaRecorder.isTypeSupported = () => false` and asserts
   `handle.mimeType === "audio/webm"` (the mock's constructor default).
2. `usePronunciationDrill.js` branches — the `set?.prompts ?? []` guard. Add a test where
   `getPronPrompts` resolves `{}` and assert `status === "unavailable"`.
3. `pronErrors.js` — already exhaustively covered by Tasks 6–7.

Add the missing test in this task (same TDD loop: red, then green) rather than lowering a
threshold.

#### Step 13.4 — Commit

```
git add client/vitest.config.js
git diff --cached --name-only
git show :client/vitest.config.js
git commit -m "test(client): enforce coverage on the pronunciation modules"
```

---

### Task 14: `DrillCard` — the reference sentence and the mic affordance

**Files:**
- Create: `REPO/client/src/components/DrillCard.jsx`
- Create: `REPO/client/src/components/DrillCard.test.jsx`

**Interfaces:**
- Consumes: a `DrillPrompt` (`{ id, focus, text, ipaTargets, keyWords, contrast, level }`).
- Produces: `export default function DrillCard({ prompt, status, micSupported, onStart, onStop, onCancel })`
  where `status` is `"prompt" | "recording" | "scoring"` (anything else renders the `"prompt"` layout).

Only tokens from `client/src/index.css`'s `@theme` block are used (`ink-2`, `surface-2`, `line`,
`coach`, `coach-soft`, `user`, `accent`, `muted`), plus raw Tailwind amber/red for semantics.
**No new CSS custom properties and no edits to `index.css`.**

#### Step 14.1 — Write the failing test

Create `REPO/client/src/components/DrillCard.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DrillCard from "./DrillCard.jsx";

const prompt = {
  id: "ih-iy-01",
  focus: "ih-iy",
  text: "The ship is full of sheep.",
  ipaTargets: ["ɪ", "iː"],
  keyWords: ["ship", "sheep"],
  contrast: "vowel length + quality",
  level: "B2",
};

function setup(props = {}) {
  const handlers = { onStart: vi.fn(), onStop: vi.fn(), onCancel: vi.fn() };
  render(<DrillCard prompt={prompt} status="prompt" micSupported {...handlers} {...props} />);
  return handlers;
}

describe("DrillCard — prompt state", () => {
  it("shows the reference sentence, the focus badge and the contrast", () => {
    setup();
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("The ship is full of sheep.");
    expect(screen.getByTestId("drill-focus")).toHaveTextContent("ih-iy");
    expect(screen.getByText("vowel length + quality")).toBeInTheDocument();
    expect(screen.getByText("B2")).toBeInTheDocument();
  });

  it("starts a take when the record button is pressed", async () => {
    const h = setup();
    await userEvent.click(screen.getByRole("button", { name: "Record your take" }));
    expect(h.onStart).toHaveBeenCalledTimes(1);
  });

  it("offers no stop or cancel control before recording", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Stop and score" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel take" })).toBeNull();
  });
});

describe("DrillCard — recording state", () => {
  it("swaps in stop and cancel, and announces that it is recording", async () => {
    const h = setup({ status: "recording" });
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record your take" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Stop and score" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel take" }));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("DrillCard — scoring state", () => {
  it("disables the record button while a take is being scored", () => {
    setup({ status: "scoring" });
    const button = screen.getByRole("button", { name: "Scoring…" });
    expect(button).toBeDisabled();
  });

  it("falls back to the prompt layout for an unknown status", () => {
    setup({ status: "banana" });
    expect(screen.getByRole("button", { name: "Record your take" })).toBeEnabled();
  });
});

describe("DrillCard — no microphone", () => {
  it("disables the drill with an explicit reason instead of a mic button", () => {
    setup({ micSupported: false });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/needs a microphone/i);
    expect(screen.queryByTestId("drill-reference")).toBeNull();
  });
});

describe("DrillCard — missing prompt", () => {
  it("renders without a prompt and keeps the record button out of reach", () => {
    setup({ prompt: null });
    expect(screen.getByRole("button", { name: "Record your take" })).toBeDisabled();
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("");
  });
});
```

#### Step 14.2 — Run it and watch it fail

```
npm --prefix client test -- src/components/DrillCard.test.jsx
```

Expected failure:

```
Error: Failed to load url ./DrillCard.jsx (resolved id: .../client/src/components/DrillCard.jsx)
in /client/src/components/DrillCard.test.jsx. Does the file exist?
```

#### Step 14.3 — Implementation

Create `REPO/client/src/components/DrillCard.jsx`:

```jsx
const STATUS_HINT = {
  prompt: "Read the sentence out loud, then stop the take.",
  recording: "Recording — say the whole sentence, then stop.",
  scoring: "Scoring your pronunciation…",
};

/**
 * Reference sentence + capture controls. `status` is the drill machine's state
 * narrowed to the three this card can be in; anything else renders `prompt`.
 */
export default function DrillCard({ prompt, status, micSupported, onStart, onStop, onCancel }) {
  if (!micSupported) {
    return (
      <p
        role="status"
        className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
      >
        The drill needs a microphone — there is nothing to score without one. It cannot fall back to
        typing. Allow mic access and reload.
      </p>
    );
  }

  const isRecording = status === "recording";
  const isScoring = status === "scoring";
  const hint = STATUS_HINT[status] ?? STATUS_HINT.prompt;

  return (
    <section
      aria-labelledby="drill-heading"
      className="rounded-2xl border border-line bg-surface-2/60 px-5 py-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="drill-heading" className="text-xs uppercase tracking-wide text-muted">
          Read aloud
        </h2>
        <div className="flex items-center gap-2">
          <span
            data-testid="drill-focus"
            className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-accent/50 text-accent"
          >
            {prompt?.focus ?? "—"}
          </span>
          <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-line text-muted">
            {prompt?.level ?? "—"}
          </span>
        </div>
      </div>

      <p data-testid="drill-reference" className="text-xl leading-snug">
        {prompt?.text ?? ""}
      </p>
      <p className="text-xs text-muted">{prompt?.contrast ?? ""}</p>

      <div className="flex items-center gap-3">
        {isRecording ? (
          <>
            <button
              type="button"
              onClick={onStop}
              className="px-4 py-2.5 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition"
            >
              Stop and score
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 rounded-xl border border-line text-sm text-muted hover:text-coach-soft transition"
            >
              Cancel take
            </button>
            <span className="ml-auto inline-flex items-center gap-2 text-xs text-user">
              <span className="w-2.5 h-2.5 rounded-full bg-user animate-pulse" />
              Recording
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={isScoring || !prompt}
            className="px-4 py-2.5 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition disabled:opacity-40"
          >
            {isScoring ? "Scoring…" : "Record your take"}
          </button>
        )}
      </div>

      <p aria-live="polite" className="text-xs text-muted">
        {hint}
      </p>
    </section>
  );
}
```

#### Step 14.4 — Run it and watch it pass

```
npm --prefix client test -- src/components/DrillCard.test.jsx
```

Expected: `Tests  9 passed (9)`.

#### Step 14.5 — Commit

```
git add client/src/components/DrillCard.jsx client/src/components/DrillCard.test.jsx
git diff --cached --name-only
git show :client/src/components/DrillCard.jsx
git commit -m "feat(client): DrillCard with recording, scoring and no-mic states"
```

---

### Task 15: `PhonemeScore` — per-word and per-phoneme chips

**Files:**
- Create: `REPO/client/src/components/PhonemeScore.jsx`
- Create: `REPO/client/src/components/PhonemeScore.test.jsx`

**Interfaces:**
- Consumes: `report.words` — `PronWord[]`, where `phones` may be **absent** on every word
  (the unscripted report).
- Produces: `export default function PhonemeScore({ words })`.

The numeric score is rendered as text, not encoded only in the chip colour — colour alone fails
both axe and anyone with a colour-vision deficiency.

#### Step 15.1 — Write the failing test

Create `REPO/client/src/components/PhonemeScore.test.jsx`:

```jsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PhonemeScore from "./PhonemeScore.jsx";

const scored = [
  {
    word: "the",
    start: 0,
    end: 0.2,
    accuracy: 90,
    phones: [{ ipa: "ð", score: 90, start: 0, end: 0.2 }],
  },
  {
    word: "sheep",
    start: 0.2,
    end: 0.8,
    accuracy: 48,
    phones: [
      { ipa: "ʃ", score: 70, start: 0.2, end: 0.35 },
      { ipa: "iː", score: 31, start: 0.35, end: 0.6, substituted: "ɪ" },
    ],
  },
];

describe("PhonemeScore", () => {
  it("renders one entry per word with its accuracy", () => {
    render(<PhonemeScore words={scored} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("the")).toBeInTheDocument();
    expect(screen.getByText("sheep")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("48")).toBeInTheDocument();
  });

  it("spells out a substitution rather than showing a bare score", () => {
    render(<PhonemeScore words={scored} />);
    expect(screen.getByTitle("expected iː, heard ɪ")).toBeInTheDocument();
    expect(screen.getByTitle("expected ʃ")).toBeInTheDocument();
  });

  it("buckets chips by score band without hiding the number", () => {
    render(<PhonemeScore words={scored} />);
    // 90 -> accent band, 70 -> coach band, 31 -> red band; the number is always text.
    expect(screen.getByTitle("expected ð").className).toContain("text-accent");
    expect(screen.getByTitle("expected ʃ").className).toContain("text-coach-soft");
    expect(screen.getByTitle("expected iː, heard ɪ").className).toContain("text-red-300");
    expect(screen.getByTitle("expected iː, heard ɪ")).toHaveTextContent("31");
  });

  it("renders word chips with no phone row when the phones were stripped", () => {
    const stripped = [
      { word: "the", start: 0, end: 0.2, accuracy: 30 },
      { word: "sheep", start: 0.2, end: 0.9, accuracy: 20 },
    ];
    render(<PhonemeScore words={stripped} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.queryByTitle(/^expected /)).toBeNull();
  });

  it("renders nothing for an empty word list", () => {
    const { container } = render(<PhonemeScore words={[]} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
```

#### Step 15.2 — Run it and watch it fail

```
npm --prefix client test -- src/components/PhonemeScore.test.jsx
```

Expected failure:

```
Error: Failed to load url ./PhonemeScore.jsx (resolved id: .../client/src/components/PhonemeScore.jsx)
in /client/src/components/PhonemeScore.test.jsx. Does the file exist?
```

#### Step 15.3 — Implementation

Create `REPO/client/src/components/PhonemeScore.jsx`:

```jsx
const SCORE_BUCKETS = [
  { min: 80, cls: "text-accent border-accent/50" },
  { min: 60, cls: "text-coach-soft border-coach/50" },
  { min: 0, cls: "text-red-300 border-red-500/30" },
];

function bucketFor(score) {
  return SCORE_BUCKETS.find((b) => score >= b.min) ?? SCORE_BUCKETS[SCORE_BUCKETS.length - 1];
}

/**
 * Per-word / per-phoneme rendering of a scored report. A word whose `phones`
 * key is absent is the unscripted case (design §3) — it renders the word and
 * its accuracy only, and must not throw.
 */
export default function PhonemeScore({ words }) {
  return (
    <ul className="flex flex-wrap gap-2" data-testid="phoneme-score">
      {words.map((word, i) => (
        <li
          key={`${word.word}-${i}`}
          className="rounded-xl border border-line bg-ink-2 px-3 py-2 space-y-1.5"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{word.word}</span>
            <span
              className={`text-[11px] px-1.5 rounded-full border ${bucketFor(word.accuracy).cls}`}
            >
              {word.accuracy}
            </span>
          </div>
          {Array.isArray(word.phones) && (
            <div className="flex flex-wrap gap-1">
              {word.phones.map((phone, j) => (
                <span
                  key={j}
                  title={
                    phone.substituted
                      ? `expected ${phone.ipa}, heard ${phone.substituted}`
                      : `expected ${phone.ipa}`
                  }
                  className={`inline-flex items-baseline gap-1 text-[11px] px-1.5 py-0.5 rounded-md border ${bucketFor(phone.score).cls}`}
                >
                  <span>
                    {phone.ipa}
                    {phone.substituted ? (
                      <>
                        <span aria-hidden="true"> → </span>
                        {phone.substituted}
                      </>
                    ) : null}
                  </span>
                  <span className="opacity-70">{phone.score}</span>
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
```

#### Step 15.4 — Run it and watch it pass

```
npm --prefix client test -- src/components/PhonemeScore.test.jsx
```

Expected: `Tests  5 passed (5)`.

#### Step 15.5 — Commit

```
git add client/src/components/PhonemeScore.jsx client/src/components/PhonemeScore.test.jsx
git diff --cached --name-only
git show :client/src/components/PhonemeScore.jsx
git commit -m "feat(client): PhonemeScore chips with substitution callouts"
```

---

### Task 16: `DrillResult` — the ≤3 actionable errors and the offline notice

**Files:**
- Create: `REPO/client/src/components/DrillResult.jsx`
- Create: `REPO/client/src/components/DrillResult.test.jsx`

**Interfaces:**
- Consumes: `PronunciationReport`, `PronError[]` from `rankPronErrors` (already capped and ranked),
  `PhonemeScore`.
- Produces: `export default function DrillResult({ report, errors, scoringUnavailable, onRetry, onNext })`.

`DrillResult` **never re-ranks and never re-slices** — the cap is `rankPronErrors`'s job. When
`scoringUnavailable` is true it renders the listen-and-repeat notice and no scores at all, even if
a stale `report` is still in hand.

#### Step 16.1 — Write the failing test

Create `REPO/client/src/components/DrillResult.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DrillResult from "./DrillResult.jsx";

const report = {
  version: 1,
  mode: "scripted",
  pronProvider: "mock",
  model: "mock",
  overall: { accuracy: 62, fluency: 71, completeness: 100 },
  prosody: {
    speechRateWpm: 120,
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
      end: 0.8,
      accuracy: 48,
      phones: [{ ipa: "iː", score: 31, start: 0, end: 0.4, substituted: "ɪ" }],
    },
  ],
};

const errors = [
  { word: "sheep", wordIndex: 0, phoneIndex: 0, ipa: "iː", substituted: "ɪ", score: 31, impact: 2 },
  { word: "sheep", wordIndex: 0, phoneIndex: 1, ipa: "p", substituted: null, score: 25, impact: 0 },
];

function setup(props = {}) {
  const handlers = { onRetry: vi.fn(), onNext: vi.fn() };
  render(<DrillResult report={report} errors={errors} scoringUnavailable={false} {...handlers} {...props} />);
  return handlers;
}

describe("DrillResult — scored", () => {
  it("shows the three overall scores", () => {
    setup();
    expect(screen.getByText("Accuracy").nextSibling).toHaveTextContent("62");
    expect(screen.getByText("Fluency").nextSibling).toHaveTextContent("71");
    expect(screen.getByText("Completeness").nextSibling).toHaveTextContent("100");
  });

  it("renders exactly the errors it was handed, in order, without re-ranking", () => {
    setup();
    const items = screen.getAllByRole("listitem", { name: "" }).filter((li) =>
      li.closest("ol"),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("you said /ɪ/ where /iː/ was expected");
    expect(items[1]).toHaveTextContent("/p/ came out unclear");
  });

  it("flags a meaning-changing error and leaves accent-only errors unflagged", () => {
    setup();
    expect(screen.getAllByText("changes the word")).toHaveLength(1);
  });

  it("congratulates instead of listing when there is nothing to fix", () => {
    setup({ errors: [] });
    expect(screen.getByText(/nothing to fix/i)).toBeInTheDocument();
    expect(screen.queryByText("changes the word")).toBeNull();
  });

  it("wires retry and next", async () => {
    const h = setup();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  it("renders the per-phoneme breakdown", () => {
    setup();
    expect(screen.getByTestId("phoneme-score")).toBeInTheDocument();
  });
});

describe("DrillResult — scoring unavailable", () => {
  it("shows the listen-and-repeat notice and no scores, even with a stale report", () => {
    setup({ scoringUnavailable: true });
    expect(screen.getByRole("status")).toHaveTextContent(/listen-and-repeat/i);
    expect(screen.queryByText("Accuracy")).toBeNull();
    expect(screen.queryByTestId("phoneme-score")).toBeNull();
    expect(screen.queryByText("changes the word")).toBeNull();
  });

  it("still offers retry and next so the drill keeps moving", async () => {
    const h = setup({ scoringUnavailable: true });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });
});

describe("DrillResult — no report", () => {
  it("renders nothing when there is neither a report nor an outage", () => {
    const { container } = render(
      <DrillResult report={null} errors={[]} scoringUnavailable={false} onRetry={vi.fn()} onNext={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

#### Step 16.2 — Run it and watch it fail

```
npm --prefix client test -- src/components/DrillResult.test.jsx
```

Expected failure:

```
Error: Failed to load url ./DrillResult.jsx (resolved id: .../client/src/components/DrillResult.jsx)
in /client/src/components/DrillResult.test.jsx. Does the file exist?
```

#### Step 16.3 — Implementation

Create `REPO/client/src/components/DrillResult.jsx`:

```jsx
import PhonemeScore from "./PhonemeScore.jsx";

/**
 * Overall scores plus the actionable errors. The list is already capped and
 * ranked by `rankPronErrors` (design §6) — this component never re-orders or
 * re-slices it.
 */
export default function DrillResult({ report, errors, scoringUnavailable, onRetry, onNext }) {
  if (scoringUnavailable) {
    return (
      <div className="space-y-4">
        <p
          role="status"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        >
          Scoring is offline — this round is listen-and-repeat. Say the sentence back, then keep
          going. No score this time.
        </p>
        <Actions onRetry={onRetry} onNext={onNext} />
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-2">
        <Score label="Accuracy" value={report.overall.accuracy} />
        <Score label="Fluency" value={report.overall.fluency} />
        <Score label="Completeness" value={report.overall.completeness} />
      </dl>

      {errors.length > 0 ? (
        <ol className="space-y-1.5">
          {errors.map((e) => (
            <li
              key={`${e.wordIndex}-${e.phoneIndex}`}
              className="text-sm rounded-xl border border-line bg-ink-2 px-3 py-2"
            >
              <strong className="text-coach-soft">{e.word}</strong>{" "}
              {e.substituted
                ? `— you said /${e.substituted}/ where /${e.ipa}/ was expected`
                : `— /${e.ipa}/ came out unclear`}
              {e.impact === 2 && (
                <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-red-500/30 text-red-300">
                  changes the word
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-accent">Nothing to fix on that one — it came through clearly.</p>
      )}

      <PhonemeScore words={report.words} />
      <Actions onRetry={onRetry} onNext={onNext} />
    </div>
  );
}

function Score({ label, value }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-2xl font-semibold text-coach-soft">{value}</dd>
    </div>
  );
}

function Actions({ onRetry, onNext }) {
  return (
    <div className="flex gap-2 justify-end">
      <button
        type="button"
        onClick={onRetry}
        className="px-3 py-2 rounded-xl border border-line text-sm hover:border-coach/60 hover:text-coach-soft transition"
      >
        Try again
      </button>
      <button
        type="button"
        onClick={onNext}
        className="px-4 py-2 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition"
      >
        Next sentence
      </button>
    </div>
  );
}
```

#### Step 16.4 — Run it and watch it pass

```
npm --prefix client test -- src/components/DrillResult.test.jsx
```

Expected: `Tests  9 passed (9)`.

If the "renders exactly the errors it was handed" test reports `0` items, the `.filter()` narrowing
is fighting the accessible-name option — replace that query with
`const items = screen.getByRole("list", { name: "" }).querySelectorAll("li")` scoped to the `<ol>`
via `container.querySelectorAll("ol > li")`. Assert the same two text contents. Do not weaken the
assertion to "at least one".

#### Step 16.5 — Commit

```
git add client/src/components/DrillResult.jsx client/src/components/DrillResult.test.jsx
git diff --cached --name-only
git show :client/src/components/DrillResult.jsx
git commit -m "feat(client): DrillResult with capped errors and offline fallback"
```

---

### Task 17: `DrillPanel` — the container that composes the machine

**Files:**
- Create: `REPO/client/src/components/DrillPanel.jsx`
- Create: `REPO/client/src/components/DrillPanel.test.jsx`

**Interfaces:**
- Consumes: `usePronunciationDrill({ focus })`, `DrillCard`, `DrillResult`.
- Produces: `export default function DrillPanel({ focus = null })`.

The panel is a pure composition layer: it owns no state. Its test mocks the hook — the same
`vi.mock` + `hookState()` idiom `App.test.jsx` already uses for `useConversation`.

#### Step 17.1 — Write the failing test

Create `REPO/client/src/components/DrillPanel.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../hooks/usePronunciationDrill.js", () => ({ usePronunciationDrill: vi.fn() }));
import { usePronunciationDrill } from "../hooks/usePronunciationDrill.js";
import DrillPanel from "./DrillPanel.jsx";

const prompt = {
  id: "ih-iy-01",
  focus: "ih-iy",
  text: "The ship is full of sheep.",
  ipaTargets: ["ɪ", "iː"],
  keyWords: ["ship", "sheep"],
  contrast: "vowel length + quality",
  level: "B2",
};

const report = {
  version: 1,
  mode: "scripted",
  pronProvider: "mock",
  model: "mock",
  overall: { accuracy: 62, fluency: 71, completeness: 100 },
  prosody: {
    speechRateWpm: 120,
    articulationRateSyllPerSec: 4,
    pauseCount: 0,
    pauseTotalSec: 0,
    f0MinHz: null,
    f0MaxHz: null,
    f0RangeSemitones: null,
  },
  words: [
    { word: "sheep", start: 0, end: 0.8, accuracy: 48, phones: [{ ipa: "iː", score: 31, start: 0, end: 0.4 }] },
  ],
};

function drillState(over = {}) {
  return {
    status: "prompt",
    prompt,
    prompts: [prompt],
    promptIndex: 0,
    report: null,
    errors: [],
    error: null,
    micSupported: true,
    scoringUnavailable: false,
    pronProvider: null,
    attempts: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    retry: vi.fn(),
    nextPrompt: vi.fn(),
    selectPrompt: vi.fn(),
    clearError: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  usePronunciationDrill.mockReset();
});

describe("DrillPanel — state routing", () => {
  it("shows a loading line while the prompt set is in flight", () => {
    usePronunciationDrill.mockReturnValue(drillState({ status: "loading", prompt: null, prompts: [] }));
    render(<DrillPanel />);
    expect(screen.getByText(/loading drills/i)).toBeInTheDocument();
  });

  it("renders the card on the prompt screen and wires the capture callbacks", async () => {
    const state = drillState();
    usePronunciationDrill.mockReturnValue(state);
    render(<DrillPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Record your take" }));
    expect(state.startRecording).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("The ship is full of sheep.");
  });

  it("renders the result once a take has been scored", () => {
    usePronunciationDrill.mockReturnValue(
      drillState({
        status: "result",
        report,
        errors: [
          { word: "sheep", wordIndex: 0, phoneIndex: 0, ipa: "iː", substituted: "ɪ", score: 31, impact: 2 },
        ],
        pronProvider: "mock",
        attempts: 1,
      }),
    );
    render(<DrillPanel />);
    expect(screen.getByText("Accuracy")).toBeInTheDocument();
    expect(screen.getByText("changes the word")).toBeInTheDocument();
    expect(screen.getByText(/attempts this session: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/scorer: mock/i)).toBeInTheDocument();
  });

  it("shows the listen-and-repeat result when scoring went offline", () => {
    usePronunciationDrill.mockReturnValue(
      drillState({ status: "unavailable", scoringUnavailable: true, error: "Scoring is offline." }),
    );
    render(<DrillPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/listen-and-repeat/i);
    expect(screen.getByRole("button", { name: "Next sentence" })).toBeInTheDocument();
  });

  it("shows only the reason when the drill is unavailable and has no prompt", () => {
    usePronunciationDrill.mockReturnValue(
      drillState({
        status: "unavailable",
        prompt: null,
        prompts: [],
        micSupported: false,
        error: "No microphone available — the drill needs audio it can score.",
      }),
    );
    render(<DrillPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/no microphone available/i);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("surfaces a transient error above the card and lets it be dismissed", async () => {
    const state = drillState({ error: "Couldn't make out any speech in that recording." });
    usePronunciationDrill.mockReturnValue(state);
    render(<DrillPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't make out any speech/i);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(state.clearError).toHaveBeenCalledTimes(1);
  });

  it("passes its focus prop straight to the hook", () => {
    usePronunciationDrill.mockReturnValue(drillState());
    render(<DrillPanel focus="v-b" />);
    expect(usePronunciationDrill).toHaveBeenCalledWith({ focus: "v-b" });
  });
});
```

#### Step 17.2 — Run it and watch it fail

```
npm --prefix client test -- src/components/DrillPanel.test.jsx
```

Expected failure:

```
Error: Failed to load url ./DrillPanel.jsx (resolved id: .../client/src/components/DrillPanel.jsx)
in /client/src/components/DrillPanel.test.jsx. Does the file exist?
```

#### Step 17.3 — Implementation

Create `REPO/client/src/components/DrillPanel.jsx`:

```jsx
import { usePronunciationDrill } from "../hooks/usePronunciationDrill.js";
import DrillCard from "./DrillCard.jsx";
import DrillResult from "./DrillResult.jsx";

/** Container for the pronunciation drill: owns nothing, composes everything. */
export default function DrillPanel({ focus = null }) {
  const d = usePronunciationDrill({ focus });

  if (d.status === "loading") {
    return <p className="px-5 py-6 text-sm text-muted">Loading drills…</p>;
  }

  // No mic, or the prompt set never arrived: there is no drill to show, only a reason.
  if (d.status === "unavailable" && !d.scoringUnavailable && !d.prompt) {
    return (
      <div className="px-5 py-6">
        <p
          role="status"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        >
          {d.error ?? "The pronunciation drill is unavailable right now."}
        </p>
      </div>
    );
  }

  const showResult = d.status === "result" || d.scoringUnavailable;

  return (
    <div className="px-5 py-6 space-y-4">
      {d.error && !showResult && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          <span className="flex-1">{d.error}</span>
          <button
            type="button"
            onClick={d.clearError}
            aria-label="Dismiss error"
            className="text-red-300/70 hover:text-red-200 transition"
          >
            ✕
          </button>
        </p>
      )}

      {showResult ? (
        <DrillResult
          report={d.report}
          errors={d.errors}
          scoringUnavailable={d.scoringUnavailable}
          onRetry={d.retry}
          onNext={d.nextPrompt}
        />
      ) : (
        <DrillCard
          prompt={d.prompt}
          status={d.status}
          micSupported={d.micSupported}
          onStart={d.startRecording}
          onStop={d.stopRecording}
          onCancel={d.cancelRecording}
        />
      )}

      <p className="text-xs text-muted">
        Attempts this session: {d.attempts}
        {d.pronProvider ? ` · scorer: ${d.pronProvider}` : ""}
      </p>
    </div>
  );
}
```

#### Step 17.4 — Run it and watch it pass

```
npm --prefix client test -- src/components/DrillPanel.test.jsx
```

Expected: `Tests  7 passed (7)`.

#### Step 17.5 — Commit

```
git add client/src/components/DrillPanel.jsx client/src/components/DrillPanel.test.jsx
git diff --cached --name-only
git show :client/src/components/DrillPanel.jsx
git commit -m "feat(client): DrillPanel composes the drill machine"
```

---

### Task 18: Accessibility tests for every new component

**Files:**
- Modify: `REPO/client/src/components/__a11y__.test.jsx`

**Interfaces:**
- Consumes: `DrillCard`, `DrillResult`, `PhonemeScore`; the globally-registered `toHaveNoViolations`
  matcher from `client/src/test/setup.js`.
- Produces: no exports. Six new cases, following the existing
  `"<Component> has no axe violations (<state>)"` naming.

#### Step 18.1 — Write the failing test

In `REPO/client/src/components/__a11y__.test.jsx`, extend the import block:

```jsx
import DrillCard from "./DrillCard.jsx";
import DrillResult from "./DrillResult.jsx";
import PhonemeScore from "./PhonemeScore.jsx";
```

and add these fixtures directly below the existing `const vs = { … };`:

```jsx
const drillPrompt = {
  id: "ih-iy-01",
  focus: "ih-iy",
  text: "The ship is full of sheep.",
  ipaTargets: ["ɪ", "iː"],
  keyWords: ["ship", "sheep"],
  contrast: "vowel length + quality",
  level: "B2",
};

const drillCard = {
  prompt: drillPrompt,
  status: "prompt",
  micSupported: true,
  onStart: vi.fn(),
  onStop: vi.fn(),
  onCancel: vi.fn(),
};

const drillWords = [
  {
    word: "sheep",
    start: 0,
    end: 0.8,
    accuracy: 48,
    phones: [
      { ipa: "ʃ", score: 88, start: 0, end: 0.3 },
      { ipa: "iː", score: 31, start: 0.3, end: 0.6, substituted: "ɪ" },
    ],
  },
];

const drillReport = {
  version: 1,
  mode: "scripted",
  pronProvider: "mock",
  model: "mock",
  overall: { accuracy: 62, fluency: 71, completeness: 100 },
  prosody: {
    speechRateWpm: 120,
    articulationRateSyllPerSec: 4,
    pauseCount: 0,
    pauseTotalSec: 0,
    f0MinHz: null,
    f0MaxHz: null,
    f0RangeSemitones: null,
  },
  words: drillWords,
};

const drillErrors = [
  { word: "sheep", wordIndex: 0, phoneIndex: 1, ipa: "iː", substituted: "ɪ", score: 31, impact: 2 },
];
```

Then append these six cases inside the existing `describe("accessibility", …)` block, before its
closing `});`:

```jsx
  it("DrillCard has no axe violations (prompt)", async () => {
    const { container } = render(<DrillCard {...drillCard} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillCard has no axe violations (recording)", async () => {
    const { container } = render(<DrillCard {...drillCard} status="recording" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillCard has no axe violations (no microphone)", async () => {
    const { container } = render(<DrillCard {...drillCard} micSupported={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillResult has no axe violations (scored)", async () => {
    const { container } = render(
      <DrillResult
        report={drillReport}
        errors={drillErrors}
        scoringUnavailable={false}
        onRetry={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillResult has no axe violations (scoring unavailable)", async () => {
    const { container } = render(
      <DrillResult
        report={null}
        errors={[]}
        scoringUnavailable
        onRetry={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("PhonemeScore has no axe violations (with substitution)", async () => {
    const { container } = render(<PhonemeScore words={drillWords} />);
    expect(await axe(container)).toHaveNoViolations();
  });
```

#### Step 18.2 — Run it

```
npm --prefix client test -- src/components/__a11y__.test.jsx
```

Expected: `Tests  14 passed (14)` (the 8 existing plus these 6).

If a case fails, the message names the rule, e.g.

```
× DrillResult has no axe violations (scored)
  → expected the element to have no violations:
    definition-list: <dl> elements must only directly contain properly-ordered
    <dt> and <dd> groups
```

Fix the **markup**, never the assertion. The two failures most likely to show up:
- `definition-list` — each `Score` must render exactly one `<dt>` followed by one `<dd>` with no
  wrapper `<div>` between them and the `<dl>`. If it fires, change `Score` to a fragment
  (`<><dt …/><dd …/></>`) and move the card styling onto the `<dt>`/`<dd>` pair.
- `region` / `landmark` rules do **not** fire on fragments rendered in isolation, so no
  `<main>` wrapper is needed here.

#### Step 18.3 — Commit

```
git add client/src/components/__a11y__.test.jsx
git diff --cached --name-only
git show :client/src/components/__a11y__.test.jsx
git commit -m "test(client): axe coverage for the drill components"
```

---

### Task 19: Wire the drill into `App` as a separate mode — and prove `useConversation` is untouched

**Files:**
- Modify: `REPO/client/src/App.jsx`
- Modify: `REPO/client/src/App.test.jsx`

**Interfaces:**
- Consumes: `DrillPanel` (default export).
- Produces: no new exports. `App` gains local `mode` state (`"conversation" | "drill"`), default
  `"conversation"`, so every existing `App` test keeps passing unchanged.

`useConversation()` is still called unconditionally at the top of `App` — hooks cannot be
conditional, and the conversation state must survive a trip to the drill and back.

#### Step 19.1 — Write the failing test

In `REPO/client/src/App.test.jsx`, add this mock immediately after the existing
`vi.mock("./hooks/useConversation.js", …)` line:

```js
// Returning a string avoids JSX inside a hoisted vi.mock factory.
vi.mock("./components/DrillPanel.jsx", () => ({
  default: function DrillPanelStub() {
    return "drill-panel-stub";
  },
}));
```

Then append this describe block to the end of the file:

```jsx
describe("App mode switch", () => {
  it("starts in conversation mode", () => {
    useConversation.mockReturnValue(hookState({ status: "idle" }));
    render(<App />);
    expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText("drill-panel-stub")).toBeNull();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("swaps the conversation surface for the drill panel", async () => {
    useConversation.mockReturnValue(hookState({ status: "idle" }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pronunciation drill" }));

    expect(screen.getByText("drill-panel-stub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pronunciation drill" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The conversation footer is gone: no mic, no text input.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
  });

  it("returns to the conversation with its messages intact", async () => {
    useConversation.mockReturnValue(
      hookState({ status: "idle", messages: [{ role: "coach", text: "hi there" }] }),
    );
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pronunciation drill" }));
    await userEvent.click(screen.getByRole("button", { name: "Conversation" }));

    expect(screen.getByText("hi there")).toBeInTheDocument();
    expect(screen.queryByText("drill-panel-stub")).toBeNull();
  });

  it("keeps the stat header visible in both modes", async () => {
    useConversation.mockReturnValue(hookState({ status: "idle", totalXp: 40 }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pronunciation drill" }));
    expect(screen.getByText("40")).toBeInTheDocument();
  });
});
```

#### Step 19.2 — Run it and watch it fail

```
npm --prefix client test -- src/App.test.jsx
```

Expected failure:

```
× App mode switch > starts in conversation mode
  → Unable to find an accessible element with the role "button" and name "Conversation"
```

#### Step 19.3 — Implementation

In `REPO/client/src/App.jsx`:

1. Add the import beneath the existing component imports:

```jsx
import DrillPanel from "./components/DrillPanel.jsx";
```

2. Add the mode state next to the existing `textInput` state:

```jsx
  const [mode, setMode] = useState("conversation");
```

3. Replace the `return ( … )` body's contents so `StatHeader` is followed by the tab row and the
   two surfaces become mutually exclusive. The whole return becomes:

```jsx
  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      <StatHeader
        totalXp={c.totalXp}
        turns={c.turns}
        brain={c.providers.brain}
        tts={c.providers.tts}
        stt={c.providers.stt}
      />

      <ModeSwitch mode={mode} onChange={setMode} />

      {mode === "drill" ? (
        <main className="flex-1 overflow-y-auto">
          <DrillPanel />
        </main>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
```

4. Add the private sub-component at the bottom of the file, below `App`:

```jsx
const MODES = [
  { id: "conversation", label: "Conversation" },
  { id: "drill", label: "Pronunciation drill" },
];

// aria-pressed toggles rather than role="tab": there is no tabpanel to point
// aria-controls at, and a dangling reference is itself an axe violation.
function ModeSwitch({ mode, onChange }) {
  return (
    <nav aria-label="Practice mode" className="flex gap-2 px-5 pt-3">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={mode === m.id}
          onClick={() => onChange(m.id)}
          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition ${
            mode === m.id
              ? "border-coach/60 bg-coach/20 text-coach-soft"
              : "border-line text-muted hover:border-coach/60 hover:text-coach-soft"
          }`}
        >
          {m.label}
        </button>
      ))}
    </nav>
  );
}
```

`handleMicClick`, `handleTextSubmit`, the scroll effect and the focus-return effect are unchanged —
`micButtonRef.current?.focus()` already no-ops when the mic is not rendered.

#### Step 19.4 — Run it and watch it pass

```
npm --prefix client test -- src/App.test.jsx
```

Expected: `Tests  12 passed (12)` (the 8 existing plus these 4).

#### Step 19.5 — Prove `useConversation` was never touched

The spec's central client constraint is that the drill gets its own machine and the conversation
loop is left alone. Verify it against the merge base, not against the working tree:

```
git diff --stat $(git merge-base HEAD main)..HEAD -- client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js
```

Expected output: **nothing at all** (empty, exit code 0). If either file appears in that diff, the
milestone has violated the design — revert those hunks before continuing.

Belt and braces, also confirm the working tree matches the merge base:

```
git diff $(git merge-base HEAD main) -- client/src/hooks/useConversation.js
git status --short client/src/hooks/
```

Both must print nothing.

#### Step 19.6 — Full client suite and commit

```
npm --prefix client test
npm --prefix client run test:coverage
```

Expected: every suite green, every coverage threshold met.

```
git add client/src/App.jsx client/src/App.test.jsx
git diff --cached --name-only
git show :client/src/App.jsx
git commit -m "feat(client): add the pronunciation drill as a second practice mode"
```

---

## Chunk verification checklist

Run from `REPO` once every task above is committed:

```
npm --prefix client test
npm --prefix client run test:coverage
git diff --stat $(git merge-base HEAD main)..HEAD -- client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js
git diff --stat $(git merge-base HEAD main)..HEAD -- client/src/lib/audio.js
git status --short
```

Expected:
1. Full client suite green.
2. Coverage table lists `usePronunciationDrill.js`, `recorder.js`, `pronErrors.js` and every
   threshold ≥ 80.
3. The `useConversation` diff is **empty** — the design's hard constraint.
4. The `lib/audio.js` diff is **empty** — the dead Ruta B primitive was rebuilt in
   `lib/recorder.js`, not restored.
5. `git status --short` shows no stray untracked files that a later commit could sweep in.

Files this chunk creates:

```
client/src/lib/recorder.js              client/src/lib/recorder.test.js
client/src/lib/pronErrors.js            client/src/lib/pronErrors.test.js
client/src/lib/api.pron.test.js
client/src/hooks/usePronunciationDrill.js
client/src/hooks/usePronunciationDrill.test.js
client/src/components/DrillCard.jsx     client/src/components/DrillCard.test.jsx
client/src/components/PhonemeScore.jsx  client/src/components/PhonemeScore.test.jsx
client/src/components/DrillResult.jsx   client/src/components/DrillResult.test.jsx
client/src/components/DrillPanel.jsx    client/src/components/DrillPanel.test.jsx
```

Files this chunk modifies:

```
client/src/lib/api.js                   client/src/test/setup.js
client/src/components/__a11y__.test.jsx client/src/App.jsx
client/src/App.test.jsx                 client/vite.config.js
client/vitest.config.js
```

Files this chunk must **not** touch: `client/src/hooks/useConversation.js`,
`client/src/hooks/useConversation.test.js`, `client/src/lib/audio.js`, `client/src/index.css`.
