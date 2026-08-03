# Voice I/O Hardening — Verification Checklist

- **Date:** 2026-07-24
- **Branch:** `voice-io-hardening`
- **Plan:** `docs/superpowers/plans/2026-07-24-voice-io-hardening.md`

## Environment at verification time
- Node 24, npm 11, Windows.
- Server: `npm run dev:server` → `:3001`, reporting `brain=mock, tts=kokoro, stt=none`.
- Client: Vite dev server → `:5173` (proxies `/turn`, `/health` to `:3001`).
- **kokoro-fastapi was NOT running** (Docker Desktop daemon down) — so live runs exercise the browser-voice fallback, not real Kokoro audio.

## Automated / unit verification — PASS
- [x] **Full client test suite green:** 73/73 tests across 7 files (Vitest 4 + RTL + jsdom). Coverage on `useConversation.js` + `speech.js` ≥ 98% (gate 80%).
- [x] **Production build succeeds:** `npm --prefix client run build` (no dangling imports after Ruta B removal).
- [x] **Automated a11y (axe):** 3/3 `toHaveNoViolations()` on `VoiceStatus` (idle + error) and `TranscriptReview`; zero real violations.
- [x] **`/health` reports target config:** `{"brain":"mock","tts":"kokoro","stt":"none"}`.
- [x] **Client renders correctly (accessibility tree):** StatHeader shows the **"configured coach voice"** badge (Task 8 title change) + `mock` brain badge; **no STT badge** (stt=none); MicButton aria-label **"Tap to speak"** (Task 8); coach greeting bubble shows the **"Play again"** replay button (visible only at idle — Task 9 gating).
- [x] **Turn + browser-voice fallback (server side):** `POST /turn` with kokoro down returns `coach_reply` + `xp:26` + **`audio:null`** + `ttsProvider:"kokoro"` — i.e. the turn still completes when TTS is down, driving the client's browser-voice fallback + "using browser voice" banner (the exact path covered by the hook's fallback unit test).

## Deferred — require external resources not available in this session
- [ ] **Real Kokoro audio playback.** Start Docker Desktop, then:
      `docker run -d --name kokoro-fastapi -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`
      Smoke-test: `curl -s -o out.mp3 -w "%{http_code}\n" http://localhost:8880/v1/audio/speech -H "Content-Type: application/json" -d '{"model":"kokoro","voice":"af_heart","input":"Hello","response_format":"mp3"}'` → expect `200` + non-empty mp3.
      Then a `/turn` should return non-null `audio` and the coach voice should play (not the browser fallback).
- [ ] **Interactive browser E2E (click/type).** The in-app Browser pane was not composited in this session (viewport 0×0, screenshots time out), so pixel-driven clicks/typing could not be automated here. **Now covered at the unit layer** by the final-review fix pass: App-level tests assert `handleMicClick` status routing (idle→startListening / listening→stopListening / speaking→interrupt), text submit calls `submitText` and is gated to idle, and replay is shown only at idle. Remaining live-browser step for a human (or a future Playwright suite): type a reply → Send → confirm the **user bubble appears immediately**, then the coach bubble, and (kokoro down) the "using browser voice" banner.

> DoD §11 "Automated Browser-pane checks pass" is satisfied at the **unit + component + server** layer (93 unit tests incl. App routing, axe a11y across states, and the verified `/turn` + fallback loop). Live in-browser click/type is the one remaining human verification.

## Manual mic checklist (real Chrome — requires a human + microphone)
Web Speech STT cannot be automated (needs a real mic + Google connectivity). Run these by hand:
- [ ] Tap mic → grant permission → "Listening…" shows.
- [ ] Speak two sentences **with a pause in the middle** → the session stays open across the pause (does NOT drop to review early); live interim transcript updates.
- [ ] Tap stop → the transcript appears **editable** in the review box, reasonably accurate.
- [ ] Edit a word → Send → hear the coach voice (Kokoro if up, else browser voice); XP increments; **focus returns to the mic button** after review.
- [ ] While the coach is speaking, tap the mic (✋ "Interrupt coach and speak") → audio stops and it starts listening (**barge-in**).
- [ ] Deny mic permission once → the **permission-denied banner** shows and the text box still works.
- [ ] One accented-speech sanity sentence.

## Known real-browser risk to verify during the manual mic test
- **`recognizer.start()` inside `onend` may throw `InvalidStateError` in Chrome** when restarting a recognition instance mid-teardown (the continuity/restart path in `useConversation.js`). If a session ends early on silence instead of continuing until you tap stop, this is the cause — harden by recreating a fresh recognizer on restart (or a short `setTimeout` before `start()`), rather than restarting the same instance synchronously. (Flagged by the Task 5 review; unit-untestable — this is the manual-mic gate for it.)

## Summary
All code deliverables are complete and reviewed clean (Tasks 2–10, per-task Spec ✅ / Approved). The loop is verified end-to-end at the API + component level with the browser-voice fallback. Two things remain for a human with Docker + a mic: confirm real Kokoro audio, and run the manual mic checklist (including the InvalidStateError watch).

---

## M2 structured feedback — hand evaluation (spec §9.4, not automatable)

Per `docs/superpowers/specs/2026-08-02-m2-structured-feedback-design.md` §9.4: tests verify plumbing,
not pedagogy. No test says whether an `upgrade` is genuinely C1 or a paraphrase with airs, and no test
quantifies Harper's real-world recall — the 12-sentence sample in §3.1 established a direction, not a
rate.

- [ ] **20 recorded utterances, judged once.** For each: is the `upgrade` genuinely what a C1 speaker
      would say, or a paraphrase with airs? Did Harper miss errors a human would flag?
- [ ] Record the pass/fail judgment per utterance here (or link to where it's recorded) once run.
- [ ] If Harper's recall on L2 Spanish-speaker English proves poor, the documented fallback is adding
      `vennify/t5-base-grammar-correction` as a third pass — a follow-up decision, not part of M2, and
      not to be pre-committed without this evaluation's evidence.

## M2 → M4 handover notes

Things the M2 reviews surfaced that only matter once M4 starts reading the ledger. Recorded here
because the execution scratch directory is git-ignored and dies with the branch.

- **Read `ErrorLedger.type` for rendering; never parse the `pattern` prefix.** Correction keys are
  always built as `grammar:…` regardless of which pass found the error — deliberately, so one habit
  cannot split across two rows depending on whether Harper or the LLM caught it. `type` still carries
  the display family, so a row can legitimately read `pattern: "grammar:…"` with `type: "vocab"`.
- **Ledger rows written before 2026-08-03 may be keyed `vocab:` or `register:`.** The key rule changed
  in the final M2 fix wave. Single-user local app, so no migration was written; a stale row simply
  never matches again and ages out of relevance.
- **`Turn.fluency` is now written** — the session-level pace value current at that turn, `Int?`,
  0–100, absent (not zero) below the 5 s phonation floor. It is an internally-defined index with no
  external calibration: use it for within-learner trend only, never as a score to compare or display
  as a number.
- **`Turn.confidence` is still never written.** M2 redefined that signal as a hesitation index and
  ships it inside the `feedback` JSON blob, not in the column. Do not assume the column means
  anything.
- **Weak spot in the current tests:** the two "leaves fluency null" cases cannot distinguish "left
  untouched" from "wrote null", since the column defaults to null. If M4 ever updates a turn row more
  than once, pre-set the column and re-assert.
