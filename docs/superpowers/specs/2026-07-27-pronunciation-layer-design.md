# Pronunciation Layer (CAPT) — Design Spec

- **Date:** 2026-07-27 (amended 2026-07-28, see §12)
- **Status:** Approved (design), implementation in progress
- **Owner:** SpeakUp (C:\talker)
- **Milestone:** M7 — Pronunciation (CAPT)
- **Relates:** builds the server-side audio route that M6 (offline Whisper) also needs; feeds `ErrorLedger.type = "pronunciation"` once M3 lands

## 1. Context

SpeakUp's conversational loop is **text-only end to end**. The learner's voice never leaves the browser:

```
useConversation → Web Speech STT → text → POST /turn → brain → TTS
```

The Web Speech API is accent-forgiving and grammar-flattening *by design* — it is optimized to guess what you meant. That property is useful for keeping a conversation flowing and fatal for pronunciation work: **the recognizer erases exactly the signal being graded**. Real pronunciation feedback therefore requires a second data path that carries raw audio to a scorer, and that scorer must compare against a reference the coach controls — never against the ASR's guess.

This milestone is being pulled ahead of M2 (grammar) at the user's request.

### Current state (verified in code)

**Already present and reusable:**
- `POST /turn/audio` — multipart, 15 MB cap, `501` unless `STT_PROVIDER` is set (`server/src/routes/turn.js:80`)
- `server/src/stt/` — pluggable factory, `voicebox` (Whisper) adapter, dormant
- `client/src/lib/audio.js` and `postTurnAudio()` in `client/src/lib/api.js`
- `ErrorLedger.type` already admits `pronunciation` in `server/prisma/schema.prisma`
- Established plugin idiom: `brain/`, `tts/`, `stt/` are all `getX()` factories keyed off an env var, reported by `GET /health`

**Missing:**
- Client-side audio capture orchestration — the Ruta B wiring (`useServerSTT`, `startListeningServer`, `handleAudioTurn`) was **removed** in M1.5 and must be revived
- Any scoring engine, any phoneme representation, any drill content
- **A server test runner** — `server/package.json` has no test deps or scripts; all 93 existing tests are client-side

### Cost research (2026-07-27) — why the engine is local

Billing is on *audio duration submitted*, not session time. At the user's stated ceiling of 7 h/day × 30 days = 210 h/month wall clock, a 25–35 % speaking duty cycle yields **~50–75 audio hours/month**.

| Engine | Billing unit | 1,000 drill utterances (6 s) | $ / audio-hour of real speech |
|---|---|---:|---:|
| **Local sidecar** | compute | **~$0** | **~$0** |
| Azure REST short-audio ≤60 s | per second, ~$0.66/h | $1.10 | $0.66 |
| Azure + prosody add-on | +~$0.30/h/feature | $1.60 | $0.96 |
| Azure real-time | ~$1.32/h | $2.20 | $1.32 |
| SpeechSuper scripted (sentence) | per request | $6.00 | $3.60 |
| SpeechAce Basic/Pro overage | **15-second blocks** | $8.00 | $4.80 |
| SpeechAce Premium overage | 15-second blocks | $12.50 | $7.50 |
| SpeechSuper unscripted | per request | $30.00 | — (per turn) |
| ELSA | **no published price** | ? | ? |

Two findings drove the decision:

1. **SpeechAce bills in 15-second minimum blocks.** A 6-second drill utterance pays for 15 and discards 60 %. That makes it ~7× Azure's short-audio rate *specifically in the chosen use case* — a billing-unit artifact, not a quality difference.
2. **Monthly totals at the stated ceiling:** scripted-only runs ~$9–86/month on cloud; the full hybrid runs **~$95–440/month**, i.e. $1.1k–$5.3k/year. Local runs $0 in both.

The cost objection to the hybrid model exists *only if the engine is cloud*. Choosing a local engine is what makes the hybrid affordable. ELSA's refusal to publish a rate disqualifies it from a project whose second principle is "$0 by default".

