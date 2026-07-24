# Voice I/O Hardening — Design Spec

- **Date:** 2026-07-24
- **Status:** Approved (design), hardened via multi-agent adversarial review, pending implementation plan
- **Owner:** SpeakUp (C:\talker)
- **Relates:** precedes the Harper grammar-layer milestone (parked until this lands)

## 1. Context

SpeakUp is a personal, local-first English speaking coach: a React (Vite) client + Express server with a pluggable "brain" (mock / Mistral), a pluggable TTS layer (kokoro-fastapi / voicebox / browser), and a dormant server-side STT layer (voicebox/Whisper). Today the app is at M1: the coach keeps the conversation flowing, no corrections yet.

The user asked whether to integrate Harper (a grammar checker) next. Harper's accuracy depends entirely on the quality of the text it receives, and SpeakUp's text can arrive from three sources that all converge on `runTurn(utterance, history)` in `server/src/routes/turn.js`: typed text, browser Web Speech transcript, or server Whisper transcript. Because grammar-checking noisy speech transcripts is unreliable, we decided to **harden voice I/O first**, then build Harper on top of a trustworthy loop.

### Current state (verified in code)
- **TTS:** adapters for kokoro-fastapi (`server/src/tts/kokoro.js`), voicebox (`server/src/tts/voicebox.js`), and a browser fallback. `/turn` synthesizes the coach reply and returns base64 audio; on any TTS failure the turn still returns and the client speaks via `SpeechSynthesis`.
- **STT:** two paths. Ruta A = browser Web Speech API (`client/src/lib/speech.js`). Ruta B = server Whisper via voicebox (`server/src/stt/voicebox.js`) behind `/turn/audio` + `MediaRecorder` (`client/src/lib/audio.js`). Client auto-selects Ruta B when `STT_PROVIDER` is set, else Ruta A (`client/src/App.jsx` `useServerSTT`).
- **Live `.env`:** a temporary test config — `TTS_PROVIDER=voicebox`, `STT_PROVIDER=voicebox` (container on `:17600`), brain = mock. Comment notes kokoro-fastapi was not running, which is why voicebox was used.
- **Client orchestration** (state machine, recognition, playback, turn API) all live in one 305-line `App.jsx`. There is a working **text input** fallback that drives the same loop. `App.jsx` currently sets `continuous=false`, `interimResults=false`, auto-submits on the single `onResult`, and forces `idle` on `onEnd`.
- **No client test runner** exists (`client/package.json` has no test deps/scripts).

## 2. Goal & Non-Goals

### Goal
Make the **hybrid** voice loop trustworthy end-to-end so we can build grammar feedback on it with confidence:
- **Coach voice (TTS):** kokoro-fastapi on `:8880`, high quality, with graceful fallback to browser voice.
- **Learner input (STT):** browser Web Speech API, with a **deliberate** flow — live interim transcript → review/edit → send — plus **barge-in** and clear **status/error** feedback.

### Non-Goals (explicitly deferred)
- Harper grammar layer (the next milestone).
- Server-side STT / Whisper (kept dormant on disk, gated by `STT_PROVIDER`; the **client** Ruta B orchestration is removed this milestone and re-added in M7 for pronunciation feedback).
- M2 structured feedback (fluency/confidence/corrections), ErrorLedger writes, scenarios, spaced repetition.
- Streaming TTS.
- **VAD / silence-based auto-stop.** The utterance ends when the *user* taps stop, not when the recognizer detects silence. Note: setting `continuous=true` (§5.3) is *not* VAD — it is the opposite, keeping the session open across pauses so silence does not end the turn.
- Making Web Speech private/offline (it routes audio through Google — accepted trade-off, see §9).

## 3. Stack Decision & Rationale

**Chosen:** Hybrid — **kokoro-fastapi TTS + browser Web Speech STT.**

- **TTS = kokoro-fastapi (`:8880`):** high-quality neural voice (`af_heart`), server-controlled, OpenAI-compatible shape (so a later swap to OpenAI/ElevenLabs is a URL change). Better than the browser's `SpeechSynthesis`.
- **STT = browser Web Speech:** zero STT infrastructure, instant transcription, good enough for accented English on Chrome/Edge.
- **Trade-offs accepted:** Web Speech is Chrome/Edge-only and sends audio to Google (not local/private); kokoro-fastapi requires a running Docker service. Mitigations: the text box works in any browser; the review step compensates for mis-recognition; browser voice covers a TTS outage.

