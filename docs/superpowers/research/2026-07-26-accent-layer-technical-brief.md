<!--
Provenance: generated 2026-07-26 by a 14-agent research workflow (run wf_8eb5e333-4a2):
six parallel topic sweeps, each adversarially refuted by an independent fact-checker,
then synthesised. Refutations override the original findings.

Status: **RESEARCH INPUT, not a decision record.** The decisions distilled from this
live in `docs/superpowers/specs/2026-07-26-accent-prosody-layer-design.md`, which
**overrides this file wherever the two differ.** Claims here carry their own sourcing
inline; treat any unsourced number as unverified.
-->

# SpeakUp M7 — Pronunciation Gym + Prosody Snapshot: Technical Brief

Scope reminder: prosody via forced alignment + F0 (primary) + curated binary minimal-pair checks (secondary). Learner: L1 Spanish (Peninsular), target C1–C2. Local-first, $0 default, degrade-never-break.

---

## 1. Recommended stack

| Layer | Package / model | Version | License | CPU cost | Notes |
|---|---|---|---|---|---|
| **Browser F0** | `pitchy` (McLeod Pitch Method) | 4.1.0 (2024-01-04) | MIT (+ sole dep `fft.js` 4.0.4, MIT) | ~95 µs/frame @48 kHz/2048 ≈ **0.95% of one core** | **Run at 48 kHz, 2048-sample window, 128-frame hop.** Do *not* decimate to 16 kHz — saves 0.74pp of one core and buys an unvalidated resampler + aliasing risk. 2048 @48 kHz = 3.0 periods at 70 Hz (utterance-final creak survives). Vendor the file; one maintainer, no release since Jan 2024. https://www.npmjs.com/package/pitchy |
| **Browser energy** | hand-rolled RMS→dB in the same AudioWorklet | — | own code | negligible | Worklet emits **raw per-hop `{t, rms_dB, hz, clarity}` only**. No nuclei, no counts, no rate in the audio thread. |
| **Browser runtime** | `AudioWorklet` + Vite `?worker&url` | Vite 8 (in repo) | platform | — | Build emits self-contained IIFE (~3.3 KB gz). Dev serves ESM w/ static imports — smoke-test both. Never `ScriptProcessorNode`; never `AnalyserNode` in the measurement path. |
| **Mic ownership** | new `client/src/lib/micStream.js` | — | own code | — | One `getUserMedia` → MediaRecorder + worklet + `SpeechRecognition.start(track)`. Constraints nested under `audio:{}`: `echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1`. Read back `track.getSettings()` and persist per score. |
| **STT** | Web Speech, `processLocally = true` | Chrome 139+ | platform | — | On-device since Aug 2025; gate on `SpeechRecognition.available({processLocally:true, langs:['en-US']})`. Keeps audio on-machine and removes the "second mic consumer" problem entirely. |
| **Sidecar aligner** | Montreal Forced Aligner | **pin `mmcauliffe/montreal-forced-aligner:v3.3.9` or `v3.3.10`** — *not* v3.4.x | Code MIT | unmeasured — spike first | 3.4 is mid-migration to a HF model format with `align_hf` slated to become the 4.0 default. Image ~1.8 GB compressed; budget **4–5 GB WSL2 vhdx**. https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner |
| **Acoustic model** | `english_us_arpa` v3.0.0 (LibriSpeech 982 h) | v3.0.0 (2024-02-10) | **CC BY 4.0** — attribution must ship | — | Chosen for the **phone tier in ARPAbet *with stress digits*** (`AA0 AA1 AA2 … UW0 UW1 UW2`) → nucleus = `/[A-Z]+[012]/`, stress = the digit. Zero G2P, zero syllabifier, zero GPL. https://mfa-models.readthedocs.io |
| **Dictionary** | `english_us_arpa` v3.0.0, 199,858 words | v3.0.0 | CC BY 4.0 | — | Pre-download at **image build time** so the container needs no network. |
| **Sidecar F0** | `pyworld` (WORLD vocoder) | 0.3.5 | wrapper MIT / core mod-BSD | unmeasured | **Windows-only wheels on PyPI — no manylinux.** Add `build-essential` + `cython` to the sidecar image, or vendor a built wheel. `dio()`+`stonemask()`, fall back to `harvest()` if the track is unstable. 10 ms hop matches MFA's grid exactly. |
| **Minimal pairs (primary)** | MFA pronunciation-variant forced choice | — | — | free (rides the alignment) | Put both candidates in a custom dictionary, read which variant's phones land in the phone tier. **Validate before shipping** — see §7. |
| **Minimal pairs (fallback)** | `facebook/wav2vec2-lv-60-espeak-cv-ft` | — | Apache-2.0 | ~1 s / 5 s audio @4 threads (large-class) | **Constrained CTC sequence scoring**: compute CTC log-likelihood of candidate sequence A vs B over the utterance, take the margin. *Not* "posteriors at a known position" — CTC is peaky and unaligned. Gym path only. Requires `transformers` ≥ the #45198 fix (closed, fixed in #45199). |
| **Minimal-pair inventory build** | `CUNY-CL/wikipron` | current | Apache-2.0 | build-time only | Generate attested one-phone-apart pairs from Wiktionary IPA, filter by frequency, human-pass the output. https://github.com/CUNY-CL/wikipron |
| **Client viz** | plain SVG | — | own code | — | Client currently has **zero** viz deps (react/react-dom only, `jest-axe` already wired). Keep it that way. `d3-shape` 3.2.0 (BSD-3-Clause) only if waterfall curves are built. |

**Hard exclusions (license):** `praat-parselmouth` (GPL-3.0-or-later, links **in-process** — the sidecar becomes GPL), `phonemizer`/`espeak-ng` (GPL-3.0), `pitchfinder` (GPL-3.0, and 10–17× slower), `essentia.js` (AGPL-3.0), `aubiojs` (embedded C lib GPL-3.0), `torchaudio.pipelines.MMS_FA` (CC-BY-NC-4.0), `ctc-forced-aligner` (NC default model + non-OSI DOSL-1.0), `Thiagohgl/ai-pronunciation-trainer` (AGPL-3.0 — §13 network copyleft kills the paid tier).

