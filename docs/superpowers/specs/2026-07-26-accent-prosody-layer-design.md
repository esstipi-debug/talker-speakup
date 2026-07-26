# Accent & Prosody Layer (M7) — Design Spec

- **Date:** 2026-07-26
- **Status:** Approved (design), hardened via two multi-agent reviews (6-topic research sweep + 4-lens expert panel, each adversarially refuted), pending implementation plan
- **Owner:** SpeakUp (C:\talker), branch `claude/talker-accent-layer-2ebeff`
- **Relates:** supersedes the placeholder "M7 — Pronunciation (CAPT)" row in the README roadmap; brings **M3 (persistence)** forward; independent of M2 (grammar)

> **On file:line citations.** Line references below were established by reviewer agents reading the
> tree at commit `99889e0`. They are load-bearing for *what to change*, not for *what is true today* —
> re-verify each before editing.

---

## 1. Context

The user asked: *"can we add an accent and pronunciation layer to talker, something that teaches rhythm and other speech skills?"*

The emphasis is on **teaching**. That is a different feature from the roadmap's M7, which was scoped as *diagnosis* (phoneme-level scoring via wav2vec2/GOP, blocked behind M6's local-audio work). This spec covers both, with teaching as the primary deliverable.

### The pedagogical core

Spanish is **syllable-timed** — every syllable takes roughly the same time. English is **stress-timed** — stressed syllables stretch and everything between them collapses toward schwa. For an L1-Spanish speaker this single difference moves the accent more than any segmental drill. *"I've been thinking about it all week"* is nine syllables and **three beats**; a Spanish speaker produces nine equal beats.

That is what the layer teaches.

### Current state (verified in code at `99889e0`)

- **Client:** React 19 + Vite. `useConversation.js` is an explicit state machine `idle→listening→review→thinking→speaking`. 93 tests (Vitest + RTL + jsdom + jest-axe), ~99% coverage on `useConversation.js` and `speech.js`.
- **Server:** Express 5, factories for `brain/` (mock|mistral), `tts/` (kokoro|voicebox|browser), `stt/` (voicebox|unset), surfaced as pills via `GET /health`.
- **Prisma:** `schema.prisma` defines `Session`, `Turn`, `ErrorLedger`, `VocabItem`, `Scenario`, `Progress` — and **zero `PrismaClient` imports exist in `server/src`**. Persistence is a whole missing layer, not a table.
- **Server has no test runner** — `server/package.json` has no `test` script.
- **Orphaned audio path:** `client/src/lib/audio.js`, `api.js#postTurnAudio`, and `POST /turn/audio` all exist; nothing imports them. `audio.js` calls unconstrained `getUserMedia({audio:true})` and hardcodes `audio/webm;codecs=opus`.
- `App.jsx` is a single conversation screen — no router, no nav.
- No `docker-compose.yml`; Kokoro runs externally via `KOKORO_URL`.
- Repo is plain ESM JavaScript. No `NOTICE`/`THIRD-PARTY` file.

---

## 2. Goal & Non-Goals

### Goal

A learner with C1–C2 ambitions can, in ~7 minutes a day, practise English rhythm against a spoken model, see how their own timing differed, try again immediately, and have yesterday's failures come back on a schedule.

### Non-Goals (v1)

- **Open-vocabulary phoneme scoring (IPA/PER/GOP).** Best published F1 for phone-level mispronunciation detection on L2-ARCTIC is 61–63% (GOP variants 42–45%) — coin-flip feedback for a C1–C2 learner.
- **Intonation as a taught skill.** F0 is used internally as one of the three cues for prominence. No pitch-contour view. Deferred.
- **Any claim of transfer to free conversation.** See §16.
- **A "distance from native" score.** See §5.4.
- **Cloud pronunciation assessment.** Field names are borrowed for shape compatibility; no adapter is implemented.

---

## 3. Locked decisions

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| D1 | Teach vs measure | **Both, one milestone** | User's call, made explicitly |
| D2 | Surface | **Hybrid** — per-turn snapshot + dedicated Gym | Hard scoring lives where a reference sentence exists |
| D3 | Engine scope | **Prosody** (alignment + F0) **+ curated binary minimal pairs** | Binary discrimination against a known target is categorically easier than open transcription |
| D4 | Runtime | **Hybrid** — browser Web Audio live, Python sidecar for alignment | Live feedback needs zero latency; alignment needs a model |
| D5 | Persistence | **Full M3 brought forward** | The ledger is what makes it teaching rather than measuring |
| D6 | Intonation | **Signal, not a view** | Scope discipline |
| D7 | Curriculum | **Curated units + deterministic phonetics + ledger targeting** | The LLM may propose sentences; it never decides phonetics |
| D8 | Per-turn snapshot | **Scripted "echo moments" only** | See §3.1 |
| D9 | Manual effort | **Validation (~2 h) + full curriculum review** | See §6 and §13 (K3). The one thing no agent can substitute |

### 3.1 Why the free-turn snapshot was cut

The original design put stress dots under every conversational turn, computed in-browser. Research killed it:

- The energy-envelope syllable-nuclei detector **misses unstressed syllables**, and misses them *harder* the more syllable-timed the speech is. On an L1-Spanish speaker the metric can move **opposite to the truth**.
- De Jong & Wempe (2009) is **not streamable** — its threshold is a global statistic over the whole file.
- There is **no published English validation** of that script (the r=.82 figure often cited belongs to a different algorithm).
- Windows 11 **Voice Focus / per-device AGC** run *below* the browser. No `getUserMedia` constraint reaches them, and AGC continuously renormalises exactly the loudness signal the envelope reads.

The only live-safe metric without alignment is the **silent-pause profile**. Everything else moved to scripted contexts, where a reference sentence exists and forced alignment is valid.

---

## 4. Architecture

Three paths. Only two touch the sidecar. **The conversation loop never gains a hard dependency on Docker.**