Rates vary by region and were read from vendor pages on 2026-07-27; Azure's own pricing page renders figures client-side, so its numbers come from Microsoft's Q&A and a third-party review and should be treated as estimates.

## 2. Goal & Non-Goals

### Goal

Give the coach the ability to hear *how* the learner says something, not just what they said — via a local, $0, private scoring engine behind a pluggable slot, surfaced as a scripted read-aloud drill, with an offline calibration harness that makes the scores defensible.

### Non-Goals (explicitly deferred)

- **Persistence.** Scores live in client state and die on reload. M3 remains the single decision point for writing to the DB.
- **Ledger-derived drill content.** Requires M3/M4 data that does not exist yet.
- **Cloud as a runtime path.** The Azure adapter exists to calibrate, never to serve a turn.
- **Phoneme scores in unscripted mode.** See §3.
- **Real-time / streaming scoring.** Utterance-at-a-time only.
- **Non-English targets.** The phoneme inventory and drill set are English-only.

## 3. The governing constraint

> **Scripted mode shows phonemes. Unscripted mode never does.**

Without a trustworthy reference text, a per-phoneme score is a fabricated number with decimal places. In free conversation the only available reference is the ASR hypothesis — which, per §1, has already silently repaired part of what was said. Scoring phonemes against it compounds the ASR's errors and reports them as the learner's.

So Stage 2 reports only metrics that do not depend on knowing which words were intended: speech rate, articulation rate, pause count and duration, F0 range. The per-phoneme output is **discarded server-side** and never reaches the client.

## 4. Architecture

```
                 ┌─ POST /turn ─────────────► brain ──► tts        (untouched)
client ──────────┤
                 └─ POST /pron/assess ──────► pron/ ──► sidecar :8899
                    multipart { audio, text }             │
                                                          └─ ffmpeg → wav2vec2 → G2P → forced align → GOP
```

### 4.1 Server slot

Mirrors `brain/`, `tts/`, `stt/` exactly.

```
server/src/pron/
  index.js      getPron() · PRON_PROVIDER · currentPronProvider()
  contract.js   PronunciationReport shape + input validation
  mock.js       deterministic pseudo-scores hashed from the reference text
  local.js      HTTP client for the sidecar
  azure.js      calibration adapter (not a runtime path)
server/src/routes/pron.js
  POST /pron/assess    multipart { audio, text, mode } → PronunciationReport
  GET  /pron/prompts   ?focus=<phoneme> → curated sentence set
```

`mode` is `"scripted"` (default) or `"unscripted"`. It is the switch that enforces §3: in
`unscripted` the route strips `words[].phones` from the report before responding. `text` is
required in both modes — in `unscripted` the caller passes the ASR hypothesis.

`focus` is optional on `/pron/prompts`; omitted, it returns the full set.

`GET /health` gains a `pron` field so the UI pill row reports it like every other provider.

### Configuration (`server/.env`)

```
# --- Pronunciation (CAPT) ---
# local  -> score via the sidecar container
# mock   -> deterministic offline pseudo-scores, $0  (code default, per §7)
# azure  -> calibration reference only; never the runtime path
PRON_PROVIDER=mock
PRON_URL=http://localhost:8899
PRON_MODEL=facebook/wav2vec2-lv-60-espeak-cv-ft
# AZURE_SPEECH_KEY=          (calibration runs only)
# AZURE_SPEECH_REGION=
```

The code default is `mock`, not `local`, so `npm run dev` works with no Docker running. See
amendment **A6** in §12.

**Why the server serves the prompts** rather than bundling them in the client: when M3/M4 exist, drill content becomes ledger-derived with no client change. The endpoint shape already allows it; today's implementation just reads a versioned JSON file.

### 4.2 The sidecar

Its own container, same ergonomics as Kokoro (`docker run -p 8899:8899`). Ships **ffmpeg**, so it accepts the webm/opus that `MediaRecorder` produces and transcodes to 16 kHz mono PCM itself. The Node server never touches audio bytes beyond forwarding them.