**Torch is in the image regardless** — the official MFA Dockerfile `pip install speechbrain==1.0.3`, which hard-depends on torch. The "conda path avoids torch" framing is false.

**Sidecar-side audio format:** decode in the browser with `AudioContext.decodeAudioData`, resample to 16 kHz mono, POST raw PCM/WAV. `soundfile`/`librosa` cannot open a WebM container, and this keeps `ffmpeg` out of the image.

---

## 2. Metrics to surface

Ordered by evidential strength, not by how impressive they look.

### M1 — Silent-pause profile (**live-safe, primary**)
- **Formula:** detect silences ≥ **250 ms** (named constant `PAUSE_MIN_MS`; de Jong & Bosker 2013 — 22–27% of pauses fall under it and are irrelevant). Report mean pause duration + **location**: clause-internal vs clause-boundary, classified against the transcript.
- **Bands:** treat as having a **floor and a ceiling** — the NSF summary reports 0.3–0.8 s as the highest-intelligibility window, not "shorter is better". Flag ≥1.0 s. Do **not** hard-code; re-derive on the learner's own pipeline.
- **Spanish-L1 vs native:** duration is not the C1–C2 tell; **placement** is. Mid-clause hesitation is the residual signal.
- **Coach:** *"Your pauses land inside phrases — 'I think ⟨pause⟩ that we should' . Move the breath to the comma."*
- **Why it's first:** the only metric needing neither phone alignment nor syllable counting → the only one that can run live and degrade gracefully when the sidecar is down.

### M2 — Articulation rate + speech rate (**session-level only**)
- **Formula:** articulation rate = syllables ÷ phonation time; speech rate = syllables ÷ total duration incl. pauses.
- **Hard constraint:** compute over **≥5 s of accumulated phonation**, ideally the whole session. de Jong & Wempe explicitly avoided short spurts: *"For short spurts, a count of a single extra or fewer syllable will result in an enormous difference in the calculated speech rate."* Per-turn rate is noise with a progress bar. https://www.fon.hum.uva.nl/archive/2009/2009-brm-JongWempe.pdf
- **Spanish-L1 vs native:** L1 Spanish read speech measured at **8.0 syll/s** vs ~5.6 for French (White & Mattys 2007b). Expect the learner well above the English band.
- **Scoring is curvilinear** (Munro & Derwing 2001) — penalise both directions. A linear "faster = better" gauge actively mis-coaches a C1 speaker.
- **Coach:** *"You're running at the top of the band. Slow ~10% and the reductions will have room to happen."*

### M3 — Stressed : unstressed vowel-duration ratio (**the Gym headline**)
- **Formula:** per polysyllabic target word, `dur(stressed vowel) / dur(each unstressed vowel)` from the aligned phone tier. Stress digit comes free from `english_us_arpa`.
- **Spanish-L1 vs native:** Spanish has no central vowel category; unstressed vowels stay full. This is the causal mechanism under every rhythm metric, and it's per-word actionable.
- **Coach:** *"'COMfortable' — you gave the /ə/ 95 ms of full [o]. Native is ~40 ms and centralised. Squash it."*
- **Add a spectral channel:** duration alone cannot show reduction. Flege & Bohn (1989, SSLA 11:35–62) measured vowel **quality**. Pair the ratio with F1/F2 distance from the speaker's own schwa centroid (needs an enrollment pass).

### M4 — Nuclear (sentence) stress placement — **binary, Gym-only**
- **Formula:** pre-annotate the expected nuclear accent per Gym sentence. At score time locate max-prominence syllable from combined F0 excursion + duration + intensity over aligned syllables. Emit hit/miss + "you accented X, English puts it on Y".
- **Spanish-L1 vs native:** English deaccents given/repeated information and retracts the nuclear accent leftward; Spanish keeps it phrase-final. This is the sharpest teachable Spanish contrast available and the highest-value C1–C2 target. Kang's own feature hierarchy puts Stress+Pitch (31%) above Fluency (27%).
- **Evidence caveat:** the "50% of contexts" figure (Marín Marín 2026, REA 5(1):135–155, doi:10.48204/rea.v5n1.10077) is **n=15, single poem-reading task, Valencia** — meter constrains prominence. Instrument it; never use it as a baseline.
- **Coach:** *"You said 'I didn't say he stole the MONEY' — the contrast is on **he**. Move the peak."*
- **Never attempt on free conversational turns.**

### M5 — VarcoV — **hidden progress index, never displayed**
- **Formula:** `VarcoV = 100 × SD(vocalic interval durations) / mean(vocalic interval durations)`. Vocalic interval = contiguous vowel run between consonants.
- **Values (White & Mattys 2007b, hand-segmented, read sentences, SE in parens):** native SSBE **64 (1.7)**; Spanish-L1 English **54 (3.2)**; L1 Castilian Spanish 41 (2.0). https://psychoprosody.com/wp-content/uploads/2014/07/white-mattys-2007b.pdf
- **Evidence:** the only rhythm metric with a significant *within-Spanish-speaker* partial correlation to accent rating (r = −0.440, p<.05, n=30) — but that's ~19% of variance from one 2007 study. Regression fit r²=0.541 (adj. 0.512) was on **n=18 speaker means, 8 stepwise candidates**.
- **Three hard constraints:** (a) store `sentence_id` with every score — Wiget et al. 2010 (JASA 127(3):1559–1569) found *sentence materials* dominate the variance, above speaker; never average across prompts. (b) **Delta-from-own-baseline only** — native Orkney (53) and Welsh Valleys (53) English score the same as Spanish-L1 English (54); an absolute "distance from native" badge asserts Welsh English is broken. (c) **Not comparable to 64/54** — those are hand-segmented on stimuli built to exclude /j w r l/; yours are aligner output.
- **Coach:** nothing. It drives a trend line only, after an empirical noise-floor calibration (same speaker, same sentence, 5–10 reads).