Rejected alternatives: **voicebox-canonical** (heavier local infra than wanted now; STT stays dormant for M7) and **browser-only** (lower voice quality, no path to server-side pronunciation analysis later).

## 4. Target Configuration (`server/.env`)

```
# --- TTS (coach voice) ---
TTS_PROVIDER=kokoro
KOKORO_URL=http://localhost:8880/v1
KOKORO_VOICE=af_heart
KOKORO_MODEL=kokoro
KOKORO_FORMAT=mp3

# --- STT: unset -> client uses browser Web Speech (Ruta A) ---
# STT_PROVIDER=            (leave unset / remove)

# --- Brain: unchanged (mock unless MISTRAL_API_KEY is present) ---
```

- **Explicitly neutralize** the live temp values: change `TTS_PROVIDER=voicebox → kokoro` and remove/comment `STT_PROVIDER=voicebox`. The dormant `VOICEBOX_*` vars can remain; they are inert once neither provider selects voicebox.
- With `STT_PROVIDER` unset, `currentSTTProvider()` returns `"none"`, `/health` reports `stt: "none"`, and `StatHeader` already hides the STT badge when `stt === "none"`.
- **This milestone assumes `STT_PROVIDER` is unset**; the client uses only the browser recognizer. Server-side STT is re-wired on the client in M7 (see §5.4).
- **Setup task:** bring kokoro-fastapi up on `:8880` (Docker) and smoke-test `POST /v1/audio/speech` **before any client work**. Break-glass if it cannot run: browser voice (already automatic), or point the voicebox adapter at the running container (identical `af_heart` output) — noted only as an emergency, not the target.

## 5. Architecture

### 5.1 Client state machine (the core)
```
idle → listening → review → thinking → speaking → idle
                     ↑__(re-record)__|
speaking → (barge-in) → listening
idle → (type + send) → thinking            # text path skips listening/review
idle → (replay last coach) → idle          # out-of-band playback, no transition
```

**Draft model.** `draft` = committed final segments **plus** the last unfinalized interim tail. During `listening`, each recognizer `onresult` commits `isFinal` segments and updates the live tail; `draft` is always the concatenation the user sees and the exact text sent on `send`.

| State | Meaning | Allowed actions |
|---|---|---|
| `idle` | waiting | `startListening` (mic), `submitText`, `replay(lastCoach)` |
| `listening` | recognizer active, `continuous=true`, `interimResults=true`; draft streams live | `stopListening` |
| `review` *(new)* | recognition stopped, `draft` editable | `editDraft`, `send`, `reRecord`, `cancel` |
| `thinking` | `POST /turn` in flight (user bubble already shown) | (none; on error → `review` preserving `draft`) |
| `speaking` | coach audio playing | `interrupt` (barge-in) |

Transition rules:
- **`startListening`** sets `userStopped = false`, then starts the recognizer.
- **`stopListening`** sets `userStopped = true` and calls `rec.stop()` (which finalizes buffered audio; `abort()` is only used to discard, e.g. on `cancel`).
- **Recognizer `onend`** while `listening` (single handler for both intentional stop and browser self-termination):
  - draft non-empty → `review` (preserving draft), regardless of `userStopped`.
  - draft empty **and** `userStopped` → `idle` with "Didn't catch that — try again or type."
  - draft empty **and not** `userStopped` (silence self-termination) → **restart the recognizer and stay `listening`** (continuity mode), guarded by a restart backstop (max session duration + no restart-storm on repeated `no-speech`/error). This honors "record until the user taps stop."
- **`review → thinking`** on `send` (posts `draft`); **`review → listening`** on `reRecord` (discards draft, `abort()` then fresh start); **`review → idle`** on `cancel`.
- **`speaking → listening`** on barge-in: the playback controller stops playback (pause audio + `stopSpeaking()`) and clears the speak-timeout, then a fresh recognizer starts. Barge-in is scoped to `speaking` only.
- **`replay(lastCoach)`** is allowed only from `idle`. It routes through the single playback controller (stops any current audio, wires `onEnd`), plays out-of-band, and does **not** change state (stays `idle`, no `speaking`, not subject to barge-in). The replay control is disabled in `listening`/`review`/`thinking`/`speaking` — this closes the echo path where replayed coach audio could play while the mic is live.
- Any error → surface via the error surface model (§5.2) and return to a safe state (`idle`, or `review` preserving `draft`).