### 4.1 Path 1 — Free conversation (browser only)

```
mic ─► micStream.js ─┬─► Web Speech (processLocally:true) ─► transcript ─► POST /turn
                     └─► AudioWorklet ─► {rms_dB, hz, clarity} per hop
                                              │
                                      silent-pause profile
```

- **One `getUserMedia`**, owned by a new `client/src/lib/micStream.js` — a plain module singleton (`let current = null`), `getMicStream()` creating lazily, `releaseMicStream()` from a `visibilitychange`→hidden listener in `main.jsx`. **No refcount, no idle-grace timer**: a leaked reference leaves the mic hot in the one project whose headline claim is `audioLeftDevice`. `acquire()` is called only from event handlers, never an effect — `main.jsx` wraps App in `<StrictMode>`.
- Constraints in exactly one place, nested under `audio:{}`: `echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1`. Read back `track.getSettings()` and persist it with every measurement.
- **Two consumers, not three:** Web Speech + AudioWorklet. The worklet *is* the recorder. `client/src/lib/audio.js` is **deleted**.
- **Worklet contract:** emits raw per-hop `{rms_dB, hz, clarity}` only — no nuclei, no counts, no rates in the audio thread. Three preallocated `Float32Array`s batched every 32 hops (~12 msg/s, not 375), `t` implicit as `index * hop / sampleRate`. **Structured-clone copy, not transfer** — transferring detaches the buffer and forces an allocation in `process()` 12×/s. Raw ring capped at ~15 s. **No raw audio retained for free-conversation turns at all.**
- **Pause placement without word timings.** Chrome's `SpeechRecognitionAlternative` exposes only `transcript` + `confidence`. Do **not** interpolate from `event.timeStamp` — that is *dispatch* time, and the recognizer finalizes *because* it detected the silence, so the anchor is displaced by exactly the interval being measured. **Invert it:** record the worklet-clock time of each finalization and use the recognizer's own endpoint decisions as boundary evidence. Classify each silence ≥`PAUSE_MIN_MS` as `boundary` (a finalization fell inside the pause window, or the preceding chunk ends in punctuation), `internal` (strictly inside one finalized chunk), else `unknown` — excluded from both mean and count. Clause splitting is a ~10-line browser regex.
  This also makes recognizer auto-restarts a non-issue: a restart **is** a finalization, so the hole reads as `boundary`.
- No `Date.now()` anywhere in the measurement path.

### 4.2 Path 2 — Echo moment (scripted, in conversation)

The coach offers *"say it with me"* on a curated line. A reference sentence exists ⇒ alignment is valid.

```
Kokoro models ─► record ─► PCM 16 kHz ─► /pron/score ─► alignment ─► stress dots (D)
```

Sidecar down ⇒ the echo moment **still runs** as pure modelling: target row only, no score.

### 4.3 Path 3 — Pronunciation Gym

```
ledger ─► unit ─► Kokoro models ─► beat karaoke (C) live in-browser
                        │
              record ─► /pron/score ─► duration ribbon (B) + verdict ─► Prisma ─► ledger
```

### 4.4 The provider factory

`server/src/pronunciation/` matching the `brain|tts|stt` shape: `getPron()` + `currentPronProvider()`, resolved from `PRONUNCIATION_PROVIDER=local|azure|mock|none`, surfaced in `GET /health`.

Two deliberate divergences:

1. **`none` is a first-class degraded state**, not an error.
2. **No `/health` block, no background probe, no re-probe timer.** Copy the Kokoro layering exactly: `POST /pron/score` returns `{ scored: false, reason: 'scorer-offline' }` on connect-refused or timeout, and the UI renders the unscored card from *that* — the same shape as the existing `ttsFallbackActive`. "Start Docker mid-session and it works" falls out for free: the next attempt simply succeeds. The client's one-shot `/health` fetch on mount must never gate scorer UI.

### 4.5 Transport

- Browser → Express → sidecar. `POST /pron/score` **multipart** (`multer` is already a dependency); the server's 1 MB JSON cap and its catch-all error handler (which swallows `err.status`, surfacing a 413 as a bare 500) make JSON the wrong choice.
- **One route prefix, `/pron`**, added to the Vite proxy in the same commit (and delete the dead `/progress` proxy line — no such route exists).
- Sidecar = a single asyncio lock returning `503` + `Retry-After: 1`.
- `PRON_TIMEOUT_MS`, default **30 s** (a cold `align_one` is plausibly 4–10 s). Timeout is treated identically to unreachable.
- **Audio format:** decode in the browser, resample to 16 kHz mono via `OfflineAudioContext`, POST raw PCM/WAV. `soundfile`/`librosa` cannot open a WebM container, and this keeps `ffmpeg` out of the image. The `OfflineAudioContext` buffer must be created at the **source** rate and driven by a real `AudioBufferSourceNode`.
- **`POST /pron/speak`** for the fixed lines the Gym and echo moment need (`getTTS()` is reachable today only from `runTurn()`). Returns **200 `{audio: null}`** when TTS is unavailable — never 503, which would invert the existing client fallback semantics. Gym inventory is pre-rendered at seed time to `server/.data/tts/<unitId>.wav`. Plumb `speed` into the Kokoro adapter (currently unsent) for a real slow model — **not** `playbackRate`, whose phase vocoder smears the F0 and formant detail the drill teaches.
- **`POST /turn/audio` stays dormant.** It is the standing fallback if `SpeechRecognition.available({processLocally:true})` is false.

### 4.6 Client state