### M6 — PVQ (pitch variation) — **sidecar post-hoc, two-state nudge**
- **Formula:** `PVQ = SD(F0) / mean(F0)`, plus f0 **span** in semitones (90th–10th pct) stored **separately from f0 level** (median F0). Never store or display Hz.
- **Evidence:** Hincks 2005 (System 33(4):575–591) — r=0.83 (n=18) against composite **liveliness** ratings, in **L1 Swedish** speakers. Liveliness ≠ comprehensibility, and Swedish is a wide-range pitch-accent L1 (opposite transfer profile). Treat as plausible-but-untested proxy.
- **Why level/span must be split:** Kang, Rubin & Pickering's "pitch height" factor came out *inversely* related to comprehensibility purely from speaker register and sex — *"men with higher voices in our study fared worse"*. Absolute F0 measures the larynx, not the language.
- **Coach:** *"Flatter than your usual today."* Two states, no number.

### Explicitly NOT surfaced
**nPVI-V** — fails on exactly this population (66 vs native 73, n.s., *"despite the perceptible non-native accent of the latter group"*), and it is redundant with VarcoV (r=0.863). **Any IOI-variability metric** — the syllable-nuclei detector misses unstressed syllables (×1.28 correction on native Dutch), and syllable-timed speech triggers that miss mode *harder*, so the metric can move opposite to the truth on a Spanish speaker. **ΔV/ΔC/rPVI-C/VarcoC** — perceptually inert (r = −0.127 to +0.019, all n.s.). **%V as display** — small, confounded, and moves counter-intuitively in L2. **Any rhythm metric on a free conversational turn.** **A single composite score as the headline.**

### Syllable-nuclei detection — architecture note
De Jong & Wempe (2009) is **not streamable**. Its threshold is a *global* statistic over the whole file (median +0/2 dB; the distributed script uses −25 dB relative to the 99% quantile). Run it **once at end-of-turn** over the buffered contour, on the main thread. Published ceiling on **native Dutch**: per-utterance r=.71 (WISP) / .77 (IFA), rising to .88/.80 only when aggregated per task, with a systematic 28% undercount. There is **no published English validation of this script** — the r=.82 English figure belongs to Pellegrino et al. 2004's different algorithm. Parameters (median-based threshold, 2/4 dB dip, **100 ms** voicing window — not the co-located 32 ms frame) as named constants marked UNCALIBRATED. Port from the paper text, not the GPL script.

---

## 3. Target contrast inventory

`freq%` = EpaDB per-phone non-native rate (n=50 Spanish-L1, Rioplatense). `corr` = correlation with perceived non-nativeness. https://www.isca-archive.org/interspeech_2019/vidal19_interspeech.pdf

| # | Contrast | Example pairs | EpaDB | Tier | Peninsular adjustment |
|---|---|---|---|---|---|
| 1 | **/ɪ/ vs /iː/** | ship~sheep, live~leave, it~eat | IH 45.7 / **0.89** | BLOCKER | — Unidirectional (lax→tense); highest functional load of any English vowel contrast. Flagship. |
| 2 | **schwa /ə/ + reduction** | banana, COMfortable | AX 55.6 / **0.93** (most frequent phone, n=1903) | BLOCKER | **Not a minimal pair** — owned by M3, not the segmental drill. Highest nativeness impact in the corpus. |
| 3 | **/æ/ vs /e/** | bad~bed, man~men, sat~set | AE 71.5 / **0.88** | BLOCKER | — |
| 4 | **/v/ vs /b/** | vet~bet, very~berry, marvel~marble | V 59.6 / **0.92** | BLOCKER | Spanish has **no /v/ phoneme**; spelling gives zero help. 2nd-highest impact. |
| 5 | **/z/ vs /s/** | prize~price, peas~peace, buzz~bus | Z 82.9 / 0.79 | BLOCKER | Articulable (allophone in *mismo*) but not contrastive. Amplified by plural/3sg/possessive morphology. |
| 6 | **/ɑː/ vs /ʌ/** | cart~cut, calm~come | AA 66.2/0.89; AH 34.6/0.86 | BLOCKER | Both collapse to Spanish /a/. |
| 7 | **/oʊ/, /eɪ/ diphthongisation** | coat~cot, late~let | OW 38.9/0.74; EY 13.0/0.63 | BLOCKER | Duration + formant-trajectory check, not a lexical pair. |
| 8 | **/ŋ/ vs /n/ vs /ŋk/** | sing~sin~sink, thing~thin | NG 38.8 / 0.70 | BLOCKER | No word-final /ŋ/ phoneme in Spanish. Huge token frequency via *-ing*. |
| 9 | **/h/ vs [x]** | house, behind, perhaps | HH 18.0 / 0.70 | BLOCKER | **Under-reported for your learner** — Castilian ⟨j⟩/⟨g⟩ is a harsh velar/uvular [x]; EpaDB's Argentines have a softer [h]-like realisation. |
| 10 | **/dʒ/ vs /j/** | jet~yet, major~mayor | JH 36.7; ZH 63.3 | BLOCKER | **Raise above EpaDB rank.** Rioplatense yeísmo gives Argentines [ʒ]/[ʃ] for free; a Castilian speaker has [ʝ]/[ʎ] and no affricate at all. |
| 11 | **/θ/** (verify, then maybe demote) | think~sink, thin~fin | **TH 19.0 / 0.36** | VERIFY | Mid-table — *above* HH and K. The famous "Spanish TH" demotion is only supported for **/ð/ (DH 2.9%)**, where Castilian [ð] is the intervocalic allophone of /d/ (*nada*). Confirm distinción transfers in session 1 before removing /θ/. |
| 12 | Final clusters + devoicing | asked, texts, bagged~backed | T 36.5/0.80; D 23.6/0.79 | BLOCKER | Drill cluster reduction. *-ed* is over-rated in teaching folklore (~8–9% error at advanced level) — cheap regression check only. |
| 13 | /p t k/ aspiration | pill~bill, coat~goat | Ph 79.3, Kh 72.3, Th 45.1 / **corr 0.38–0.58** | **POLISH** | EpaDB: *"produce changes in sound but not in meaning … less penalized"*. Classic high-frequency / low-impact. |
| 14 | **/ɜː/ NURSE** | bird, work, girl | ER 33.5 / **0.38** | **POLISH** | The paper explicitly groups ER with Kh and LL as low-impact. Entangled with the GA-vs-RP rhoticity decision — pick a target variety first. |
| 15 | Dark /ɫ/ in coda | feel, milk, cold | LL **84.9** / **0.40** | **POLISH** | Highest error rate of *any* phone, near-lowest impact. The purest demonstration that frequency must not drive the curriculum. |
| 16 | sC prothesis ("eSpain") | school, street, Spain | *not measurable from EpaDB* | POLISH / regression probe | The "S = 3.0%" statistic is a **denominator artefact** — it aggregates all /s/ positions. Demote on **proficiency** grounds only. Correct ARPAbet for the variant is `school EH0 S K UW1 L` (Spanish prothetic vowel is **[e]**, not schwa). |