### 5.2 `client/src/hooks/useConversation.js` *(new)*
Owns all conversation state and side effects; App.jsx becomes a thin renderer.
- **State:** `messages`, `status`, `draft` (finals + interim tail), `totalXp`, `error` (transient per-turn failures only — see surface model), `providers` (`{brain, tts, stt}` from `/health`), `ttsFallbackActive` (set when a turn returns `audio=null` for a kokoro-configured provider).
- **Refs:** recognizer, `userStopped` flag, and a **single playback controller** owning `currentAudioRef` + `speakTimerRef` + the `status` writes for playback. All playback entry points (`speakReply`, `replay`, barge-in stop) go through it, so every start does: (a) `clearTimeout(speakTimerRef)`, (b) set/own status deterministically, (c) wire `onEnd` to reset status. *(No audio-recorder ref — Ruta B client orchestration is out this milestone; see §5.4.)*
- **Actions:** `startListening`, `stopListening`, `editDraft(text)`, `send`, `reRecord`, `cancel`, `interrupt`, `submitText(text)`, `replay(message)`.
- **Error surface model** (removes the single-`error`-vs-VoiceStatus ambiguity):
  - **`error` string** — transient per-turn failures only: Brain 502, empty draft, Web Speech `no-speech`/`network`, mic error / permission-denied. Mic-permission-denied lives **here only** (not duplicated as a separate VoiceStatus banner).
  - **VoiceStatus (derived/persistent)** — capability + status: `no-Web-Speech` (from `isSTTSupported()`), live status/interim line, optional provider info.
  - **One-time notice** — the coach-voice fallback event (see §7 predicate), event-driven, not derived from providers.
- **Encapsulates:** recognition (`speech.js`), turn API (`api.js` `postTurn`), playback (`speech.js` `playAudio`/`speak`), and fallback selection.
- **Rationale:** the new review/interim/barge-in/replay logic would make the already-dense `App.jsx` unmaintainable and untestable. Extracting yields a unit testable with a mocked recognizer + fetch, and is the natural attach point for Harper feedback later.

### 5.3 speech.js changes & components
- **`speech.js` `createRecognizer`:** set `continuous=true` **and** `interimResults=true`. Add `onInterim(partialText)` distinct from `onResult(finalText)`. On each `onresult`, iterate `event.results`: concatenate `isFinal` entries into the committed draft via `onResult`, and surface the trailing non-final segment via `onInterim`; keep the last interim in a ref so a stop that races finalization still yields a reviewable draft. Add an `onStart` hook so the "Listening…" affordance keys off the recognizer actually starting (not the optimistic tap). The hook (`useConversation`) owns the `onend` restart-vs-finalize decision and the `userStopped` flag.
- **`MicButton.jsx`:** reflect `listening` (live interim) and act as the **barge-in** control during `speaking`. Its `aria-label` must be **action-oriented per state** — idle "Tap to speak", listening "Stop recording", speaking "Interrupt coach and speak" — not the current non-actionable "Coach is speaking".
- **`TranscriptReview.jsx` *(new)*:** editable textarea shown in `review`, with **Send / Re-record / Cancel**. Autofocus on enter; Enter submits, Shift+Enter newline, Esc cancels; on send/cancel/reRecord return focus to the mic button.
- **`VoiceStatus`:** status line + banners per the surface model. **Remove "synthesizing…"** — TTS runs inside the single `/turn` request, so the client has no observable synthesis phase distinct from `thinking`. May be a small component or a footer extension (decided in the plan).
- **`StatHeader.jsx`:** the TTS/STT badges come from `/health` at load and reflect **configuration, not runtime**. Relabel the TTS badge `title` from "active coach voice" to **"configured coach voice"** so it cannot contradict the runtime "using browser voice" notice.

### 5.4 Server
- **No route changes.** `/turn` already returns `{ coach_reply, xp, audio?, audioFormat?, ttsProvider }`. The dormant `/turn/audio` + voicebox STT stay on disk behind `STT_PROVIDER` (unset → the route 501s and is never called).
- **Client Ruta B orchestration is removed this milestone:** drop `useServerSTT`, `startListeningServer`, `handleAudioTurn` from the client, and do not carry an "unused" audio-recorder ref in the hook. `server/src/routes/turn.js` `/turn/audio`, `server/src/stt/*`, `client/src/lib/audio.js`, and `client/src/lib/api.js postTurnAudio` remain on disk, untouched, for M7 to re-wire.
- Only the `.env` switch (§4). Also refresh the stale doc comment in `server/src/stt/index.js` ("No route consumes this yet") — `/turn/audio` does consume it.