| Step | Operation | Tooling |
|---|---|---|
| 1. G2P | reference text → expected IPA sequence | `phonemizer` + espeak-ng (emits IPA directly); CMUdict supplies lexical stress |
| 2. Acoustic | audio → frame × phoneme posterior matrix | wav2vec2 phoneme CTC |
| 3. Forced alignment | align the *expected* sequence against the posteriors → per-phoneme boundaries | CTC forced alignment |
| 4. GOP | per phoneme: `log p(expected) − log max p(any)`, normalized to 0–100 | — |
| 5. Aggregation | phoneme → syllable → word → sentence | — |

**The runtime model is `facebook/wav2vec2-lv-60-espeak-cv-ft`** (392-token espeak IPA vocabulary,
Apache-2.0). The model id stays an env var, but the default is now fixed on a **phoneme-inventory**
criterion rather than a corpus one.

The two candidates this spec originally named were both disqualified by inspecting their actual
tokenizer vocabularies — see amendments **A1** and **A2** in §12. The short version: a model cannot
teach a contrast its vocabulary cannot name, and the originally-proposed default could not emit
`ə`, `iː`, or `dʒ` — three of the seven drill targets in §5, including the ship/sheep contrast used
as the worked example in §4.3.

Corpus relevance still matters, but it is a **calibration** question (§8), not a selection gate:
§8's harness measures correlation with human judgment and may still recommend a fine-tune.

### 4.3 Report contract

```json
{
  "overall": { "accuracy": 78, "fluency": 84, "completeness": 100 },
  "words": [
    {
      "word": "sheep", "start": 0.42, "end": 0.81, "accuracy": 41,
      "phones": [
        { "ipa": "ʃ",  "score": 88, "start": 0.42, "end": 0.50 },
        { "ipa": "iː", "score": 31, "start": 0.50, "end": 0.72, "substituted": "ɪ" },
        { "ipa": "p",  "score": 79, "start": 0.72, "end": 0.81 }
      ]
    }
  ]
}
```

Score semantics, all 0–100:

- `accuracy` — GOP-derived, how close the realized phonemes are to the expected ones
- `fluency` — derived from the alignment: pause count and duration, articulation rate
- `completeness` — proportion of expected words actually detected in the audio; catches skipped
  or swallowed words, which a per-phoneme average would otherwise hide

`substituted` is present only when the aligner's best-matching alternative outranks the expected
phoneme; it is absent, not null, when the phoneme was produced as expected.

The pedagogically load-bearing field is `substituted`, not `score`. It turns "you got it wrong" into *"you said **ɪ** where **iː** was expected"* — the ship/sheep merge, which is the canonical L1-Spanish error.

### 4.4 Client

```
client/src/
  hooks/usePronunciationDrill.js    prompt → recording → scoring → result
  lib/recorder.js                   MediaRecorder wrapper (revives the Ruta B primitive)
  lib/api.js                        + postPronAssess(), getPronPrompts()
  components/DrillCard.jsx          reference sentence + mic
  components/PhonemeScore.jsx       per-word / per-phoneme rendering
  components/DrillResult.jsx        the actionable errors
```

`useConversation.js` is **not modified**. Its state machine (`idle→listening→review→thinking→speaking→idle`) has a review/edit step and a brain call; the drill has neither. Grafting a second, differently-shaped loop into the client's most critical file would damage both. The drill gets its own machine: `prompt→recording→scoring→result`.

## 5. Drill content

A curated, versioned JSON set, grouped by the phoneme it targets, biased toward documented L1-Spanish failure points:

| Target | Contrast | Example |
|---|---|---|
| /ɪ/ vs /iː/ | vowel length + quality | ship / sheep |
| /æ/ | absent in Spanish | bat / bet |
| /ə/ | schwa reduction in unstressed syllables | `comfortable` |
| /v/ vs /b/ | phonemic in English, allophonic in Spanish | vote / boat |
| /dʒ/ | — | job, judge |
| word-initial s- clusters | Spanish epenthesis | spain → *espain* |
| final -ed | /t/ /d/ /ɪd/ allomorphy | walked, played, wanted |