**Two-tier split is mandatory.** A naive frequency sort puts dark L and aspiration — the two least consequential items — at rank 1 and 2. Score BLOCKER as intelligibility, POLISH on a separate visible axis. Frame lexical stress as *effort/polish*, never "people can't understand you".

**Cognate lexical-stress drill seeds (corrected):** COMfortable / conforTAble · INteresting / intereSANte · ADmirable / admiRAble · CAtegory / categoRÍa · CHOcolate / chocoLAte · CApitalism / capitaLISmo · biOLogy / bioloGÍa. *(The four Spanish targets in the source research were on the wrong syllable — Spanish stress is orthographically deterministic, so regenerate the whole list from a dictionary before shipping. "hotel" is invalid: both languages stress the final syllable.)*

**Not in scope:** open-vocabulary IPA / PER. Best published F1 for phone-level MDD on L2-ARCTIC is **61–63%** (GOP variants 42–45%) — arXiv:2310.13974 Fig. 2. That's coin-flip feedback for a C1–C2 learner. Binary discrimination against a known target is categorically easier.

---

## 4. `PronunciationResult` schema

**CORE = what the local sidecar provably produces.** The four cloud vendors' intersection is *not* the right basis — a forced-aligner + F0 + minimal-pair engine has no per-word segmental accuracy and performs no recognition. Marking those CORE forces the sidecar to fabricate numbers, which is a silent degradation.

```ts
export type ProviderId = 'local' | 'azure';
export type AssessmentMode = 'scripted' | 'unscripted';
export type Score100 = number;        // 0–100 float. NEVER 0–5.
export type Confidence = number;      // 0..1, model-produced only
/** MATCH LIKELIHOOD, not accuracy. Not a probability distribution. */
export type MatchConfidence100 = number;
export type Provenance = 'measured' | 'derived' | 'heuristic';

export interface PronunciationResult {
  // ---- envelope [CORE] ----
  schemaVersion: 1;
  provider: ProviderId;
  providerVersion: string | null;
  mode: AssessmentMode;
  locale: string;                     // BCP-47
  /** true when audio left the machine — drives the privacy badge */
  audioLeftDevice: boolean;
  /** what getUserMedia ACTUALLY applied. Scores are not comparable across differing values. */
  captureSettings: MediaTrackSettings | null;
  createdAt: string;                  // ISO-8601
  audioDurationMs: number;
  raw: unknown | null;                // verbatim payload, for schema-v2 re-derivation

  referenceText: string | null;       // [CORE] present in Gym mode
  /** [OPT] null when no recognition was performed (forced alignment does none) */
  recognizedText: string | null;

  overall: {
    pronunciation: { value: Score100; provenance: Provenance } | null;
    accuracy:      { value: Score100; provenance: Provenance } | null;
    fluency:       { value: Score100; provenance: Provenance } | null;
    completeness:  { value: Score100; provenance: Provenance } | null;  // scripted only
    prosody:       { value: Score100; provenance: Provenance } | null;  // azure: en-US only
  };

  words: WordResult[];                // [CORE]

  fluencyMetrics: FluencyMetrics | null;      // local emits; azure cannot
  prosodyDetail: ProsodyDetail | null;
  minimalPairs: MinimalPairResult[] | null;   // local only
  rhythmIndex: RhythmIndex | null;            // local only, Gym only
  scaleMappings: ScaleMappings | null;
}

export type WordErrorType =
  | 'None' | 'Omission' | 'Insertion' | 'Mispronunciation'
  | 'UnexpectedBreak' | 'MissingBreak' | 'Monotone';

export interface WordResult {
  word: string;                   // [CORE]
  startMs: number;                // [CORE] azure ticks / 10_000
  durationMs: number;             // [CORE]
  errorType: WordErrorType;       // [CORE] 'None' when provider has no notion
  /** [OPT] null on the local provider — it does no open-vocabulary segmental scoring */
  accuracy: Score100 | null;
  /** [OPT] per-syllable alignment confidence; UI degrades to word granularity below threshold */
  alignmentConfidence: Confidence | null;
  syllables: SyllableResult[] | null;
  phonemes: PhonemeResult[] | null;
  prosodyFeedback: WordProsodyFeedback | null;
}

export interface SyllableResult {
  label: string;
  startMs: number;
  durationMs: number;
  accuracy: Score100 | null;
  expectedStress: 0 | 1 | 2 | null;   // local: ARPAbet stress digit
  actualStress:   0 | 1 | 2 | null;   // local: measured duration+energy prominence
  /** local: dur(this vowel) / dur(word's stressed vowel). The M3 metric. */
  vowelDurationRatio: number | null;
  /** local: F1/F2 distance from the speaker's own schwa centroid (reduction, not duration) */
  centralisationDistance: number | null;
}

export interface PhonemeResult {
  phoneme: string;                    // expected, IPA-normalised
  startMs: number | null;
  durationMs: number | null;
  accuracy: Score100 | null;
  /** what was most likely PRODUCED. local: minimal-pair classifier argmax.
   *  azure: NBestPhonemes[0] when != expected — en-US ONLY. */
  soundMostLike: string | null;
  candidates: Array<{ phoneme: string; score: MatchConfidence100 }> | null;
}

export interface FluencyMetrics {     // session-scoped, not per-turn
  scopeMs: number;                    // accumulated phonation; <5000 ⇒ rates are null
  articulationRate: number | null;    // syll / phonation-sec
  speechRate: number | null;          // syll / total-sec
  syllableCount: number | null;
  pauseCount: number | null;
  pauseTotalMs: number | null;
  pauses: Array<{ startMs: number; endMs: number; position: 'clause-internal' | 'clause-boundary' | 'unknown' }> | null;
  pauseThresholdMs: number;           // named constant, default 250 — bands are threshold-specific
  meanLengthRunWords: number | null;
}

export interface ProsodyDetail {
  monotone: {
    /** azure: Intonation.ErrorTypes includes 'Monotone'. NOT derived from SyllablePitchDeltaConfidence. */
    detected: boolean;
    confidence: Confidence | null;    // azure Intonation.Monotone.Confidence
    /** azure-only, docs: "reserved for user-customized monotone detection". Non-decisional. */
    tuning: { syllablePitchDelta: number | null; wordPitchSlope: number | null } | null;
  } | null;
  pvq: number | null;                 // SD(F0)/mean(F0)
  f0SpanSemitones: number | null;     // 90th–10th pct — SPAN
  f0MedianHz: number | null;          // LEVEL — stored separately, never displayed
  f0Track:     { hz: Array<number | null>; frameMs: number } | null;
  energyTrack: { rms: number[];            frameMs: number } | null;
}

export interface WordProsodyFeedback {
  // azure: model confidences in [0,1], threshold 0.75. ABSENT on the first word — code for undefined.
  unexpectedBreakConfidence: Confidence | null;
  missingBreakConfidence:    Confidence | null;
  // local: measurements in real units. NEVER thresholded at 0.75.
  pauseDurationMs: number | null;
}

export interface MinimalPairResult {  // local only
  pairId: string;                     // 'ship-sheep'
  targetPhoneme: string;              // 'ɪ'
  contrastPhoneme: string;            // 'iː'
  wordIndex: number;
  margin: number;                     // log-likelihood ratio A vs B
  /** 'unclear' when |margin| is below the calibrated threshold — a reject option is mandatory */
  verdict: 'correct' | 'borderline' | 'substituted' | 'unclear';
}

export interface RhythmIndex {        // hidden; never rendered as a score
  sentenceId: string;                 // comparability key — NEVER average across sentences
  varcoV: number | null;
  vocalicIntervalCount: number;       // below the calibrated minimum ⇒ varcoV must be null
  /** false unless the sentence inventory excludes /j w r l/ */
  comparableToPublished: boolean;
}

export interface ScaleMappings {
  cefr: 'A1'|'A2'|'B1'|'B2'|'C1'|'C2' | null;   // local ⇒ provenance 'heuristic'
  provenance: Provenance;
}
```