### 5.5 Accessibility *(new)*
Per the repo's web/testing rules (a11y is priority #2):
- **Live region:** render the status/interim line inside a single persistent `aria-live="polite"` container so screen-reader users hear listening/thinking/speaking transitions.
- **Alerts:** error and coach-voice-fallback banners get `role="alert"`; the dismiss control is keyboard-reachable.
- **Focus management:** entering `review` focuses the textarea; `send`/`cancel`/`reRecord` return focus to the mic button.
- **Barge-in label:** the action-oriented `aria-label` from §5.3.
- **Reduced motion:** guard `.animate-pulse-ring` (and other infinite animations) with `@media (prefers-reduced-motion: reduce)` in `index.css`; provide a non-motion listening affordance (color/ring change).

## 6. Data Flow — one spoken turn
1. `idle` → tap mic → recognizer starts → on `onStart`, show `listening` (browser prompts for mic permission on first use; denial arrives async via `onerror`, see §7).
2. Web Speech streams results → `draft` = committed finals + live interim tail, updated live.
3. Tap stop (`userStopped=true`, `rec.stop()`) → on `onend`, non-empty draft → `review`; empty → `idle` ("Didn't catch that").
4. User edits (optional) → **Send**.
5. On send: **push the user bubble immediately** (`turns` increments now) and enter `thinking`; `POST /turn { utterance: draft, history }` → server: `brain.evaluateTurn` → kokoro-fastapi synth → `{ coach_reply, xp, audio(mp3 b64), ttsProvider }`.
6. On response: push the coach bubble, add XP → `speaking`; the playback controller plays Kokoro audio (falls back to `SpeechSynthesis` on `audio=null`/play error, per §7). On a `thinking` error: keep the user bubble, repopulate `draft`, return to `review`.
7. Audio ends → `idle`. (Or barge-in → stop audio → `listening`.)

**Text path:** `idle` → type → Send → push user bubble immediately → `thinking` → (5–7). User-bubble timing is **identical** for speech and text (optimistic at send), preserving today's instant-bubble text UX.

## 7. Error Handling & Fallbacks

| Situation | Behavior |
|---|---|
| Kokoro down / TTS fails | `/turn` returns `audio=null`. Show "Coach voice unavailable — using browser voice" **only when `audio===null` AND the server was expected to supply audio** (health `tts` is `kokoro`/`voicebox`, i.e. `ttsProvider !== "browser"`), so a future `TTS_PROVIDER=browser` config never misfires. Dedupe: show **once per session**, re-arm after any later turn returns real audio. Then speak via browser voice; set `ttsFallbackActive`. |
| Web Speech `not-allowed` / `service-not-allowed` / `audio-capture` | Mic-permission-denied `error` banner; text box stays usable. (Fixes the current handler that only special-cases `no-speech`/`aborted` and leaks a raw "Microphone error: not-allowed".) |
| Web Speech `no-speech` / empty draft | Same outcome (nothing heard): "Didn't catch that — try again or type", return to `idle` preserving any draft. |
| Web Speech `aborted` | Silent (self-initiated, e.g. barge-in / reRecord) — no banner. |
| Web Speech `network` | Distinct message: "Speech service unavailable — try again or type" (a connectivity failure, not silence). |
| Browser lacks Web Speech (non-Chrome) | Derived VoiceStatus: hide mic / suggest text or Chrome; text path works. |
| Brain 502 | Keep the user bubble, repopulate `draft`, return to `review` so the user retries without re-speaking. |
| Silence self-termination (`onend`, non-empty draft) | Restart recognizer, stay `listening` (continuity mode, §5.1); never silently drop to `idle` discarding a draft. |
| Barge-in / replay race | Single guarded transition; the playback controller clears the speak-timeout and nulls the audio ref before restart. `replay` is inert outside `idle`. |
| StatHeader vs runtime | Badge reads **configured** provider; the runtime "using browser voice" notice is the source of truth for the live path — no contradiction. |

## 8. Testing Strategy

Add **Vitest + React Testing Library + jsdom** to the client. Dev deps (complete list): `vitest`, `@vitest/coverage-v8` (coverage provider — Vitest ships none; required by the `test:coverage` script and the 80% gate), `@testing-library/react`, `@testing-library/dom` (explicit peer of RTL v16, not bundled), `@testing-library/jest-dom`, `jsdom`, and `@testing-library/user-event` (for TranscriptReview keyboard tests; `fireEvent.keyDown` is an acceptable substitute).