- **Echo is one new member, `"echo"`, on the top-level status union**, with sub-phases in a separate `useEchoMoment()` hook. Two state machines contending for `getUserMedia` is a problem we don't have.
- Trigger from the **turn payload**, not from the TTS `done` callback — `playCoach` has three exits and the watchdog sets `idle` *without* calling `done`, so any overrunning TTS would silently drop the echo. Guard with `setStatus(s => s === "speaking" ? "echo" : s)`.
- Allow `interrupt()` from `echo` as Skip.
- **Echo attempts never enter `messages`** and therefore never reach the history window sent to the brain.
- **Message identity:** messages are currently keyed by array index, and the hook resets `messages` to `historyBefore` on brain failure — so an in-flight async snapshot can land on a different utterance. Add an `id` at push time from a **module counter** (`let _mid = 0`), not `crypto.randomUUID` (jsdom coverage is version-dependent; a throw at push time would take out all 40 hook tests).
- **Gym navigation:** `const [view, setView] = useState("chat")` in `App.jsx`, `useConversation()` stays mounted at App level, two `<button aria-pressed>` in `StatHeader`. **No router.** Extract today's `<main>` + `<footer>` into `ChatView.jsx` — and move the mic-button ref, previous-status ref, pending-focus ref and the focus effect **with** it, or the pending-focus ref never clears while in the Gym and steals focus on return. Expose `stopPlayback` from the hook (private today) and call it on view switch.

---

## 5. Engine & metrics

### 5.1 Stack

| Layer | Choice | License | Note |
|---|---|---|---|
| Browser F0 | **`pitchy` 4.1.0** (McLeod), **vendored** | MIT | 48 kHz / 2048 window / 128 hop ≈ 0.95% of one core. Do **not** decimate to 16 kHz. One maintainer, no release since Jan 2024 — vendoring is the mitigation, not a fallback |
| Browser energy | hand-rolled RMS→dB in the same worklet | own | — |
| Aligner | **MFA, pinned `v3.3.9`/`v3.3.10`** — *not* v3.4.x | MIT | 3.4 is mid-migration to a HF model format. Image ~1.8 GB compressed; budget 4–5 GB WSL2 vhdx |
| Acoustic model + dictionary | **`english_us_arpa` v3.0.0** (199,858 words) | **CC BY 4.0** | Chosen for the phone tier in **ARPAbet with stress digits** (`AA1`, `AH0`…): nucleus = `/[A-Z]+[012]/`, stress = the digit. **Zero G2P, zero syllabifier, zero GPL.** Pre-download at image build time. Attribution must ship |
| Target track | `pitchy` over the decoded Kokoro render in an `OfflineAudioContext` | — | **`pyworld` is cut** — no manylinux wheels, and two estimators would give two answers for the same audio |
| Minimal pairs | MFA pronunciation-variant forced choice, **gated on K4** | — | Fallback if it fails: cut from v1 |
| Client viz | plain SVG | own | The client has zero viz deps today. Keep it that way |

**Hard license exclusions:** `praat-parselmouth` (GPL-3.0, links **in-process** — the sidecar would become GPL), `phonemizer`/`espeak-ng` (GPL-3.0), `pitchfinder` (GPL-3.0), `essentia.js` (AGPL-3.0), `aubiojs` (embedded GPL C lib), `torchaudio.pipelines.MMS_FA` (CC-BY-NC-4.0), `ctc-forced-aligner` (NC model + non-OSI licence), `charsiu` (unlicensed weights), `Thiagohgl/ai-pronunciation-trainer` (AGPL-3.0 §13 network copyleft), `EpaDB` (CC BY-NC-ND — usable as an offline benchmark only, never committed), `gop-dnn-epadb` (BY-NC-ND).

### 5.2 Metrics

Ordered by evidential strength, not by how impressive they look.

**M1 — Silent-pause profile.** *Live-safe, the guaranteed floor.* Silences ≥ `PAUSE_MIN_MS` (named constant, default 250 — de Jong & Bosker 2013: 22–27% of pauses fall below it and are irrelevant), reported with **placement** (clause-internal vs clause-boundary), not just duration. Placement is the C1–C2 tell; duration is not. Bands have a **floor and a ceiling** (0.3–0.8 s is the reported highest-intelligibility window) — not "shorter is better". **The pause floor is adaptive**, relative to the utterance's own 95th-percentile RMS, because Windows AGC renormalises loudness below the browser.

**M2 — Articulation & speech rate.** *Session-level only.* Computed over **≥5 s of accumulated phonation**. Per-turn rate is noise with a progress bar — de Jong & Wempe are explicit that a one-syllable miscount on a short spurt swings the result enormously. Scoring is **curvilinear**: penalise both directions. L1-Spanish read speech measures ~8.0 syll/s against ~5.6 for French; expect to be above the English band.

**M3 — Stressed : unstressed vowel-duration ratio.** *The Gym headline.* Per polysyllabic target word, `dur(stressed vowel) / dur(each unstressed vowel)`, from the aligned phone tier. Stress digit comes free from `english_us_arpa`.

**M3-ext — Function-word weak forms.** Monosyllabic function words have no word-internal ratio, so M3 cannot reach *to / for / and* — which is precisely where residual signal lives at C1–C2. Extension, not a new engine: compute `dur(vowel)` against the **sentence's** stressed-vowel mean, from the same phone tier. Zero new dictionary surface.

**M4 — Nuclear stress placement.** Binary hit/miss against a pre-annotated nucleus. Prominence estimator combines F0 excursion, duration and intensity — **weights, normalisation and the abstain condition must be pinned in the implementation plan.** Drops the intensity term if K2 fails. **Never attempted on free turns.** Ships only if K3 passes.

**M5 — VarcoV.** *Hidden progress index, never displayed.* `100 × SD(vocalic durations) / mean(vocalic durations)`. Three hard constraints: (a) store `sentenceId` with every score and **never average across prompts** — sentence materials dominate the variance above speaker; (b) **delta-from-own-baseline only**; (c) **not comparable to published values** — those are hand-segmented on stimuli built to exclude /j w r l/. Drives a trend line on the 6 PROBE sentences and nothing else. `comparableToPublished` is hardcoded `false`.

