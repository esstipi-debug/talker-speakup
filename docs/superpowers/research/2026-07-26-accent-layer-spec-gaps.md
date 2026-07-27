<!--
Provenance: generated 2026-07-26 as the completeness critique of the technical brief
(run wf_8eb5e333-4a2). 27 gaps, 8 of them P0. The spec closes or explicitly defers each;
this file is kept as the checklist to audit the spec and the plans against.

Status: **RESEARCH INPUT, not a decision record.** The decisions distilled from this
live in `docs/superpowers/specs/2026-07-26-accent-prosody-layer-design.md`, which
**overrides this file wherever the two differ.** Claims here carry their own sourcing
inline; treat any unsourced number as unverified.
-->

## P0 — blocks the spec from being implementable

**1. No pronunciation provider factory. The brief never matches the existing pattern.**
`server/src/{brain,tts,stt}/index.js` are all identical: `get<X>()` + `current<X>Provider()`, resolve-once-and-cache from `<X>_PROVIDER`, surfaced in `/health` (`server/src/index.js:12-20`). §4 defines `ProviderId = 'local'|'azure'` and nothing else.
→ *Spec must answer:* module path (`server/src/pron/index.js`?), env var name, the third `none`/null provider id that is the R4 degraded state, and — because every existing factory caches at first call — whether `getPron()` re-probes when the sidecar comes up after boot, or the server must be restarted.

**2. Prisma is schema-only. "Bringing persistence forward" is a whole missing layer, not a table.**
Zero `PrismaClient` imports exist in `server/src` (verified by grep). No db module, no repository, no route writes a `Turn` or `Session`. The brief gives a deep TS interface and zero Prisma models.
→ *Spec must answer:* which of `PronunciationResult` is relational (words/syllables/phonemes/pauses/minimalPairs) vs a JSON column; where `raw`, `f0Track` and `energyTrack` live (these are the size drivers — an f0 track at 128-hop/48 kHz is ~375 floats/sec); whether the score hangs off `Turn` (never written today) or a new `GymAttempt`; retention/pruning; and the migration story for `schemaVersion: 1` → 2 re-derivation.

**3. Audio retention is never stated — the largest privacy hole in the brief.**
V3 A/B playback, schema-v2 re-derivation, and the R1 hand-segmentation experiment all require keeping the learner's audio. Nothing says whether it is persisted, where (filesystem vs SQLite blob), for how long, or how it is deleted. `DATABASE_URL="file:./dev.db"`, unencrypted.
→ *Spec must answer:* is raw audio persisted at all; if yes, path, format, TTL, delete-all affordance, and whether `.gitignore` covers it.

**4. `audioLeftDevice` is an assertion, not an enforcement.**
The "local" provider is a Docker container reached over HTTP — audio leaves the process. Nothing in the architecture makes the boolean true.
→ *Spec must answer:* what enforces it (bind `127.0.0.1` only, compose `network_mode`, no egress from the sidecar image), what exactly the badge claims, and — since the sidecar image is built to be offline (models pre-downloaded) — whether egress is actually blocked or merely unused.

**5. The MediaRecorder path is not "removed" — it is orphaned, and the brief doesn't say what happens to it.**
`client/src/lib/audio.js`, `api.js#postTurnAudio`, and `POST /turn/audio` (`server/src/routes/turn.js`) all still exist; nothing imports them (`useConversation.js` uses only `postTurn` + Web Speech). Worse, `audio.js:29` calls `getUserMedia({ audio: true })` — the exact unconstrained call §1 forbids.
→ *Spec must answer:* does `micStream.js` replace and delete `audio.js`, or wrap it; does one recording fan out to both `/turn/audio` (STT) and a new scoring endpoint, or are they separate captures; and is `/turn/audio` now live or still dormant.