**jsdom setup (`client/src/test/setup.js`)** must stub every browser global the code touches, with install/teardown helpers so tests drive callbacks synchronously:
- `window.SpeechRecognition` **and** `window.webkitSpeechRecognition` — fake constructor with `start()`/`stop()`/`abort()`, settable `onstart`/`onresult`/`onerror`/`onend`, and `continuous`/`interimResults`/`lang`/`maxAlternatives`.
- `window.speechSynthesis` — `speak()`, `cancel()`, and `getVoices()` returning `[{lang:'en-US'}, …]` (used by `warmUpVoices`/`pickEnglishVoice`, which call `.find` on the result).
- `window.SpeechSynthesisUtterance` — separate global class (`speak()` news it up; jsdom lacks it → `ReferenceError` without the stub).
- `HTMLAudioElement`/`Audio` — jsdom's `play()` is a no-op returning `undefined`; stub it to return a **resolved Promise** so `audio.play().catch(...)` works, and expose settable `onplay`/`onended`/`onerror`/`paused`.
- `import '@testing-library/jest-dom/vitest'` (the `/vitest` subpath, not the bare entry).

**Vitest config (`client/vitest.config.js`, separate from `vite.config.js` to avoid pulling `@tailwindcss/vite` into the test transform):**
```js
test: {
  environment: 'jsdom',
  globals: true,                      // RTL auto-cleanup (or afterEach(cleanup) manually)
  setupFiles: ['./src/test/setup.js'],
  css: false,
  coverage: {
    provider: 'v8',
    include: ['src/hooks/useConversation.js', 'src/lib/speech.js'],
    thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
  },
}
```