**M6 — Pitch variation.** *Two-state nudge, no number.* Store f0 **span** in semitones (90th–10th pct) separately from f0 **level** (median). Never store or display Hz: absolute F0 measures the larynx, not the language — published "pitch height" effects invert purely from speaker register and sex. Output is one sentence: *"Flatter than your usual today."*

### 5.3 Explicitly not surfaced

**nPVI-V** (fails on exactly this population — 66 vs native 73, n.s., *"despite the perceptible non-native accent"* — and is redundant with VarcoV at r=0.863) · **any IOI-variability metric** (the nuclei detector can move opposite to the truth on syllable-timed speech) · **ΔV/ΔC/rPVI-C/VarcoC** (perceptually inert) · **%V as display** · **any rhythm metric on a free conversational turn** · **a single composite score as the headline** · **raw milliseconds**, until K3 produces a measured boundary error — express everything as a ratio or percentage.

### 5.4 Measurement ethics

Everything is **within-learner trend against your own baseline**. Never "distance from native".

Native Orkney English and Welsh Valleys English both score **53** on VarcoV; L1-Spanish English scores **54**. A distance-from-native badge would be asserting that Welsh English is broken. This is not a stylistic preference — it is why the whole scoring model is relative.

---

## 6. Curriculum

Static JSON committed at build time. LLM-drafted, human-passed (D7: the LLM proposes sentences, never phonetics — ARPAbet is resolved from the MFA dictionary at seed time, so OOV is impossible by construction).

| Set | Count | Role |
|---|---|---|
| **PROBE** | 6 | Fixed. Re-read weekly. The **only** units whose `rhythmIndex` is ever stored or plotted |
| **PRACTICE** | 20 | `rhythmIndex: null`. Free to rotate. Weighted toward function-word density |
| **Minimal pairs** | 24 | Generated from `CUNY-CL/wikipron` (Apache-2.0), human-passed. **Only if K4 passes** |

**Deaccenting** enters as curriculum *shape*, not a new metric: two-sentence pairs where sentence 2 repeats a noun from sentence 1; apply M4's estimator to the known-given word with target = **not** max prominence. Binary, abstains when M4 abstains, free.

### 6.1 Contrast inventory (BLOCKER tier, if K4 passes)

Two-tier split is **mandatory**. A naive frequency sort puts dark /ɫ/ (84.9% error rate) and aspiration at ranks 1–2 — the two *least* consequential items. Score BLOCKER as intelligibility; put POLISH on a separate visible axis.

**BLOCKER:** /ɪ/~/iː/ · schwa reduction *(owned by M3, not the segmental drill)* · /æ/~/e/ · /v/~/b/ · /z/~/s/ · /ɑː/~/ʌ/ · /oʊ/,/eɪ/ diphthongisation · /ŋ/~/n/~/ŋk/ · /h/~[x] · /dʒ/~/j/ · final clusters & devoicing.