**6. The single-`getUserMedia` design collides with the existing recognizer lifecycle.**
`createRecognizer()` (`client/src/lib/speech.js:22`) takes no track and calls bare `rec.start()`. `useConversation.js` auto-restarts the recognizer (`MAX_EMPTY_RESTARTS = 6`) inside a 5-state machine.
→ *Spec must answer:* who owns the track across recognizer restarts; what happens to the worklet ring buffer when the recognizer restarts mid-utterance; and what the fallback is when `SpeechRecognition.available({processLocally:true})` is false — cloud Web Speech (which silently breaks claim #1), voicebox/Whisper via the dormant STT factory, or text-only. Chrome 139+ is also a hard floor with no Firefox/Safari story.

**7. No sidecar transport contract.**
There is no `docker-compose.yml` in the repo (Kokoro is run externally, `KOKORO_URL` in `server/.env.example`). The brief names an image and a model but no interface.
→ *Spec must answer:* endpoints, request/response envelope, PCM format/sample-rate/endianness, whether `referenceText` or a pre-built dictionary is sent, timeout, concurrency (one warm worker = a lock), health endpoint, `PRON_SIDECAR_URL` naming, and how it starts.

**8. No Gym content inventory exists, and three metrics depend on it.**
M4 needs per-sentence pre-annotated nuclear accent; M5 needs a `sentenceId` set that excludes /j w r l/; §3 needs a wikipron-derived, human-passed minimal-pair list; §3 says the cognate stress list must be regenerated from a dictionary.
→ *Spec must answer:* how many sentences and pairs at v1, the record shape, where it lives (seeded Prisma table vs static JSON asset), who annotates, and whether `comparableToPublished` can ever be true given the constraint.

## P1 — metrics/thresholds that are named but unusable

**9. `alignmentConfidence` gates everything and is undefined — both value and derivation.**
R1 makes it the safety valve; §4 makes it `Confidence | null`; V2 says "hard-gate" on it. MFA does not emit a per-unit posterior from `align_one`.
→ *Spec must answer:* what quantity it is computed from, and the two numeric cut-offs for syllable→word→nothing.

**10. No enrollment/baseline pass is designed, yet four metrics require one.**
M3 needs "the speaker's own schwa centroid"; M6 needs "your usual"; M1 bands are explicitly "re-derive on the learner's own pipeline"; M5 requires a per-sentence noise floor from 5–10 reads.
→ *Spec must answer:* what the enrollment session is (prompts, count, duration), where it is stored, when it is invalidated (any `captureSettings` change? new mic? re-run cadence?), and what the product does before enrollment exists.

**11. M4's prominence estimator is a formula-shaped hole.** "Combined F0 excursion + duration + intensity" has no weights, no normalisation, no tie-break, no confidence, no abstain — yet it ships as binary hit/miss feedback. → *Spec must answer:* the exact combination and the abstain condition.

**12. Minimal-pair `margin` has no calibration procedure.** Four verdict states, no thresholds, and no stated difference between `'borderline'` and `'unclear'`. → *Spec must answer:* how many recordings from whom, target false-accept/reject rate, and what the two thresholds are.

**13. Browser F0 has no configuration or fallback.** The worklet emits `clarity` but no clarity cut-off is given; no min/max Hz search range (matters for a male vs female learner); no octave-jump handling; no median filter. `pitchy` has no plan B if MPM is unstable on this voice. → *Spec must answer:* voiced/unvoiced threshold, Hz range, post-filter, and what happens when >X% of frames are unvoiced.

**14. Two F0 estimators produce two answers for the same audio.** Browser `pitchy` (MPM, 48 kHz/2048) and sidecar `pyworld` (dio/stonemask, 16 kHz/10 ms) both feed `ProsodyDetail.f0Track`. → *Spec must answer:* which is authoritative for storage, whether they are ever compared, and — given the browser already has F0 — what `pyworld` buys that justifies R7's build risk.

**15. No fallback aligner if MFA fails.** R2 bounds the *latency* outcome (Gym-only) but R3's PostgreSQL/WSL2 failure mode has no plan B, and every CTC alternative was rejected on licence. → *Spec must answer:* if the R2/R3 spike fails, does M7 descope to browser-only metrics, and what ships in the Gym instead.

**16. `captureSettings` segmentation is unenforceable as written.** Rule 9 says never plot across differing `captureSettings`, but that is a whole `MediaTrackSettings` object. → *Spec must answer:* the exact subset of fields that forms the comparability key, and what the UI does when the key changes mid-history.

**17. Existing scoring collides.** `Turn.fluency Int?` / `Turn.confidence Int?` in `schema.prisma`, `basicXp()` in `server/src/brain/scoring.js`, `totalXp` in the hook. §4 mandates `Score100` float, never 0–5. → *Spec must answer:* does pronunciation feed XP; do M7 floats overwrite or coexist with the M2 Ints.

**18. The teaching loop is not wired to the existing memory.** `ErrorLedger.type` already enumerates `"pronunciation"` and `VocabItem` already carries `nextReviewAt` (SM-2). The brief never connects a `'substituted'` verdict or a failed M3 word to either. → *Spec must answer:* the `ErrorLedger.pattern` key format for a phone substitution, and what schedules tomorrow's drill set.

## P2 — testing, a11y, degradation detail

**19. The server has no test harness at all.** `server/package.json` has no `test` script and no test runner; only the client has vitest. Adapter rules (10 of them), the factory, persistence, and the Azure golden-file test have nowhere to live. R8 only covers the browser worklet. → *Spec must answer:* server test runner, whether CI runs Docker (the sidecar tests are meaningless otherwise), and where audio fixtures come from — **EpaDB is CC BY-NC-ND and cannot be committed**, so the R1 validation fixture has no repo-legal home.

**20. Ported DSP has no way to prove correctness.** de Jong & Wempe, Prosogram stylisation and the VarcoV pipeline are ported *from prose* precisely because the reference scripts are GPL — which also removes the only source of golden values. → *Spec must answer:* how numerical correctness is demonstrated without the reference implementation (synthetic signals with known ground truth? hand-segmented fixtures?).

**21. V4 has no accessible equivalent, and V3 — the only non-visual channel — dies with the sidecar.** V4 mutates live transcript typography (screen readers get nothing; copy/paste and dyslexic readability degrade). V3 is synthesised in numpy inside the container. → *Spec must answer:* is V4 off by default behind a toggle and what is its text alternative; and does V3 get a browser-side WebAudio synthesis path so the accessible channel survives the R4 floor.

**22. R4's floor is named but has no state model.** There is no `status`/`pending` field on `PronunciationResult`, no queue, no retry/backfill. → *Spec must answer:* what the Gym renders when the sidecar is down (disabled? record-and-queue?), whether audio is retained for later scoring (loops back to gap 3), and what the user is told.

**23. "One imperative sentence per visual" is an unassigned coach-layer integration.** Template table or LLM? The brain (`server/src/brain/`, `prompts/coach-system.js`) currently never sees acoustic data, and an LLM handed raw metrics will invent numbers. → *Spec must answer:* deterministic templates vs LLM generation; if LLM, exactly which fields are passed and what constrains it from stating unmeasured values. Also unstated: feedback copy language for an L1-Spanish learner.

**24. No latency budget or placement for the per-turn snapshot.** The syllable-nuclei pass is explicitly non-streamable and runs on the main thread at end-of-turn, while `useConversation` transitions straight to `thinking` and then plays TTS. → *Spec must answer:* does the snapshot block the coach reply or render asynchronously afterwards, and what is the main-thread budget.

**25. Gym has no place in the app.** `App.jsx` is a single conversation screen; no router, no nav. → *Spec must answer:* how Gym mode is entered, and how a Gym attempt relates to `Session`/`Turn`.

**26. CC BY 4.0 attribution for `english_us_arpa` has no surface.** "Ship an attribution notice" — the repo has no NOTICE/THIRD-PARTY file and no about screen. → *Spec must answer:* file and/or UI location.

**27. The contract is written in TypeScript; the repo is plain ESM JS.** "Enforce in the factory, not in callers" implies a runtime validator that does not exist. → *Spec must answer:* JSDoc typedefs + zod (new dep) vs adding TS to the server.