**Adapter rules (enforce in the factory, not in callers):**

0. **Azure REST: send `Dimension='Comprehensive'`.** Default is `Basic` = accuracy score only, no fluency/completeness/word ErrorType, 200 OK. Second silent default after GradingSystem.
1. **`GradingSystem='HundredMark'` always** — default is `FivePoint` (0–5). Assert scores > 5 in dev.
2. **Pin the SDK/WebSocket transport.** REST short-audio loses syllables, loses the UnexpectedBreak/MissingBreak/Monotone ErrorType values, and caps at 30 s. Keep the dual-shape read (`node.PronunciationAssessment?.X ?? node.X`) only as a logged fallback. `Feedback`'s location under the SDK transport is **unverified** — read `word.Feedback ?? word.PronunciationAssessment?.Feedback`.
3. **Azure ticks → ms: divide `Offset`/`Duration` by 10,000** at every level.
4. **Gate Azure to `locale === 'en-US'` for anything phoneme-level.** IPA phoneme names, syllable groups, spoken phonemes (`NBestPhonemes`) *and* prosody are all en-US only. For en-GB, Azure degrades to full-text + word scores — `soundMostLike` becomes underivable and the whole Spanish-L1 substitution loop is unavailable.
5. **Monotone from `Feedback.Prosody.Intonation.ErrorTypes`**, never from `SyllablePitchDeltaConfidence` (docs: "reserved for user-customized monotone detection"; in the published sample it reads 0.914 on a *non*-monotone utterance where `Monotone.Confidence` is 0.0).
6. **Never branch on `Break.ErrorTypes`** — in the published sample it is `["None"]`, not empty. Always derive from the 0.75 confidence thresholds.
7. **Clamp the ErrorType union per mode** — never emit Omission/Insertion when unscripted.
8. **Do not overwrite a provider's own overall score** (portal parity). But the local composite **should** use Azure's *published* formula so the two are comparable by construction: sort available subscores ascending `s0..s3`; reading w/ prosody `0.4·s0 + 0.2·s1 + 0.2·s2 + 0.2·s3`, reading w/o prosody `0.6·s0 + 0.2·s1 + 0.2·s2`; speaking w/ prosody `0.6·s0 + 0.2·s1 + 0.2·s2`, speaking w/o `0.6·s0 + 0.4·s1`. Record which variant applied. https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
9. **Never plot a cross-provider or cross-mode trend on one axis.** Segment on `provider` + `mode` + `captureSettings`.
10. **Defer the ARPAbet↔IPA table.** The local lexicon emits IPA natively. Azure SAPI `ah` covers both /ʌ/ and /ə/ — the exact contrast a Spanish speaker most needs — so that table is its own research task, not an adapter detail.

**Azure is opt-in cloud only.** Pronunciation assessment is in **none** of the four Speech containers (speech-to-text 5.1.0, custom-speech-to-text 5.1.0, language-detection 1.18.0, neural-text-to-speech 4.1.0), and *"Speech containers aren't licensed to run without being connected to Azure for metering."* Content assessment is retired from SDK 1.46.0 — grammar/vocabulary belongs to the LLM coach layer. Pricing: baseline STT is metered per audio hour (F0 free tier = 5 h/month, confirmed); the enhanced add-on line is literally **"Pronunciation Assessment (prosody)"** — billed per hour per feature for real-time, **included for batch**. Rate figures render client-side and could not be fetched; verify in the pricing calculator before quoting.