Deterministic, testable against a fixed set, $0, and functional with no brain configured.

## 6. Presentation rule

**At most 3 errors per attempt, ranked by intelligibility impact — not by score deviation.**

A phoneme error that changes meaning (*ship/sheep*, *bat/bet*) outranks one that merely sounds foreign (a slightly dental /t/). This follows directly from the C1–C2 target: at that level the measure is whether you are understood and whether stress lands correctly, not whether the accent is erased. A scorer that surfaces twenty deviations sorted by magnitude produces noise and discouragement in equal parts.

## 7. Degradation (principle #3: degrade, never break)

| Failure | Behavior |
|---|---|
| Sidecar down | `/pron/assess` returns a typed error → the drill continues as **listen-and-repeat**: Kokoro synthesizes the model sentence, the learner repeats, no score. Still pedagogically useful. |
| No microphone | Drill disabled with an explicit reason. It cannot fall back to the text input — there is no audio to score. |
| `PRON_PROVIDER` unset | `mock` — offline, $0, deterministic |
| Brain unavailable | Irrelevant. The drill never calls the brain. |

## 8. Testing & calibration

- **Server:** add **Vitest** — same runner and idiom as the client, in preference to `node:test`, to avoid two test runners in one repo. Covers the factory, the `mock` provider, the route contract, and the degradation path.
- **Sidecar:** pytest over G2P and the GOP arithmetic, with golden audio fixtures.
- **Client:** Vitest + RTL over the drill state machine, at the same rigor as the voice loop — the failure modes are again timing-shaped (recorder start/stop races, unmount during scoring).
- **Calibration harness:** `tools/calibration/` runs the local scorer against **speechocean762** (5,000 non-native English utterances scored by five human raters) and reports Pearson and Spearman correlation with human judgment at utterance and phoneme level.

The calibration harness is the deliverable that makes the numbers defensible, and it is what selects the acoustic model. Shipping scores without it means shipping decorative digits.

## 9. Stage 2 — unscripted

Built on the same sidecar and the same route, called with `mode: "unscripted"` and the ASR
hypothesis as `text`. Per §3, `words[].phones` is stripped server-side before the response is
written — the client is never in a position to render it. Surfaced as a post-turn stat strip in the conversation view — speech rate, articulation rate, pause count and duration, F0 range — presented as observation, not correction.

Sequenced after Stage 1 not for cost reasons (local is $0 either way) but for implementation risk: forced alignment and prosodic analysis are different problems, and building them together means a failure gives no signal about which one broke.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Neither candidate model is trained on L1-Spanish speakers | §8's harness measures it before the score is trusted; the model id is an env var so swapping is a config change |
| GOP scores correlate poorly with human judgment | Same harness. If correlation is weak, the honest fallback is to report substitutions (`substituted`) without a numeric score — still actionable, no false precision |
| Sidecar adds a Python runtime + ~2 GB model to a Node repo | Contained in Docker, same operational shape as Kokoro, which the project already requires for good TTS |
| Reviving `MediaRecorder` re-introduces the M1.5 Ruta B bugs | The primitive is rebuilt in an isolated `lib/recorder.js` with its own tests, not restored from the removed orchestration |
| 7 h/day is not a sustainable usage pattern | Treated as a design ceiling, not a steady state. Sustained intensive practice is realistically 45–90 min/day; local incurs no penalty for over-provisioning |

## 11. Repo-specific implementation note

This repo has a documented history of **concurrent untracked WIP contaminating commits** (M1.5 shipped an import of an untracked file despite tests passing moments earlier). Verify **staged** content with `git show :<path>` — not just the working tree — before every commit in this milestone.

## 12. Amendments after verification (2026-07-27)

The design above was approved on the strength of desk research. Before writing the implementation
plan, the library APIs and model vocabularies were **verified by execution** — vocab files pulled
from HuggingFace, `forced_align` run across four torchaudio versions, a real webm decoded, espeak-ng
invoked. That pass invalidated several approved decisions. They are recorded here rather than
silently rewritten, so the reasoning stays auditable.