- **Unit (hook + speech.js), via `renderHook` with actions in `act()`, and `vi.useFakeTimers()` for the timeout paths** (`speakReply`'s fallback is ≥4s):
  - State-machine transitions: idle→listening→review→thinking→speaking→idle, reRecord, cancel.
  - `continuous=true` on creation; multi-final accumulation (final segments commit, non-final tail via `onInterim`) so a multi-sentence utterance survives an intra-utterance pause.
  - Interim-tail-on-stop: a stop racing finalization still yields a non-empty reviewable draft; truly-empty draft → "Didn't catch that".
  - Auto-`onend` while listening (userStopped=false, empty draft) → restart/continuity, never a silent drop; userStopped=true → review.
  - Barge-in from `speaking` clears `speakTimerRef` so a late `toIdle` cannot fire after re-entering `listening`.
  - `replay` from `idle` goes through the playback controller (stops current audio, wires onEnd) and stays `idle`; inert in other states.
  - Fallback selection: server audio vs browser voice; banner predicate fires only for a kokoro-configured `audio=null`.
  - `speech.js` branch coverage: `playAudio` format branches (wav/opus-ogg/default), `pickEnglishVoice` fallbacks (en-US / ^en / null), and the empty/unsupported early returns.
- **Automated E2E (Browser pane, no real mic required):**
  - `/health` reports `tts=kokoro`; StatHeader shows the "configured" voice badge.
  - Text path: type → Send → **user bubble appears immediately** → coach bubble renders → `/turn` response carries audio and plays (network + no console errors).
  - Kokoro-down fallback: point `KOKORO_URL` at a dead port → turn still returns → browser-voice path + one-time notice; badge still reads "kokoro" (configured) without contradiction.
  - Barge-in: during `speaking`, `interrupt` → `audio.paused === true` → status `listening` → speak-timeout cleared.
  - Error states render (mic-denied and no-Web-Speech simulated by stubbing browser APIs).
- **Automated a11y:** `jest-axe` (or `@axe-core/react`) asserts no violations on idle/listening/review/thinking/speaking/error; assert the `aria-live` container, `role="alert"` banners, the state-correct MicButton `aria-label` (incl. barge-in), focus-return on review exit, and reduced-motion suppression.
- **Manual mic checklist (user, real Chrome):** tap mic → live interim → pause mid-thought (session stays open) → stop → transcript editable & accurate → Send → hear Kokoro voice; barge-in mid-reply; one accented-speech sanity sentence.

> Scope honesty: the Web Speech STT hop itself (mic → Google → text) cannot be automated; it is covered by the manual checklist. Everything around it is automated.

**Coverage denominator (unified across §8/§11):** the ≥80% Vitest gate is measured on the **unit-tested logic — `useConversation.js` + `speech.js`** (scoped via `coverage.include`). The presentational/behavioral components (`TranscriptReview.jsx`, `VoiceStatus.jsx`, `MicButton.jsx`) and the slimmed `App.jsx` are verified by the Browser-pane E2E + a11y checks, not the line-coverage gate.

## 9. Risks & Mitigations
- **kokoro-fastapi availability** (was not running when the temp config was set). → Bring it up via Docker as the first implementation step and smoke-test before any client work; break-glass = browser voice or voicebox-as-Kokoro-backend.
- **Web Speech reliability** (Google dependency, Chrome/Edge-only, network required). → Accepted per stack choice; text box + review step + explicit `no-Web-Speech`/`network` messaging mitigate.
- **Silence-driven recognizer termination:** Chrome fires `onend` on its own even with `continuous=true`. → Restart-and-continue on empty auto-`onend` (guarded against restart storms + max duration); preserve the draft otherwise. Unit-tested.
- **Playback timer/status races** (barge-in, replay, `onended` vs manual interrupt vs speak-timeout). → Single playback controller owns `currentAudioRef` + `speakTimerRef` + status; every start clears the prior timeout and wires `onEnd`. Unit-tested.
- **Scope creep toward M2** (adding fluency/corrections now). → Explicitly out of scope; no brain/scoring change.

## 10. File Change Map
**Server**
- `server/.env` — `TTS_PROVIDER=kokoro`, unset `STT_PROVIDER` (mirror intent in `server/.env.example`); refresh the stale `server/src/stt/index.js` doc comment.

**Client — new**
- `client/src/hooks/useConversation.js`
- `client/src/components/TranscriptReview.jsx`
- `client/src/components/VoiceStatus.jsx` *(or fold into the footer — decided in plan)*
- `client/src/hooks/useConversation.test.js`, `client/src/lib/speech.test.js`
- `client/vitest.config.js` + `client/src/test/setup.js`

**Client — modified**
- `client/src/App.jsx` — slim to consume the hook; remove Ruta B branch (`useServerSTT`/`startListeningServer`/`handleAudioTurn`); pass `onReplay` only in `idle`.
- `client/src/lib/speech.js` — `continuous=true` + interim/onInterim/onStart + interim-tail ref.
- `client/src/components/MicButton.jsx` — listening/interim + barge-in affordance + action-oriented `aria-label`.
- `client/src/components/StatHeader.jsx` — TTS badge title → "configured coach voice".
- `client/src/index.css` — `prefers-reduced-motion` guard on infinite animations.
- `client/package.json` — add the dev deps listed in §8; add `test` / `test:coverage` scripts.

**Untouched but relevant (dormant path):** `server/src/routes/turn.js` `/turn/audio`, `server/src/stt/*`, `client/src/lib/audio.js`, `client/src/lib/api.js postTurnAudio` — remain on disk behind `STT_PROVIDER`; not deleted (needed for M7).

**Optional cleanup (out of scope, note only):** `client/vite.config.js` proxies `/progress`, a route the server does not expose — drop or annotate as reserved; treat as a standalone cleanup, not part of this milestone.

## 11. Definition of Done
- `.env` switched (`TTS_PROVIDER=kokoro`, `STT_PROVIDER` unset); kokoro-fastapi verified on `:8880`.
- Client state machine implemented via `useConversation`; App.jsx thin; Ruta B client orchestration removed (dormant server path intact).
- Interim transcript (continuous session across pauses), review/edit-before-send, barge-in, replay, and status/error banners all working; user bubble optimistic at send for both paths.
- Vitest suite green with **≥80% line coverage on `useConversation.js` + `speech.js`** (the components verified via Browser-pane E2E + a11y checks).
- Automated Browser-pane checks pass; automated a11y (axe) passes on all states (live-region, alert-role, focus-return, actionable barge-in label, reduced-motion verified); manual mic checklist passes in Chrome.
- No behavior change to brain/scoring; dormant STT path still gated and unused.

## 12. Next (out of scope here)
Once the loop is trustworthy, resume the Harper design: a substrate-agnostic grammar detector plugged into `runTurn`, carrying a `source` hint (typed vs speech) so ASR noise doesn't pollute the ErrorLedger — feeding M2 structured feedback.

---
*Notes: (1) `C:\talker` is not a git repository, so this spec is not committed. If you want version history for the design docs, we can `git init` before implementation. (2) This spec was hardened against a multi-agent adversarial review (24 confirmed findings applied) on 2026-07-24.*