**Peninsular adjustments** (inference from a Rioplatense corpus, not measurement — flagged as such): /h/ and /dʒ/ rank **higher** than the source data suggests (Castilian ⟨j⟩ is a harsh [x]; Rioplatense yeísmo gives Argentines [ʒ] for free). **/θ/ is VERIFY, not cut** — it sits mid-table, *above* /h/; the famous "Spanish TH" demotion is only supported for **/ð/**. Settle it by recording "think/sink" once in session 1.

**POLISH:** aspiration · /ɜː/ NURSE · dark /ɫ/ · sC-prothesis ("eSpain"). Frame these as *polish*, never "people can't understand you".

**Cognate lexical stress seeds:** COMfortable/conforTAble · INteresting/intereSANte · ADmirable/admiRAble · CAtegory/categoRÍa · CHOcolate/chocoLAte · CApitalism/capitaLISmo · biOLogy/bioloGÍa. Regenerate the full list from a dictionary before shipping — Spanish stress is orthographically deterministic. *"hotel" is invalid: both languages stress the final syllable.*

---

## 7. The teaching loop

**The design's original failure mode, caught by review: it was a measurement loop.** Model → attempt → feedback existed; **re-attempt and spacing — the two steps that cause change — were undefined.** The only *objective* result in the closest prior art (RhythmTA, UIST '25) is that the visualisation bought **more attempts per clip** (3.08 vs 2.26, p<.05, at no time cost). Every Likert win there is n=12 self-report after one session. We had imported the chart and dropped the mechanism.

### 7.1 A Gym session

**Fixed size: 6 items, ~7 minutes.** 3 due (`nextDrillAt <= now`, highest `frequency` first) + 2 new (BLOCKER before POLISH, never mixed) + 1 free. Fixed size is what makes "done" reachable.

**Cold start:** with a `frequency >= 3` scheduling gate nothing is due before roughly day 4, so the set degrades to new-only for the first week. Expected, documented, not a bug.

### 7.2 One item

**1 · MODEL.** Kokoro plays the pre-rendered line. Permanently visible — not as a fallback — the sentence with stressed syllables in `<strong>` **and** the ELT notation `da-DA-da-da-DA`. Beat karaoke (C) animates over it. Under `prefers-reduced-motion` the notation and the bolded sentence **are** the model step and nothing is lost. A "Play slow" button re-synthesises at `speed: 0.75` server-side.

> *"Listen for the shape: two beats, not five. da-DA-da-da-DA."*

**2 · ATTEMPT.** Record. `GymAttempt` row written **before** the sidecar is called.

**3 · FEEDBACK.** Duration ribbon (B) — target above (seed-time alignment of the Kokoro render), learner below, one shared time axis, **word granularity by default**. Below it, **one imperative sentence** from a deterministic template table, derived from the largest deviation only (cap duplicates, sort descending, drop the smallest — RhythmTA's own algorithm). Beside it, the hum A/B.

> M3: *"'COMfortable' — the middle vowel is doing too much work. Squash it, lean on COM."*
> M3-ext: *"'to' came out full. Let it go soft — 'tuh'."*
> M4: *"You put the peak on MONEY. The contrast is on HE."*
> Abstained: *"Couldn't hear that clearly enough to score. Once more, a bit closer to the mic."*
> Offline: *"Not scored — scorer offline."* + Retry if the audio is still in memory.

New contrasts get **one** stored `l1Anchor` string, shown once, never generated: *"la /i/ de piso, no la de sheep."* Everything else in English — at C1–C2 the instruction is itself input.

**4 · RE-ATTEMPT.** One button, **"Try again"**, unlimited. From attempt 2 the ribbon renders **three** tracks: target (solid), previous attempt (ghosted 40%, dashed), current. The sentence names whichever delta is larger and says which:

> *"Better — that vowel came down 30 ms. Again, further."*
> *"Still 60 ms long. Try holding the first syllable instead."*

**The unit closes when the learner closes it. Never on a score threshold** — a score gate on an uncalibrated metric produces an unpassable exercise. And **no mandatory 3-attempt block**: RhythmTA observed *free* re-attempting, and mandating three on a unit nailed first try is exactly the anxiety failure mode its own instructor interviews warn about.

**5 · LEDGER.** On close, grade **attempt 1** (clean → advance, failed → reset). Upsert into the existing `ErrorLedger` with `type = "pronunciation"`. `pattern` names a **practisable class**, never an instance; the offending word goes in `example`:

| `pattern` | Written when |
|---|---|
| `pron:reduce:{word}` | M3 ratio failure on a polysyllable |
| `pron:weakform:{word}` | M3-ext failure on a monosyllabic function word |
| `pron:lexstress:{word}` | Stress on the wrong syllable |
| `pron:nuclear:{contextType}` | `contrastive` \| `given-info` \| `final-default` — **three rows total** |
| `pron:seg:{EXPECTED}>{PRODUCED}` | Minimal-pair `'substituted'` — only if K4 passed |

Upsert on every **non-abstained** failure; `frequency++`. A drill is only *scheduled* at `frequency >= 3` — keeps the data, de-noises the schedule. Never write a schwa row: it would be one near-permanent entry carrying no targeting signal.

**6 · SPACING.** `nextDrillAt` on a fixed ladder **1d → 3d → 7d → 21d** on a clean attempt-1 pass; **reset to 1d** on failure. `drillCount` increments. Five lines. **No SM-2, no ease factor, no shared scheduling module** — full SM-2 needs a 0–5 quality history an uncalibrated aligner cannot supply.

**7 · SELECTION WHEN OFFLINE.** Least-recently-started, tie-broken by worst score among rows with non-null `metrics` — *not* gated on a score, or a sidecar-down Gym serves the same unit forever. **No backfill queue, no retry job:** a score arriving days later attached to a forgotten rep is worth less than the code it costs.

### 7.3 The echo moment

Deterministic client-side policy in `useConversation` (the server is stateless). Offer on the **first eligible reply once ≥4 turns have passed since the last offer, max 3 per session** — a `turnIndex % 5` modulus would silently cost five turns whenever the reply is the wrong length. Inline button on the last coach bubble; never a modal, never during `speaking`/`thinking`.

Renders stress dots (D): target row vs your row, mismatches ringed with an `×` glyph — **size + fill, two channels, never a colour swap**. Ledger write identical to the Gym.

### 7.4 Free conversation

The pause profile accumulates **every turn, silently**. Rendered at most **once per 3 turns**, only when the turn had ≥3 detected pauses — one plain sentence, no chart, no number. *"Move the breath to the comma"* is a tomorrow instruction, not a 3-seconds-from-now one. It surfaces properly at **end of session**, as the reason tomorrow starts where it does:

> *"You broke mid-phrase 11 times today. Tomorrow starts with chunking."*

---

## 8. Visualisation & accessibility

**Word granularity by default**, syllable only where alignment confidence allows. The closest prior art is word-level throughout, and syllable-level displays have no evidence behind them — they are only as truthful as the aligner on accented speech.

| | Pattern | Accessible equivalent |
|---|---|---|
| **B** | **Duration ribbon** (Gym). Two tracks, one time axis. Each **word** a rounded rect: width = measured duration. Constant rect height — vertical space is the *track* dimension. Stress = fill-lightness step **plus a 3 px tick**. **Never encode stress as height** (learners read taller as louder). `centralisationDistance` never touches fill | `role="img"` + generated `aria-label`; visually-hidden `<table>`: word / target / yours / stress. Position + size survive greyscale |
| **C** | **Beat karaoke** (Gym model step). Words light in time; the metronome pulses on stressed beats only | Under reduce: no playhead, no tweens, discrete step. The `da-DA` notation + bolded sentence carry the step alone |
| **D** | **Stress dots** (echo moment). Big filled = stressed, small hollow = unstressed; two rows, mismatches ringed | *"Target rhythm: da-DA-da-da-DA. Yours: da-da-DA-da-DA. Two words differ: 'the' and 'money'."* |
| **V3** | **Delexicalised hum** — strip words, keep the tune, A/B in `<audio controls>`. **Built browser-side**, not in the sidecar: phase-accumulate an `OscillatorNode` over the F0 series, gate by voicing, render in an `OfflineAudioContext` | **The only non-visual channel.** Building it in numpy inside the container would kill it exactly when degrade-never-break needs it |

**Rejected outright:** raw F0 contours (*"may be interpreted by students as a requirement to match the model precisely — a task at which they are bound to fail"*) · spectrograms · ToBI · musical notation · **red/amber/green as the sole encoding** (WCAG 1.4.1, and a colour says you were wrong, not which way to move) · animated pitch draw-on · waveform-as-rhythm · prosody-modulated typography (no accessible equivalent, degrades dyslexic readability) · live expressiveness meter (n=14, tone-language L1).

### 8.1 aria-live budget

The existing `VoiceStatus` renders a persistent `aria-live="polite"` region in the footer, **and aria-live is inherited by descendants**. Therefore: **exactly one polite announcement per completed scoring**, carrying the imperative sentence; replace the text node, never append. **No rAF- or word-rate value ever enters a live region.** No pronunciation visual renders inside that subtree. During scoring, use `aria-busy` with a static label.

### 8.2 Reduced motion

CSS cannot stop the karaoke loop — it is rAF/`currentTime`-driven, and the existing reduced-motion block only sets `animation: none` on three named classes. Add a `useReducedMotion` hook over `matchMedia`, **guarded** (`typeof window.matchMedia === "function"`) — jsdom does not implement it, and an unguarded call crashes every test that renders the component. No user-facing toggle.

### 8.3 Keyboard

Ribbon and stress dots are **non-interactive** — no tabindex, no roving focus. The full keyboard surface is: play, play-slow, the `<audio controls>` hum, the numeric disclosure, record, strictness. One exception: the horizontal-scroll wrapper needs `tabindex="0"` + `aria-label` (no role) so keyboard users can scroll it.

### 8.4 The imperative sentence

Deterministic templates only — **never an LLM**, which would invent numbers it was not given. Generate **once** in `client/src/lib/prosody/labels.js` and reuse the identical string in three places: the visible `<figcaption>` (before the SVG in DOM order), the single live-region announcement, and the summary clause of the SVG's `aria-label`. Gym copy lives in `server/src/pronunciation/copy.js`, **not** in `prompts/`, so nobody pipes acoustic numbers into the brain.

---

## 9. Data & persistence

Slice 2 creates the persistence layer that does not exist today: `server/src/db.js`, and a split of `app.js` (exports the app) from `index.js` (listens) — the current module calls `app.listen()` at module scope with no export, so importing it in a test binds port 3001.

### 9.1 Schema additions

```prisma
model GymAttempt {
  id              String   @id @default(cuid())
  createdAt       DateTime @default(now())
  turnId          String?          // null for Gym attempts
  unitId          String?
  mode            String           // "gym" | "echo"
  source          String           // "local" | "none"
  provider        String
  captureSettings Json
  audioDurationMs Int
  metrics         Json?            // null ⇒ unscored
  detail          Json?
}
```

- **Persist the row *before* calling the sidecar.** `metrics IS NULL` ⇒ unscored. **No `status` enum** (derivable, will drift). **No `captureKey` column** — derive at read time.
- **Do not promote uncalibrated floats into DDL.** ~10 real columns plus one `metrics` JSON; promote a field the first time a query is measurably slow. Every band in this spec is a placeholder to be re-derived; each change would otherwise be a migration.
- **Tracks and audio on disk:** `server/.data/pron/<attemptId>/`. An F0 track at 128-hop/48 kHz is ~375 floats/sec — it does not belong in SQLite.
- **`ErrorLedger` gains two columns:** `nextDrillAt DateTime?`, `drillCount Int @default(0)`. **No third parallel ledger** — `type` already enumerates `"pronunciation"`.
- `VocabItem.nextReviewAt` (SM-2) is untouched — that is M4's, and unwritten.

### 9.2 Audio retention

**Keep everything. No TTL, no pruning.** ~160 KB/attempt × ~20 attempts/week ≈ 3 MB/week. These recordings are the **only repo-legal fixture source** for K3 and any future re-derivation — EpaDB is CC BY-NC-ND and can never be committed. Add `server/.data/` to `.gitignore`. One `DELETE /pron/media` button with a folder-size readout. Revisit at 1 GB.

### 9.3 XP

**Flat rate, never scaled by a score.** 15 XP per completed scored attempt, +10 when a *binary* check passed (`nuclearHit === true`, or minimal-pair `'correct'`), 0 when the sidecar was down. Computed server-side in `server/src/pronunciation/scoring.js`. The existing `basicXp()` stays byte-identical, and the existing `Turn.fluency`/`Turn.confidence` Ints are untouched — M7's floats live in `GymAttempt.metrics`.

A reward curve built on a number this spec itself calls untrustworthy would train the learner to optimise noise.

---

## 10. Privacy

Two booleans, not one:

- **`audioLeftBrowser`** — true whenever audio is POSTed anywhere.
- **`audioLeftDevice`** — must be **architecturally enforced**, not asserted.

Enforcement is **no outbound network on the sidecar container**: a compose network marked `internal: true`, with the acoustic model and the 199,858-word dictionary baked at image build time. Loopback binding is a LAN control, not a browser-reachability control — the browser is on the same host and `fetch('http://127.0.0.1:…')` works fine either way.

Free conversation retains **no raw audio at all**.

---

## 11. Licensing & attribution

`english_us_arpa` is **CC BY 4.0** and requires attribution. The repo has no `NOTICE` file and no about screen. Create **`THIRD-PARTY-NOTICES.md`** at the repo root, linked from the README, listing MFA (MIT), `english_us_arpa` (CC BY 4.0), `pitchy` (MIT, vendored — keep its licence header in the vendored file), and `wikipron` (Apache-2.0) if minimal pairs ship.

`ProviderId` keeps `'azure'` as a string nobody sets. **Zero adapter rules are implemented.** What is borrowed is the *field naming*, which is the actual value: shape compatibility if a cloud provider is ever wanted.

---

## 12. Testing

**Runner:** Vitest with `environment: "node"` on the server — one expect API for a solo developer. Blocked until the `app.js`/`index.js` split lands.

**Three layers for the browser DSP** (jsdom has no Web Audio):

1. **Pure functions** over `Float32Array` in `client/src/lib/prosody/*.js` — plain Vitest, no mocks.
2. **The processor directly**, by stubbing exactly four globals (`AudioWorkletProcessor`, `registerProcessor`, `sampleRate`, `currentTime`) and driving `process()` in 128-sample quanta. Do **not** reach for `standardized-audio-context-mock` — its `AudioWorkletNodeMock` is a literal `// @todo` empty stub.
3. **One `OfflineAudioContext` check** for the Vite dev/prod worklet divergence, run locally through the Browser pane. **No Playwright** — 150 MB for one assertion.

**Proving DSP ported from prose** (the reference scripts are GPL, so there are no golden values): **constructed inputs with closed-form answers**, generated in the test, zero bytes in git.

- Pause detector: 1.0 s tone / exactly 0.40 s silence / 1.0 s tone → exactly one pause of 380–420 ms; narrow to 0.24 s → zero pauses.
- F0: 220 Hz sawtooth → 220 ±1 Hz, clarity > 0.9; white noise → clarity < 0.5.
- Nuclei: AM tone with N known bursts → N nuclei; one 3 dB dip → the dip rule fires. **Gain invariance (×0.5) on the nuclei detector only.**
- **Skip** time-reversal (SD and mean are permutation-invariant — vacuous) and **skip** pinning uncalibrated constants (a test whose expected outcome is "edit both sides" trains you to silence red). Put the citation in a comment.

**Isolation:** hard rule — **`useConversation.js` never imports a Web Audio module.** All capture behind `micStream.js`, added as a third `vi.mock` in the same commit. Web Audio stubs live in `micStream.test.js` via local `vi.stubGlobal`, not in `setup.js`, and use `Object.defineProperty(navigator, "mediaDevices", …)` since `navigator` is a getter.

**Coverage gate:** the client config is a **two-file allowlist** with an 80% four-way threshold — DSP added outside it would ship at 0% while CI reports PASS. Extend `include` to cover `micStream.js` and `prosody/**`, exclude `*.worklet.js`. Vitest's `coverage.all` defaults true, so **the glob edit and the first prosody test must land in the same commit** or the build goes red.

**`createRecognizer` signature:** add an optional `track = null` defaulting to today's behaviour so the 7 existing call sites are untouched; `track ? rec.start(track) : rec.start()`. Assert the shape, not just identity.

**a11y:** the existing suite covers 3 of 5 components — add `StatHeader` and every new SVG.

**CI: none.** One developer, one machine, no PR flow. Add the missing root `"test": "npm --prefix client test && npm --prefix server test"` and a `pre-push` hook. Gate Docker-dependent tests with `describe.skipIf(!process.env.PRON_SIDECAR_URL)` so they skip, never fail.

---

## 13. Spikes (Phase 0 — zero product code)

Each has its descope clause written **in advance**, so the decision is arithmetic rather than a negotiation.

| | What | Time | If it fails |
|---|---|---|---|
| **K2** | **Windows audio.** Constraints nested under `audio:{}`; read back `getSettings()`; record a fixed-amplitude tone at two distances and check the RMS ratio is preserved. **Run twice** — recognizer stopped, then active — and compare. (A `getSettings()` diff is structurally blind: Voice Focus sits below the browser, where Chrome can neither detect nor disable it.) Add the first-run instruction to disable Voice Focus and **record whether it was done** | 45 min | Energy-derived quantities go relative-only; M4's prominence drops the intensity term and runs on duration + F0; the pause floor stays adaptive. **Nothing descopes** |
| **K1** | **MFA in WSL2.** Boot the pinned `v3.3.9` image. Time `align_one` cold as a subprocess, then warm in a persistent process. Land the fixes: `--temporary_directory` on tmpfs, `/mfa` on a **named volume** (never a Windows bind mount), PostgreSQL from the entrypoint or `mfa configure --disable_auto_server` with SQLite verified. *(The official Dockerfile starts PG only from `~/.bashrc`, which a FastAPI ENTRYPOINT never sources.)* | 1 day, timeboxed | **No phone tier at all ⇒ M7 ships browser-only** (slices 1–2); Gym, echo scoring and all alignment-derived metrics move to M8, in writing. **Latency alone descopes nothing** — it only picks cold-subprocess vs warm-worker |
| **K3** | **Alignment quality on the learner's own voice.** (a) 5 utterances × ~8 vowel boundaries hand-checked in Praat with MFA's TextGrid **pre-loaded** (nudge, don't segment from scratch); report the **signed mean Δ**, not \|Δ\|. (b) Test-retest: 5 sentences × 5 reads, same mic, same `captureSettings`; within-sentence SD of the M3 ratio | 1.5 h | Signed bias large relative to the 50–100 ms difference M3 claims to measure ⇒ **M4 does not ship** and M3 ships as a trend line **with no verdict**. Same if the SD exceeds a third of the smallest change worth calling improvement |
| **K4** | **Minimal-pair forced choice.** Record deliberate productions of both sides of 5 pairs (ship/sheep, vet/bet, zoo/Sue, bad/bed, jet/yet). Confirm the aligner separates them and that a margin threshold yields `'unclear'` | 1 h | **Minimal pairs cut from v1 entirely.** `pron:seg:` unused, BLOCKER contrast drills deferred to M8. **Nothing else is touched** |

**Why K3 is not optional:** MFA's error is *correlated with the learner error being detected*. A systematically biased aligner is perfectly repeatable, so test-retest alone is blind to it — and as the learner improves, the bias shrinks, moving the trend line for a reason that isn't them.

---

## 14. Build order

| # | Ships | Proves | Gate to start the next |
|---|---|---|---|
| **1** | `micStream.js` + AudioWorklet + pause profile, one sentence under the learner's bubble. **No sidecar, no Docker, no Prisma** | The clock/anchor design and the endpoint-anchored placement classifier; StrictMode-safe capture | Worklet emits in **both** `vite dev` and `vite build`; all 40 hook tests green with the third `vi.mock`; `coverage.include` extended in the same commit; a test asserts the worklet ring is **not** reset by a recognizer restart |
| **2** | Persistence spine: `db.js`, `app.js`/`index.js` split, Vitest on the server, root `test` script, `Session`/`Turn` written for the first time | That Prisma works and the server is testable | `npm test` at root runs both suites; a conversation writes a `Session` and its `Turn`s |
| **3** | Sidecar walking skeleton: Docker image, `/pron/score` returning a phone tier for one hardcoded WAV, the `pronunciation/` factory with `none` first-class, multipart transport, `/pron` proxy line. No metrics, no UI | The transport contract and the degrade path end-to-end | A phone tier round-trips; killing the container yields `{scored:false, reason:'scorer-offline'}` and the UI stays alive |
| **4** | **Gym v0.** View toggle, 6 hardcoded units, model → record → ribbon + imperative sentence + hum A/B → unlimited re-attempt with ghost track. `GymAttempt` persisted | The milestone's actual promise, in an isolated screen with zero conversation-state-machine risk. **K3's test-retest runs here on real audio** | The M3 ratio's within-sentence SD across 5 reads clears K3's threshold. If not, the ribbon ships without a verdict and work stops to recalibrate |
| **5** | Ledger + spacing: `ErrorLedger` writes, the `nextDrillAt` ladder, the 6-item daily set | That the loop has memory — what makes it teaching rather than measuring | A Monday failure reappears Tuesday; a clean pass doesn't |
| **6** | Beat karaoke (C) + `useReducedMotion` | Presentation only, on a step that already works | Both `prefers-reduced-motion` branches asserted; `StatHeader` + the new SVG in the a11y suite |
| **7** | Echo moment: the `"echo"` status member, `useEchoMoment`, stress dots (D), the offer policy | The bridge from Gym to conversation; reuses slice 4's scoring path unchanged | An echo attempt never appears in `messages` and never reaches the history window; Skip works from `interrupt()` |
| **8** | Minimal pairs — **only if K4 passed** | The one categorical claim in the system | — |

Slices 1–2 need **no Docker at all**. The riskiest dependency is discovered before the schema, the curriculum and the visualisations are committed to it. Minimal pairs go last because they are the only component whose failure costs nothing already shipped.

**One-line drive-by, slice 1:** patch the coach system prompt from *"Spanish-speaking adult (level B1–B2)"* to C1–C2. Shipping a C1–C2 prosody engine behind a B1–B2 coach is a contradiction audible every turn.

---

## 15. Cut from v1

`pyworld` and the whole sidecar F0 path · the Azure adapter and its 10 rules · `overall.*`, `scaleMappings.cefr`, the composite PronScore · `centralisationDistance` and the spectral channel · a separate enrollment session (**the 6 PROBE sentences read on day one *are* the baseline**) · a third parallel ledger · SM-2 and any shared scheduling module · 28 denormalised metric columns · audio TTL, prune-on-write, backfill queues, retry jobs, `schemaVersion` migration tests · 2AFC perception tests, backchaining, tapping, shadowing-as-input · mandatory 3-attempt blocks · GitHub Actions, Playwright, `supertest` · a `contrastRatio()` module (compute the two ratios by hand once, write the number in a comment) · hand-written JSON fixture files (one `makeResult(overrides)` factory instead) · V4 typography and V5 meter · `MediaRecorder` and `client/src/lib/audio.js`, **deleted**.

---

## 16. What can honestly be claimed

Verbatim, in the README when this ships:

> This milestone can demonstrate improvement on drilled sentences. It cannot yet demonstrate transfer to free conversation. Clause-internal pause rate per 100 words is the one number that would begin to show it.

Two weekly numbers, both within-learner, both plotted. Everything else is instrumentation.

1. **Clause-internal pause rate per 100 words** of free conversation — never per turn.
2. **The 6 PROBE sentences**, re-read weekly, for the M5 VarcoV trend.

### Evidence honesty

The evidence base is thin and **none of it is Peninsular Spanish**. VarcoV's within-Spanish result is one 2007 study, n=30, ~19% of variance. The nuclear-stress figure is n=15 on a single poem-reading task. The Peninsular /θ/, [x] and /dʒ/ adjustments are **inference, not measurement** — there is no Peninsular equivalent of EpaDB. No visualisation in this space has been evaluated with Spanish-L1 learners.

Therefore: **every threshold is a named constant marked `UNCALIBRATED`**, feedback tolerance defaults to **lenient** (with the strict toggle exposed from day one, to be flipped once K3 lands), and nothing is framed as distance from a native speaker.

### C1–C2 caveat

Most L2 prosody literature samples broad proficiency ranges. At C1–C2 the learner is already near ceiling on lexical stress and inside the rate band, where published relationships discriminate least. Expect metrics that separate B1 from C1 to be near-useless for C1 vs C2 — which is why the curriculum is weighted toward **nuclear-stress placement, deaccenting of given information, and function-word weak forms** rather than toward the metrics with the best published effect sizes.

---

### 14.1 Plan decomposition

This spec is one milestone but **more than one implementation plan**. The first plan covers **Phase 0 (K2, K1) + slices 1–3** — through the walking skeleton, ending at a proven transport contract and a proven degrade path. Slices 4–8 get a second plan written *after* K1 and K3 have resolved, because their content depends on those outcomes: if K1 fails, slices 3–8 do not exist; if K3 fails, slice 4 ships without a verdict and slices 5–7 change shape.

Writing one plan for all eight slices now would be writing fiction for the second half of it.

---

## 17. Deferred to the implementation plan

- M4's prominence estimator: exact weights, normalisation, tie-break and abstain condition.
- `alignmentConfidence`: what quantity it is computed from, and the two cut-offs for syllable→word→nothing.
- Minimal-pair `margin`: calibration procedure and the two thresholds separating `borderline` from `unclear`.
- Browser F0 configuration: voiced/unvoiced clarity cut-off, Hz search range, post-filter, and behaviour when >X% of frames are unvoiced.
- The `captureSettings` subset that forms the comparability key, and what the UI does when it changes mid-history.
- The deterministic template table for the imperative sentence.