| # | Approved text said | Corrected to | Why |
|---|---|---|---|
| **A1** | Default model `mrrubino/wav2vec2-large-xlsr-53-l2-arctic-phoneme` | `facebook/wav2vec2-lv-60-espeak-cv-ft` | mrrubino's vocabulary is **40 tokens** and contains no `ə`, no `ː`/`iː`, no `dʒ`. It cannot represent 3 of the 7 §5 drill targets, including the ship/sheep contrast this spec uses as its worked example. facebook's is the full 392-token espeak IPA inventory. Both Apache-2.0. |
| **A2** | slplab model listed as an IPA candidate | Removed from every runtime path; permitted only as a comparison row in `tools/calibration/` | Emits **ARPAbet** with `_err` tags, not IPA (91 tokens), and declares **no licence**. |
| **A3** | `torchaudio.pipelines.MMS_FA` implied for alignment | Not used. Alignment runs on the phoneme model's own log-probs. | MMS_FA is character-level, and **CC-BY-NC** — a non-commercial licence in a project with no licence decided yet (README: "License: TBD"). |
| **A4** | §4.3 implied phone `start`/`end` come straight from alignment | A deterministic blank-attribution expansion pass (`expand_spans()`) | Verified by execution: raw CTC spans are ~1 frame (20 ms) and cover only ~9 % of frames. Reporting them as durations would be wrong. |
| **A5** | §4.4 derives `fluency` from the alignment | `fluency` comes from a separate energy-VAD pass over the decoded PCM | The alignment carries no pause information at all. This was a factual error in the approved design. |
| **A6** | §4.1 sample config shipped `PRON_PROVIDER=local` | Code default is `mock`; `.env.example` ships `mock` | §4.1 contradicted §7 ("PRON_PROVIDER unset → mock"). §7 wins: `npm run dev` must work with no Docker. |
| **A7** | §4.3 report contract | Gains a required `prosody` object and `pronProvider`/`mode`/`model` envelope fields | Stage 2 (§9) needs prosody, and it must exist in the schema from the start so it is not invented ad hoc later. |
| **A8** | §6 ranking rule, location unstated | Ranking lives client-side in `client/src/lib/pronErrors.js`; the server report is unranked and complete | Presentation rule belongs in the presentation layer, and it keeps the raw report reusable by M3/M4. |
| **A9** | (not addressed) | `server/src/app.js` is new, exporting `createApp()`; `server/src/index.js` becomes a bootstrap | `server/src/index.js` calls `app.listen` at import time and exports nothing, which makes the §8 route-contract tests impossible to write. |

**Verification debt:** the four adversarial critic passes planned for the implementation plan
(placeholders, interface drift, spec coverage, TDD quality) **did not run** — the API returned
`529 Overloaded` on two consecutive attempts. The plan carries a self-review only. Re-running the
adversarial pass is outstanding work, tracked in the plan documents.

## 13. Amendment: Azure as a budget-capped runtime supplement (2026-07-28)

§0 and §4.1 stated Azure is "never a runtime path... only a calibration reference." That is
**reversed for the specific case below**, at the user's request, after real-world cost math the
original design under-weighted for genuinely intensive daily use.

### 13.1 Why

The user asked for **6–7 h/day, 30 days/month** of practice, with the whole SpeakUp kit (brain +
TTS + pronunciation) under **$20/month total**, and — independently — for the local sidecar to
never interfere with using the machine for work while it runs.

Re-running §1's cost table at that volume, using the same 25–35 % speaking-duty-cycle assumption
already in this spec (yielding 50–75 audio-hours/month):

| Engine | Cost at 50–75 audio-h/month |
|---|---:|
| Azure short-audio ($0.66/h) | $33 – $50 |
| Azure real-time ($1.32/h) | $66 – $99 |
| SpeechSuper (scripted, per-sentence) | ~$36+ |
| SpeechAce (15-second billing blocks) | $190 – $440 |
| **Local (sidecar)** | **$0** |