**Speechace is a schema donor, not a provider.** No free tier, and its two donor features (fluency counters, CEFR/IELTS/PTE/TOEIC) are Pro-tier ($80/mo) — so a Basic key returns null for exactly what makes it interesting. One correction worth keeping: `extent` / `word_extent` are **10 ms units (centiseconds)**, per https://api-docs.speechace.com/guides-on-common-topics/getting-word-timestamps-in-audio — but define your own `t_start_ms` / `t_end_ms` rather than reusing the name.

---

## 5. Visualisation patterns

**Default to WORD granularity.** RhythmTA — the closest prior art (UIST '25, arXiv:2507.19026) — is word-level throughout, and its evaluation numbers are word-level. Syllable-level displays have no evidence behind them and are only as truthful as the aligner on accented speech.

**Read RhythmTA's numbers correctly:** all the "significant wins" (perceiving own rhythm 6.25 vs 4.17, identifying deviations 6.17 vs 3.25) are **7-point Likert self-report after one 90-minute session**, n=12. The one objective result is that participants made **more attempts per clip (3.08 vs 2.26, p<.05) at no time cost** — the visualisation bought practice repetitions. That's the defensible reason to build it. Note also its stack: VOSK `vosk-model-en-us-0.22` (1.8 GB) + a wav2vec2+Conformer stress classifier trained on Aix-MARSEC (restricted, British English, 85.44%) on an **RTX 4090**. Not shape-compatible with a CPU-only local-first sidecar.

| Rank | Pattern | What | Accessibility |
|---|---|---|---|
| **V1** | **Dual-track duration ribbon** (Gym) | Two tracks, one time axis. Target above, learner below. Each **word** a rounded rect: width = measured duration, fill = stressed/unstressed. Normal typeset sentence above each track (character-linear vs time-linear both needed). | `role="img"` + generated `aria-label`. Visually-hidden `<table>`: word / target ms / your ms / stress. Position + size encodings survive greyscale. No hue-encoded continuous variables (RhythmTA maps stress interval to hue — do not copy; poor for CVD). |
| **V2** | **Beat strip** (per-turn snapshot) | One row of circles, one per word, x = actual timestamp so unequal spacing *is* the rhythm. Filled+large = stressed, small+hollow = unstressed. ~220×28 px, inline under a turn. This is the notation ELT teachers already draw — it transfers to a human tutor. | Text alternative = the ELT nonsense-syllable transcription (`da-DA-da-da-DA`) — a real teachable notation, not a lossy fallback. *(Untested with screen-reader users.)* Hard-gate on `alignmentConfidence`; drop to nothing rather than render noise. |
| **V3** | **Delexicalised tone playback** | Strip words, keep the tune. Two short WAVs (target hum, learner hum), A/B in an `<audio>` element. **Synthesise in numpy** — phase-accumulate a sine/sawtooth over the F0 series, gate by voicing, write with `soundfile`. ~20 lines. | **The only non-visual channel here.** What a blind learner gets, and what a red/green-CVD learner gets. Standard `<audio>` controls. |
| **V4** | **Prosody-modulated typography** | No separate chart — style transcript spans directly. duration→`letter-spacing`, prominence→variable-font `wght`, pitch→`baseline-shift`. Normalise **relative to neighbours**, not absolutely. Static only. | Pataca & Costa (arXiv:2202.10631, n=117, 65% forced-choice recognition — *chance baseline unstated*) found **no significant animated-vs-static difference**, so `prefers-reduced-motion` costs nothing. Needs a toggle (degrades dyslexic readability) and a self-hosted variable font (Inter, OFL). Compute once, render static — `letter-spacing` causes reflow. |
| **V5** | **Live expressiveness meter** — *defer* | VU-meter bars driven by normalised SD of F0 in semitones over a trailing window. | Hincks & Edlund 2009, LLT 13(3):32–50, n=**14 (~7 per arm)**, and their whole motivation was tone-language L1 monotone — Spanish is not a tone language. https://www.lltjournal.org/item/10125-44190/ · If built: `aria-hidden`, never in an `aria-live` region (it machine-guns a screen reader); report once at end of turn; under `prefers-reduced-motion` collapse to a 3-state stepped indicator at ≤2 Hz. |
| — | **Stylised pitch "hat"** — **cut** | — | Its evidence (Niebuhr et al. 2017, IJLCR 3:2) is **18 Danish learners producing German**, "first results", and the Kiel-model *Hutmuster* is not Prosogram's glissando stylisation. Conflicts with that paper's own transferable finding: *"marking prosodic information beyond intonation can be more confusing than instructive."* |

**Rejected outright:** raw F0 contours (learners need training to read them; the model-matching instruction *"may be interpreted by students as a requirement to match the model precisely — a task at which they are bound to fail"*); spectrograms; ToBI/GToBI (highest error rate in Niebuhr et al.); musical notation (speech has no divisible time units); **red/amber/green as the sole encoding** (WCAG 1.4.1, and a colour encodes a scalar — it says you were wrong, not which way to move); animated pitch draw-on; waveform-as-rhythm (learners read amplitude as "loud = stressed", which is the wrong lesson); a single composite score as the headline.

**Cap the feedback.** RhythmTA's DR6, from 9 instructor interviews: *"overly strict expectations… can increase learners' anxiety and reduce learning motivation."* Their algorithm — cap duplicates, sort descending, drop the smallest, green-pass under two remaining. Make the tolerance a **setting**; a C1–C2 learner asking for strict feedback will find lenient mode patronising.

**Two conceptual fixes to carry into the spec:**
1. Duration ribbons do **not** show vowel reduction. Flege & Bohn measured **spectral** quality; a learner can produce perfect long-short alternation with every vowel a full Spanish [a]. Either add the centralisation channel (V1 can shade fill by `centralisationDistance`) or restate the rationale as "duration contrast is cheap, visible, and free from alignment" and stop claiming it targets reduction.
2. Pair every visual with **one imperative sentence** generated from the largest deviation. Dots don't tell the learner what to do.

---

## 6. Reuse before build

| Thing | Use as | License | Note |
|---|---|---|---|
| **MFA** + `english_us_arpa` | **depend on**, pinned image | MIT / CC BY 4.0 | Picked for permissive licence + free ARPAbet stress digits — **not** for accuracy. It is 3rd on TIMIT (12.11 ms, behind MAUS 11.26 and MAPS 11.46), best on Buckeye (13.87). And those figures come from the full `mfa align` pipeline **with speaker adaptation**, which `align_one` does not use. Ship an attribution notice. |
| **`pitchy`** | **vendor** into `client/src/lib/prosody/` | MIT | 18 KB, one dep, one maintainer, no release since Jan 2024. Vendoring is the mitigation, not a fallback. |
| **`CUNY-CL/wikipron`** | **depend on** (build-time) | Apache-2.0 | Generates the minimal-pair inventory. Pin one dialect; human-pass to strip archaisms/proper nouns. https://github.com/CUNY-CL/wikipron |
| **EpaDB** | **offline validation fixture only** | **CC BY-NC-ND 4.0** | 3,200 utts, 50 Argentine Spanish-L1, hand-corrected phone boundaries. **ND forbids derivatives** — never ship anything trained on or derived from it. Use it as a *gold-standard benchmark* to measure your aligner's boundary error against. Access: jvidal@dc.uba.ar. Rioplatense dialect — yeísmo/seseo skew /dʒ/, /ʒ/, /θ/ vs Peninsular. |
| **L2-ARCTIC** (EBVS, ERMS, MBMPS, NJS) | offline fixture, corroboration only | CC BY-NC 4.0 | 4 Spanish speakers — too few to establish new rankings, enough to check EpaDB's ordering isn't an Argentine artefact. https://psi.engr.tamu.edu/l2-arctic-corpus/ |
| **speechocean762** | **machinery calibration only** | **CC BY 4.0** | 5,000 utts, per-phoneme 0–2 from 5 raters. The only commercially-safe corpus with human phone labels. 100% Mandarin L1 + half children — its error **priors** must never seed the Spanish curriculum. https://www.openslr.org/101/ |
| **de Jong & Wempe algorithm** | **port from the paper text**, not the script | script is GPL | Port the median-based threshold, 2/4 dB dip, 100 ms voicing window from the prose. The −25 dB / 0.99-quantile / minpause-0.3 constants come from the **GPL script**, so "zero licence surface" is not automatic. https://www.fon.hum.uva.nl/archive/2009/2009-brm-JongWempe.pdf |
| **Prosogram stylisation** | reimplement (~40 lines) | Praat plugin, copyleft | Per-nucleus median F0, linear fit, flatten below glissando threshold. You get nuclei free from the phone tier. |
| **Azure result shape** | **shadow the field names** | proprietary | Only vendor with a complete public versioned JSON contract. Also the source of the published PronScore formula — which makes local↔Azure overall scores commensurable. |
| **Speechace payload shape** | copy field *names* | proprietary | `quality_score`, `stress_level` vs `predicted_stress_level`, `stress_score`, `sound_most_like`, raw fluency counters. Best guide to what the sidecar should emit. Do **not** reuse `extent` for timing. |
| **GOPT** | read the architecture, don't depend | BSD-3-Clause | Stale since Feb 2023; needs Kaldi-derived GOP features. Its actual numbers are 0.616 phone / 0.743 utterance PCC — weaker than the 0.75–0.82 band it's often credited with. https://github.com/YuanGongND/gopt |
| **RhythmTA** | read the visual grammar | — | React + Flask, but VOSK 1.8 GB + Conformer on a 4090. Port the design, not the stack. https://arxiv.org/abs/2507.19026 |
| ~~`gop-dnn-epadb`~~ | **do not vendor** | **CC BY-NC-ND 4.0** (declared in README) | ND bars porting outright. Read as reference for what works on Spanish L1. |
| ~~`charsiu`~~ | reject | MIT code, **unlicensed weights** | Last commit Sept 2022; HF weights have no model card and no declared licence; needs a vendored `Wav2Vec2ForFrameClassification` that won't load against transformers 5.x; measurably worse than MFA. |
| ~~`Thiagohgl/ai-pronunciation-trainer`~~ | reject | **AGPL-3.0** | §13 network copyleft. Behind an Express server it obliges source release to every user. Study, don't fork. |
| ~~`gentle`, `aeneas`, `stable-ts`, `WhisperX`, `ctc-segmentation`, `kylebgorman/syllabify`~~ | reject | — | Respectively: unlicensed model + Py2 Twisted; AGPL + wrong granularity; archived; wrong shape (ASR is dead weight when the text is known) + torch pin conflict; stale sdist-only, different problem; **no LICENSE file at all**. |

---

## 7. Open risks, ranked

**R1 — Forced-alignment quality on Spanish-accented speech is unmeasured, and the error is *correlated* with the learner error we're trying to detect.**
Every Gym metric (M3, M4, M5, minimal pairs) is downstream of phone boundaries. `english_us_arpa` is LibriSpeech-only (982 h native US read speech), and `align_one` runs that speaker-adapted-trained model **with adaptation switched off** (`align_one` docs: *"features like speaker adaptation are not employed"* — and `--single_speaker` *disables* adaptation, it does not help). Published boundary-error figures are an upper bound this path will not reach.
→ **Experiment:** hand-segment 20–30 of the learner's own utterances in Praat; compute boundary agreement against MFA output; benchmark against EpaDB's hand-corrected boundaries. **Nothing user-visible ships until this passes.** Emit `alignmentConfidence` per unit and degrade syllable→word→nothing below threshold.

**R2 — MFA warm-worker latency is unknown, and the whole architecture hinges on it.**
Kaldi alignment of 5 s is milliseconds, but `mfa align_one` as a subprocess pays Python + sqlalchemy + librosa + kalpy import and model load every call — plausibly 4–10 s.
→ **Experiment (do first):** start Docker Desktop (currently unreachable on this host: `npipe:////./pipe/dockerDesktopLinuxEngine`). Boot the pinned image, time `align_one` cold as a subprocess, then warm inside a persistent Python process. **If a warm worker can't get under ~1.5 s, MFA is Gym-only** and the in-conversation snapshot is browser-only — which is the architecture already chosen, so this is a bounded outcome, not a failure.

**R3 — The sidecar's build story: MFA bakes PostgreSQL under `MFA_ROOT_DIR`, started only from `~/.bashrc`.**
The official Dockerfile does `ENV MFA_ROOT_DIR=/mfa`, `RUN mfa server init`, `RUN echo "… mfa server start" > ~/.bashrc`. A FastAPI ENTRYPOINT **never sources `~/.bashrc`** → alignment fails at runtime with a DB connection error. And **do not tmpfs `MFA_ROOT_DIR`** — it would erase both the initialised cluster and the build-time-downloaded models, defeating the offline goal. On Windows/Docker Desktop this lands in WSL2 where PG socket/lock behaviour on bind mounts is exactly what breaks.
→ **Fix:** point `--temporary_directory` at a tmpfs, leave `/mfa` a real layer on a **named volume** (never a Windows bind mount). Either `mfa configure --disable_auto_server` at build time and verify SQLite alignment works, or start PG from the entrypoint before uvicorn. Spike item.

**R4 — No sidecar-down fallback is specified. This directly violates "degrade never break."**
Every Gym metric returns nothing if the container is unreachable, and the "live browser fallback" is scaffolding that does not exist yet (grep of `client/src`: no `AudioContext`, no `AnalyserNode`, no `AudioWorklet`, no pitch tracking — the only "pitch" hits are `SpeechSynthesisUtterance.pitch` in `speech.js:86` and a test stub).
→ **Fix:** define the sidecar-down UX **before** any metric. Minimum viable degrade: pause profile (M1) runs entirely in-browser and needs no alignment. Make that the guaranteed floor.

**R5 — Windows 11 audio processing sits *below* the browser and no `getUserMedia` constraint can reach it.**
Per-device **Audio enhancements / Voice Focus** (Settings → System → Sound → Input) and OEM APO effects (Realtek/Intel/Nvidia) run in the OS audio stack. AGC continuously normalises loudness — which is precisely the signal the energy envelope reads. (Chromium 327472528 is *not* evidence for this; it's "Won't Fix (Intended Behavior)" because constraints work when nested under `audio:{}`.)
→ **Experiment (before writing any DSP):** request constraints nested correctly, read back `track.getSettings()`, record a fixed-amplitude tone at two distances and check whether the RMS ratio is preserved. Add a first-run instruction to disable Windows Voice Focus and **record whether it was done** — Chrome can neither detect nor disable it. Persist `captureSettings` with every score; refuse to compare across differing values.

**R6 — The forced-choice minimal-pair trick is unvalidated and has no reject option.**
Putting both candidates in a custom dictionary replaces the distributed lexicon, discarding the pronunciation/silence probabilities that were *"estimated as part of acoustic model training"* — changing the lexicon FST the model was tuned against. And a learner producing something that is neither /v/ nor /b/ still gets deterministically bucketed, with the bias direction unknown (the native-trained model plausibly favours the native-like variant).
→ **Experiment (cheap, ~1 hour):** record yourself deliberately producing both sides of 5 pairs (ship/sheep, vet/bet, zoo/Sue, bad/bed, jet/yet); confirm the aligner separates them. Check whether MFA can accept variants while retaining trained pronunciation probabilities. **Add a likelihood-margin threshold returning `'unclear'`** — this is why `verdict` has four states.

**R7 — `pyworld` has no manylinux wheels; the sidecar image must build it from sdist.**
PyPI 0.3.5 ships exactly 11 files: cp36/37 win32, cp36–cp313 win_amd64, and the tarball. The MFA base image ships no C toolchain. *(Any dio/stonemask/harvest millisecond figures you've seen for this project were never measured — treat F0 cost as an assumption.)*
→ **Fix:** add `build-essential` + `cython` to the image, or vendor a prebuilt wheel. Time it in-container. Low severity, certain to bite.

**R8 — The AudioWorklet is not unit-testable and Vite dev/prod diverge.**
jsdom has no Web Audio (jsdom#2900, open since 2020). Dev serves the worklet as an **ES module with static imports**; build emits a self-contained IIFE — a worklet that works in `vite build` can fail in `vite dev`.
→ **Fix:** three layers. (a) All DSP as pure functions over `Float32Array` in `client/src/lib/prosody/*.js` — plain Vitest, no mocks, easy 80%. (b) Test the processor directly by stubbing exactly four globals: `AudioWorkletProcessor` (class with a `port`), `registerProcessor`, `sampleRate`, `currentTime` — then drive `process([[frame128]], [[out]], {})` in 128-sample quanta. (c) One Playwright test loading a fixture WAV through `OfflineAudioContext` (deterministic, faster than real-time, no mic permission). Do **not** reach for `standardized-audio-context-mock` — its `AudioWorkletNodeMock` is a literal `// @todo` empty stub.

**R9 — Evidence base is thin and none of it is Peninsular Spanish.**
VarcoV's within-Spanish result is one 2007 study, n=30, ~19% of variance. The nuclear-stress figure is n=15 on a single poem. The Peninsular TH/[x]/dʒ adjustments are **inference, not measurement** — there is no Peninsular equivalent of EpaDB. No visualisation in this space has been evaluated with Spanish L1 learners.
→ **Mitigation:** treat every band as a placeholder. Run the VarcoV noise floor (same speaker, same sentence, 5–10 reads) and set the "meaningful change" threshold **above** it. Validate the /θ/ demotion in session 1 before removing it from the inventory. Frame everything as within-learner trend, never as distance-from-native.

**R10 — C1–C2 is where all these curves flatten.**
Most L2 prosody literature samples broad proficiency ranges. At C1–C2 the learner is already near ceiling on lexical stress (>90%) and inside the rate band, where published relationships are least discriminating. Expect metrics that separate B1 from C1 to be near-useless for C1 vs C2.
→ **Mitigation:** weight the milestone toward the three places residual signal plausibly lives — **nuclear-stress placement, deaccenting of given information, and function-word weak forms** — rather than toward the metrics with the best published effect sizes.