**No cloud vendor is affordable as the primary engine at this volume.** Per-unit billing (per
second, per request, per 15-second block) scales with practice volume by construction; the
project's own hardware does not. This reconfirms §1's original local-first argument, it does not
overturn it — Azure remains **unfit as the default or primary engine**.

On the separate machine-impact question: the chosen acoustic model
(`facebook/wav2vec2-lv-60-espeak-cv-ft`, verified in §12/A1) is a 1.26 GB, 315M-parameter
wav2vec2-**large** checkpoint — roughly 1.5–2.5 GB resident RAM while the sidecar container is up,
plus a real multi-second CPU burst per submitted utterance (near-zero when idle between requests).
Docker resource flags (`--cpus`, `--memory`) bound this to a hard ceiling rather than hope, and
running the container only for the duration of a drill session (not as a 24/7 daemon) bounds it
further. This guidance belongs to Plan 1 (the sidecar), which has not started; it is recorded here
so it is not lost before that plan resumes.

### 13.2 The decision

- **Local sidecar remains the primary engine**, run resource-capped and on-demand (Plan 1 scope).
  It is the only engine whose cost is independent of practice volume.
- **Azure becomes a manually-selected, budget-capped supplement** — `PRON_PROVIDER=azure` is still
  required explicitly (§7's "no accidental selection" guarantee, already implemented and
  mutation-tested in Task 8, is **unchanged** — this amendment adds a spending ceiling on top of
  that guarantee, it does not loosen it). It is sized for periodic verification, not for covering
  6–7 h/day of volume: **$12/month**, ≈ 18 h of Azure audio at the short-audio rate.
- The cap is enforced by a **decorator**, not a change to `AzurePron` itself: `BudgetCappedPron`
  wraps a metered provider and a fallback provider. Before delegating, it checks a persisted
  monthly counter; over cap, it silently serves the fallback's result instead — per principle #3,
  "degrade, never break." This is a different failure class from a sidecar/API outage: an outage
  still 502s `PRON_UNAVAILABLE` exactly as Task 14 specifies, because a mocked score standing in
  for a claimed-real one would be dishonest. A **self-imposed spending limit** silently falling
  back to the mock engine is not dishonest, because `MockPron` is already a legitimate, documented
  provider — the response's own `pronProvider` field will honestly read `"mock"`, not `"azure"`.
- **Persistence:** a single JSON file (`server/.pron-budget.json`, git-ignored), not a database
  table. This is a deliberate, small exception to "no DB writes before M3" — a bare `{month,
  audioSecondsUsed}` counter, not the ErrorLedger/VocabItem schema M3 owns. Read-then-write with no
  file locking: this is a personal, single-process app, not a multi-tenant billing system: the
  accepted risk is a few seconds of overshoot past the cap under a race, never real correctness
  loss. Usage is recorded **after** a successful Azure call, from the report's own `durationSec`
  (already part of the envelope per A7) — accurate, and it avoids probing audio duration
  server-side before sending.
- **New env vars** (server, added in the now-renumbered `.env.example` task):
  `PRON_AZURE_MONTHLY_CAP_USD` (default `12`), `PRON_AZURE_RATE_PER_HOUR_USD` (default `0.66`,
  matching Azure's short-audio REST rate — configurable because actual billing depends on which
  Azure tier is actually in use), `PRON_BUDGET_STATE_FILE` (default `server/.pron-budget.json`).

### 13.3 What does NOT change

- Task 8's factory guarantee (`PRON_PROVIDER` unset + a key present ⇒ still `mock`) is untouched —
  no test it wrote is contradicted by this amendment.
- Task 14's degradation ladder (sidecar/API failures → 502, learner-caused failures → 4xx) is
  untouched — it is orthogonal to spending, not superseded.
- No new `PRON_ERROR_CODES` value: the honesty this amendment relies on is the existing
  `pronProvider` envelope field, not a new error code.
- Stale comments in already-shipped code (`azure.js`, `index.js`, `routes/pron.js`) that state
  "calibration-only, never runtime" are now inaccurate and are corrected as part of the new tasks
  below, not as a reopening of those tasks' already-approved reviews.
