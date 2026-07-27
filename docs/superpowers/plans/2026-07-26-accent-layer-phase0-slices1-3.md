# Accent & Prosody Layer — Plan 1: Phase 0 + Slices 1–3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the two risky dependencies (Windows audio capture, MFA in WSL2), then ship a browser-only pause profile, a real persistence layer, and a sidecar walking skeleton — everything needed before the Gym can be built.

**Architecture:** Three independent layers, each shipped whole. (1) An `AudioWorklet` with zero imports emits per-hop RMS to the main thread; pure functions over that array produce a silent-pause profile with clause placement, anchored on the recognizer's own finalization events. (2) The Express app is split from its listener so it can be imported, and Prisma finally gets used. (3) A Dockerised MFA sidecar answers `POST /pron/score` through an Express proxy, behind a factory that treats "offline" as a first-class state.

**Tech Stack:** React 19 · Vite 8 · Vitest 4 (client, jsdom; server, node) · Express 5 · Prisma 6 + SQLite · Montreal Forced Aligner v3.3.9 in Docker · FastAPI

**Spec:** [`docs/superpowers/specs/2026-07-26-accent-prosody-layer-design.md`](../specs/2026-07-26-accent-prosody-layer-design.md)
**Research:** [`docs/superpowers/research/`](../research/) — technical brief, spec gaps, panel guide.

**Not in this plan:** slices 4–8 (Gym, ledger, karaoke, echo moment, minimal pairs). Spec §14.1 — their content depends on how K1 and K3 resolve, so planning them now would be fiction.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Repo is plain ESM JavaScript.** No TypeScript. Use JSDoc where types aid clarity. Match surrounding style.
- **No `Date.now()` in any measurement path.** Timing comes from `AudioContext.currentTime`. (`useConversation.js:154,183` uses `Date.now()` for the listen cap — that is a policy timer, not a measurement, and stays.)
- **Every calibration-sensitive threshold is a named exported constant with an `UNCALIBRATED` comment** citing its source, or marking it explicitly as a project-chosen heuristic. Spec §16.
  *Calibration-sensitive* means a value K3 or later measurement could move: a silence floor, a minimum duration, a surfacing count, a margin. It does **not** cover fixed platform constants (`HOP_SIZE = 128` is the Web Audio render-quantum size, not a threshold) or internal buffer sizing — those stay module-private.
- **Never encode meaning in colour alone.** WCAG 1.4.1.
- **No new client runtime dependencies** in this plan. Client `dependencies` stays exactly `react` + `react-dom`.
- **No GitHub Actions, no Playwright, no supertest.** Spec §12.
- **`useConversation.js` must never import a Web Audio module.** All capture sits behind `client/src/lib/micStream.js`. Spec §12.
- **Client coverage config is an allowlist** — any new file under coverage must be added to `include` **in the same commit as its first test**, or the build goes red (Vitest `coverage.all` defaults true). Spec §12.
- **Sidecar image pinned to `mmcauliffe/montreal-forced-aligner:v3.3.9`.** Never `v3.4.x`. Spec §5.1.
- **Attribution:** `english_us_arpa` is CC BY 4.0. `THIRD-PARTY-NOTICES.md` ships in Task 14.
- **Commit messages:** conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Multi-line messages use a bash heredoc (`git commit -F - <<'EOF'`), never PowerShell here-string syntax.
- **Before every commit, verify the staged content**, not the working tree: `git show :<path> | head -20`. This repo has had untracked WIP leak into commits.

### Deviations from the spec (deliberate, with reasons)

| # | Spec says | This plan does | Why |
|---|---|---|---|
| **D-a** | Worklet emits `{rms_dB, hz, clarity}` (§4.1) | Worklet emits **`rms_dB` only**, plus a raw PCM ring | Live F0 has no consumer — the pitch contour was rejected, and the hum lands in slice 4. A worklet with **zero imports** removes risk R8 (Vite dev serves ESM with static imports; build emits a self-contained IIFE) entirely. F0 computed on the main thread from the ring gives identical values at zero continuous CPU cost. |
| **D-b** | `pitchy` vendored (§5.1) | Not installed in this plan | No consumer yet. Installing + vendoring a dependency nothing imports is dead weight. Moves to plan 2, with the hum. |
| **D-c** | `createRecognizer(track)`, `processLocally:true` (§4.1, §12) | Deferred; slice 1 runs two independent capture consumers | Chrome 139+ floor and the single-`getUserMedia` fan-out belong with the STT work, which is not in slices 1–3. **K2 measures exactly this two-consumer case**, so the data arrives before the code depends on it. |
| **D-d** | `captureSettings Json`, `metrics Json?` (§9.1) | `Turn.prosody` is **`String?`** holding JSON text | Avoids depending on whether the Prisma 6 SQLite connector supports `Json` — a migrate-time failure. Task 11 records the answer so slice 4 can decide for `PronAttempt` with data. |

---

## File Structure

**Phase 0 (spikes) — no product code**

| File | Responsibility |
|---|---|
| `client/public/spikes/k2.html` | Standalone mic-characterisation harness. Served by the existing dev server. |
| `docs/superpowers/spikes/2026-07-26-K2-windows-audio.md` | K2 findings: measured numbers + the descope decision. |
| `docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md` | K1 findings: cold/warm latency, the PostgreSQL fix that worked, image size. |

**Slice 1 — browser prosody floor**

| File | Responsibility |
|---|---|
| `client/src/lib/prosody/pauses.js` | Pure: RMS-dB frame array → silent pauses, adaptive floor. No DOM. |
| `client/src/lib/prosody/placement.js` | Pure: pauses + finalization timestamps → clause-internal / boundary / unknown. |
| `client/src/lib/prosody/summary.js` | Pure: classified pauses → one imperative sentence (or null). |
| `client/src/lib/prosody/pcm.worklet.js` | AudioWorklet. **Zero imports.** Per-hop RMS-dB + a raw PCM ring. |
| `client/src/lib/micStream.js` | Module singleton owning `getUserMedia`, the `AudioContext`, the worklet node and the frame buffer. The only Web Audio boundary. |
| `client/src/components/PauseNote.jsx` | Renders the one sentence under a user bubble. |

**Slice 2 — persistence spine**

| File | Responsibility |
|---|---|
| `server/src/app.js` | Builds and exports the Express app. No `listen`. |
| `server/src/index.js` | Imports the app and listens. Nothing else. |
| `server/src/db.js` | Lazy `PrismaClient` singleton. |
| `server/src/repo/session.js` | The only module that writes `Session` / `Turn`. |
| `server/vitest.config.js` | Node-environment Vitest. |
| `server/test/global-setup.js` | Pushes the schema to a throwaway test DB. |

**Slice 3 — sidecar walking skeleton**

| File | Responsibility |
|---|---|
| `sidecar/Dockerfile` | MFA v3.3.9 + FastAPI, models baked at build time. |
| `sidecar/app.py` | `GET /healthz`, `POST /align` (single asyncio lock). |
| `sidecar/entrypoint.sh` | Starts PostgreSQL, then uvicorn. |
| `docker-compose.yml` | Named volumes, loopback-only publish. |
| `server/src/pronunciation/index.js` | Factory: `getPron()` / `currentPronProvider()`. |
| `server/src/pronunciation/local.js` | HTTP client for the sidecar. |
| `server/src/pronunciation/mock.js` | Deterministic phone tier. Tests need no Docker. |
| `server/src/routes/pron.js` | `POST /pron/score` multipart. |
| `client/src/lib/pron.js` | Client wrapper for `/pron/score`. |
| `THIRD-PARTY-NOTICES.md` | CC BY 4.0 attribution. |

---

# PHASE 0 — SPIKES

Zero product code. Each spike ends with a committed findings document containing **measured numbers**, not impressions. Spec §13.

---

### Task 1: K2 — Windows audio characterisation

**Files:**
- Create: `client/public/spikes/k2.html`
- Create: `docs/superpowers/spikes/2026-07-26-K2-windows-audio.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a decision recorded in the findings doc — whether energy-derived quantities may use absolute dB or must be relative-only. Task 3 reads it.

**Why:** Windows 11 per-device *Audio enhancements / Voice Focus* and OEM APO effects run **below** the browser. No `getUserMedia` constraint reaches them, and AGC continuously renormalises loudness — the exact signal the pause detector reads. Spec §13/K2.

- [ ] **Step 1: Write the harness**

Create `client/public/spikes/k2.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>K2 — Windows audio characterisation</title>
<style>
  body { font: 14px/1.5 system-ui; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  pre { background: #111; color: #eee; padding: 1rem; border-radius: 8px; overflow-x: auto; }
  button { font: inherit; padding: .5rem 1rem; margin-right: .5rem; }
</style>
<h1>K2 — Windows audio characterisation</h1>
<p>Play a fixed-amplitude tone from a phone. Hold it ~20&nbsp;cm from the mic, click
   <b>Measure 5s</b>. Then hold it ~60&nbsp;cm away and measure again. Repeat both with
   <b>Start recognizer</b> active. Real AGC shows up as the far/near ratio collapsing toward 1.</p>

<button id="start">Start capture</button>
<button id="measure" disabled>Measure 5s</button>
<button id="rec">Start recognizer</button>
<button id="recStop">Stop recognizer</button>
<pre id="out">idle</pre>

<script type="module">
  const out = document.getElementById("out");
  const log = (o) => { out.textContent += "\n" + (typeof o === "string" ? o : JSON.stringify(o, null, 2)); };
  let ctx, analyser, recognizer;

  document.getElementById("start").onclick = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const track = stream.getAudioTracks()[0];
    out.textContent = "track.getSettings() — what the browser ACTUALLY applied:";
    log(track.getSettings());
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    log(`sampleRate = ${ctx.sampleRate}`);
    document.getElementById("measure").disabled = false;
  };

  document.getElementById("measure").onclick = async () => {
    const buf = new Float32Array(analyser.fftSize);
    const samples = [];
    const t0 = ctx.currentTime;
    while (ctx.currentTime - t0 < 5) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      samples.push(Math.sqrt(sum / buf.length));
      await new Promise((r) => setTimeout(r, 20));
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    log({ frames: samples.length, medianRms: median, p95Rms: p95, medianDb: 20 * Math.log10(median || 1e-9) });
  };

  document.getElementById("rec").onclick = () => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognizer = new Ctor();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.onerror = (e) => log("recognizer error: " + e.error);
    recognizer.start();
    log("recognizer started");
  };
  document.getElementById("recStop").onclick = () => { recognizer?.stop(); log("recognizer stopped"); };
</script>
```

- [ ] **Step 2: Run the four measurements**

Run: `npm --prefix client run dev`
Open: `http://localhost:5173/spikes/k2.html` in **Chrome** (mic needs a secure context; localhost qualifies).

Record `medianRms` for all four cells:

| | recognizer stopped | recognizer active |
|---|---|---|
| tone at ~20 cm | | |
| tone at ~60 cm | | |

- [ ] **Step 3: Repeat with Windows Voice Focus disabled**

Open **Settings → System → Sound → Input → (your mic) → Audio enhancements** and set it to **Off**. Re-run all four cells. Record whether the numbers changed — Chrome can neither detect nor disable this, so it must be recorded by hand.

- [ ] **Step 4: Write the findings doc**

Create `docs/superpowers/spikes/2026-07-26-K2-windows-audio.md` containing: the `getSettings()` output verbatim; the 4-cell table for both enhancement states; the computed near/far RMS ratios; and this decision, filled in:

> **Decision:** the near/far RMS ratio was `<X>` with enhancements on and `<Y>` with them off.
> A ratio near 1 means the OS is renormalising and **absolute dB is not comparable across sessions**.
> → Energy-derived quantities are **[absolute-capable | relative-only]**.
> Per spec §13/K2, relative-only means M4's prominence estimator drops the intensity term and runs on duration + F0. **Nothing descopes.**
> First-run instruction required: disable Voice Focus. Was it disabled during this measurement? **[yes/no]**

- [ ] **Step 5: Commit**

```bash
git add client/public/spikes/k2.html docs/superpowers/spikes/2026-07-26-K2-windows-audio.md
git show :docs/superpowers/spikes/2026-07-26-K2-windows-audio.md | head -20
git commit -m "spike(K2): characterise Windows audio capture for the prosody path"
```

---

### Task 2: K1 — MFA in WSL2

**Files:**
- Create: `docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md`
- Create: `sidecar/sample/hello.wav`, `sidecar/sample/hello.txt` (fixtures for the spike and later tests)

**Interfaces:**
- Consumes: nothing.
- Produces: the confirmed base image tag, the working PostgreSQL startup incantation, the pip path inside the image, and cold/warm `align_one` latency. Tasks 14–15 depend on all four.

**Why:** The official MFA Dockerfile sets `MFA_ROOT_DIR=/mfa`, runs `mfa server init`, and starts PostgreSQL **only from `~/.bashrc`** — which a FastAPI ENTRYPOINT never sources. On Windows this lands in WSL2, where PG socket/lock behaviour on bind mounts is the known failure. Spec §13/K1.

**Timebox: one day.** If it ends without a phone tier, take the §3.1/C1 branch: M7 ships browser-only (slices 1–2), Gym and echo move to M8, in writing. **Latency alone descopes nothing** — it only chooses cold-subprocess vs warm-worker.

- [ ] **Step 1: Confirm Docker is reachable**

Run: `docker version`
Expected: both Client and Server sections print. If the server section errors on `npipe:////./pipe/dockerDesktopLinuxEngine`, start Docker Desktop and wait for it to report Running before continuing.

- [ ] **Step 2: Pull the pinned image and create the named volume**

```bash
docker pull mmcauliffe/montreal-forced-aligner:v3.3.9
docker volume create mfa_root
docker image inspect mmcauliffe/montreal-forced-aligner:v3.3.9 --format '{{.Size}}'
```

Record the size. **Never a Windows bind mount for `/mfa`** — a named volume only.

- [ ] **Step 3: Initialise the server and download the models into the volume**

```bash
docker run --rm -v mfa_root:/mfa -e MFA_ROOT_DIR=/mfa \
  mmcauliffe/montreal-forced-aligner:v3.3.9 \
  bash -lc "mfa server init && mfa model download acoustic english_us_arpa && mfa model download dictionary english_us_arpa && mfa model list acoustic"
```

Expected: `english_us_arpa` appears in the final listing. Record any error verbatim — this is the step R3 predicts will fail.

- [ ] **Step 4: Create the sample fixture**

Record yourself saying *"I've been thinking about it all week"* as **16 kHz mono WAV** and save it as `sidecar/sample/hello.wav`. Create `sidecar/sample/hello.txt` containing exactly:

```
I've been thinking about it all week
```

- [ ] **Step 5: Time a cold `align_one`**

```bash
docker run --rm -v mfa_root:/mfa -v "$(pwd)/sidecar/sample:/sample" -e MFA_ROOT_DIR=/mfa \
  mmcauliffe/montreal-forced-aligner:v3.3.9 \
  bash -lc "mfa server start; time mfa align_one /sample/hello.wav /sample/hello.txt english_us_arpa english_us_arpa /sample/out.json --output_format json --clean"
```

Expected: `/sample/out.json` appears containing word and phone tiers, with ARPAbet labels carrying stress digits (`AY1`, `AH0`, …). Record the wall-clock time.

If `mfa server start` is not the working incantation, try `mfa configure --disable_auto_server` before `align_one` and record which one worked — that answer goes straight into `entrypoint.sh` in Task 14.

- [ ] **Step 6: Time a warm run**

Start a persistent container, then run `align_one` **three times** inside it and record each duration:

```bash
docker run -d --name mfa_warm -v mfa_root:/mfa -v "$(pwd)/sidecar/sample:/sample" -e MFA_ROOT_DIR=/mfa \
  mmcauliffe/montreal-forced-aligner:v3.3.9 sleep infinity
docker exec mfa_warm bash -lc "mfa server start; for i in 1 2 3; do time mfa align_one /sample/hello.wav /sample/hello.txt english_us_arpa english_us_arpa /sample/out\$i.json --output_format json --clean; done"
docker rm -f mfa_warm
```

- [ ] **Step 7: Record the pip path**

```bash
docker run --rm mmcauliffe/montreal-forced-aligner:v3.3.9 bash -lc "which python; which pip; python -V"
```

Record all three — Task 14's `RUN pip install` needs the exact path.

- [ ] **Step 8: Write the findings doc**

Create `docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md` with: image size, whether Step 3 succeeded and any error verbatim, cold latency, the three warm latencies, the working PG incantation, the pip/python paths, and this decision, filled in:

> **Decision:** a phone tier **[was | was not]** produced.
> - Produced ⇒ slices 3+ proceed. Warm latency `<N>` s ⇒ **[warm worker | cold subprocess per request]**.
> - Not produced ⇒ **§3.1/C1 branch taken**: M7 ships browser-only (slices 1–2); Gym, echo scoring and all alignment-derived metrics move to M8. **Stop after Task 12 and write that decision into the spec's §3 table.**

- [ ] **Step 9: Commit**

```bash
git add sidecar/sample docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md
git show :docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md | head -30
git commit -m "spike(K1): MFA v3.3.9 in WSL2 — alignment, latency, PostgreSQL startup"
```

---

# SLICE 1 — BROWSER PROSODY FLOOR

No sidecar, no Docker, no Prisma. Ships a usable sentence under the learner's bubble.

---

### Task 3: Pause detection (pure)

**Files:**
- Create: `client/src/lib/prosody/pauses.js`
- Create: `client/src/lib/prosody/pauses.test.js`
- Modify: `client/vitest.config.js:14`

**Interfaces:**
- Consumes: nothing.
- Produces: `PAUSE_MIN_MS: number`, `FLOOR_DROP_DB: number`, `detectPauses(framesDb: Float32Array, opts: {hopMs: number, minPauseMs?: number}) => Array<{startMs: number, endMs: number, durationMs: number}>`.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/prosody/pauses.test.js`:

```js
import { describe, it, expect } from "vitest";
import { detectPauses, PAUSE_MIN_MS } from "./pauses.js";

const HOP_MS = 10;

/** Build a frame array in dB: segments of [durationMs, dbValue]. */
function frames(...segments) {
  const out = [];
  for (const [ms, db] of segments) {
    for (let i = 0; i < Math.round(ms / HOP_MS); i += 1) out.push(db);
  }
  return Float32Array.from(out);
}

describe("detectPauses", () => {
  it("finds exactly one pause when 400ms of silence sits between two tones", () => {
    const f = frames([1000, -20], [400, -70], [1000, -20]);
    const pauses = detectPauses(f, { hopMs: HOP_MS });
    expect(pauses).toHaveLength(1);
    expect(pauses[0].durationMs).toBeGreaterThanOrEqual(380);
    expect(pauses[0].durationMs).toBeLessThanOrEqual(420);
  });

  it("ignores a 240ms gap, which is below the floor", () => {
    const f = frames([1000, -20], [240, -70], [1000, -20]);
    expect(detectPauses(f, { hopMs: HOP_MS })).toHaveLength(0);
  });

  it("is gain invariant — halving every frame's amplitude changes nothing", () => {
    const loud = frames([1000, -20], [400, -70], [1000, -20]);
    const quiet = loud.map((db) => db - 6); // -6 dB == x0.5 amplitude
    expect(detectPauses(quiet, { hopMs: HOP_MS })).toEqual(detectPauses(loud, { hopMs: HOP_MS }));
  });

  it("returns nothing for an all-silent buffer (no speech to be silent between)", () => {
    expect(detectPauses(frames([2000, -70]), { hopMs: HOP_MS })).toHaveLength(0);
  });

  it("exposes the threshold as a named constant", () => {
    expect(PAUSE_MIN_MS).toBe(250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- src/lib/prosody/pauses.test.js`
Expected: FAIL — `Failed to resolve import "./pauses.js"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/prosody/pauses.js`:

```js
/**
 * Silent-pause detection over a per-hop RMS-dB series (spec §5.2, M1).
 *
 * The floor is ADAPTIVE — relative to the utterance's own 95th-percentile
 * level — because Windows per-device AGC / Voice Focus renormalise loudness
 * below the browser, where no getUserMedia constraint reaches. An absolute dB
 * floor would not be comparable across sessions on the same machine.
 */

/** UNCALIBRATED — de Jong & Bosker 2013: 22-27% of pauses fall below 250ms and are irrelevant. */
export const PAUSE_MIN_MS = 250;

/**
 * UNCALIBRATED — de Jong & Wempe 2009 use -25 dB relative to the 99% quantile.
 * We drop from p95 instead, per spec §5.2's adaptive-floor requirement; do not
 * go looking for a p99 computation to match the citation.
 */
export const FLOOR_DROP_DB = 25;

/** UNCALIBRATED — project-chosen heuristic: a buffer with no dynamic range at all is silence or noise, not speech. */
export const MIN_DYNAMIC_RANGE_DB = 6;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * @param {Float32Array|number[]} framesDb per-hop RMS in dB
 * @param {{hopMs: number, minPauseMs?: number, floorDropDb?: number}} opts
 * @returns {Array<{startMs: number, endMs: number, durationMs: number}>}
 */
export function detectPauses(framesDb, { hopMs, minPauseMs = PAUSE_MIN_MS, floorDropDb = FLOOR_DROP_DB }) {
  const n = framesDb.length;
  if (!n || !hopMs) return [];

  const sorted = Array.from(framesDb).sort((a, b) => a - b);
  const p95 = percentile(sorted, 0.95);
  const p05 = percentile(sorted, 0.05);
  if (p95 - p05 < MIN_DYNAMIC_RANGE_DB) return []; // no speech/silence contrast
  const floor = p95 - floorDropDb;

  const pauses = [];
  let runStart = -1;
  let sawSpeechBefore = false;

  for (let i = 0; i < n; i += 1) {
    const isSilent = framesDb[i] < floor;
    if (isSilent) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1 && sawSpeechBefore) {
        pushIfLongEnough(pauses, runStart, i, hopMs, minPauseMs);
      }
      runStart = -1;
      sawSpeechBefore = true;
    }
  }
  // A trailing silent run is the end of the turn, not a pause between speech.
  return pauses;
}

function pushIfLongEnough(pauses, startIdx, endIdx, hopMs, minPauseMs) {
  const durationMs = (endIdx - startIdx) * hopMs;
  if (durationMs >= minPauseMs) {
    pauses.push({ startMs: startIdx * hopMs, endMs: endIdx * hopMs, durationMs });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- src/lib/prosody/pauses.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Extend the coverage allowlist**

Modify `client/vitest.config.js` line 14 — replace:

```js
      include: ["src/hooks/useConversation.js", "src/lib/speech.js"],
```

with:

```js
      include: [
        "src/hooks/useConversation.js",
        "src/lib/speech.js",
        "src/lib/micStream.js",
        "src/lib/prosody/**/*.js",
      ],
      exclude: ["src/lib/prosody/*.worklet.js"],
```

This **must** land in the same commit as the first prosody test — Vitest's `coverage.all` defaults true, so the glob would otherwise report 0% on files with no tests and fail the 80% threshold.

- [ ] **Step 6: Verify full suite and coverage still pass**

Run: `npm --prefix client run test:coverage`
Expected: all tests pass; `pauses.js` reports ≥80% on lines/functions/branches/statements.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/prosody/pauses.js client/src/lib/prosody/pauses.test.js client/vitest.config.js
git show :client/vitest.config.js
git commit -m "feat(prosody): adaptive-floor silent-pause detection"
```

---

### Task 4: Pause placement (pure)

**Files:**
- Create: `client/src/lib/prosody/placement.js`
- Create: `client/src/lib/prosody/placement.test.js`

**Interfaces:**
- Consumes: the pause shape from Task 3 — `{startMs, endMs, durationMs}`.
- Produces: `classifyPauses(pauses, finalizations: Array<{tMs: number, text: string}>) => Array<{...pause, placement: "boundary"|"internal"|"unknown"}>` and `summarise(classified) => {total, internal, boundary, unknown}`.

**Why the design is inverted:** Chrome's `SpeechRecognitionAlternative` exposes only `transcript` + `confidence` — no timings. Interpolating from `event.timeStamp` is worse than useless: that is *dispatch* time, and the recognizer finalizes **because** it detected the silence, so the anchor is displaced by exactly the interval being measured. Instead we use the recognizer's own endpoint decisions as boundary evidence.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/prosody/placement.test.js`:

```js
import { describe, it, expect } from "vitest";
import { classifyPauses, summarise } from "./placement.js";

const pause = (startMs, endMs) => ({ startMs, endMs, durationMs: endMs - startMs });

describe("classifyPauses", () => {
  it("marks a pause as boundary when a finalization lands inside it", () => {
    const result = classifyPauses([pause(1000, 1400)], [{ tMs: 1200, text: "I went home" }]);
    expect(result[0].placement).toBe("boundary");
  });

  it("marks a pause as boundary when the preceding chunk ends in punctuation", () => {
    const result = classifyPauses(
      [pause(2000, 2400)],
      [{ tMs: 900, text: "I went home," }, { tMs: 3000, text: "then I slept" }],
    );
    expect(result[0].placement).toBe("boundary");
  });

  it("marks a pause as internal when it sits inside one chunk with no punctuation", () => {
    const result = classifyPauses(
      [pause(2000, 2400)],
      [{ tMs: 900, text: "I think" }, { tMs: 3000, text: "that we should go" }],
    );
    expect(result[0].placement).toBe("internal");
  });

  it("marks a trailing pause as unknown — nothing finalized after it", () => {
    const result = classifyPauses([pause(2000, 2400)], [{ tMs: 900, text: "I think" }]);
    expect(result[0].placement).toBe("unknown");
  });

  it("treats a recognizer restart as a finalization, so the hole reads as boundary", () => {
    // A restart pushes a finalization at the moment of the gap.
    const result = classifyPauses([pause(1000, 1900)], [{ tMs: 1500, text: "" }]);
    expect(result[0].placement).toBe("boundary");
  });
});

describe("summarise", () => {
  it("counts each placement and excludes unknown from the total", () => {
    const classified = [
      { placement: "internal" }, { placement: "internal" },
      { placement: "boundary" }, { placement: "unknown" },
    ];
    expect(summarise(classified)).toEqual({ total: 3, internal: 2, boundary: 1, unknown: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- src/lib/prosody/placement.test.js`
Expected: FAIL — `Failed to resolve import "./placement.js"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/prosody/placement.js`:

```js
/**
 * Classify each silent pause as clause-internal or clause-boundary (spec §5.2, M1).
 *
 * Placement — not duration — is the C1-C2 tell. We have no word timings
 * (Chrome exposes none), so the recognizer's own finalization events are the
 * boundary evidence: it finalizes when it decides an utterance ended.
 */

const CLAUSE_END = /[.,;:!?…]\s*$/;

/**
 * @param {Array<{startMs:number,endMs:number,durationMs:number}>} pauses
 * @param {Array<{tMs:number,text:string}>} finalizations worklet-clock timestamps
 */
export function classifyPauses(pauses, finalizations) {
  const marks = [...finalizations].sort((a, b) => a.tMs - b.tMs);

  return pauses.map((p) => ({ ...p, placement: placementFor(p, marks) }));
}

function placementFor(p, marks) {
  const inside = marks.some((m) => m.tMs >= p.startMs && m.tMs <= p.endMs);
  if (inside) return "boundary";

  const before = marks.filter((m) => m.tMs < p.startMs).pop();
  if (before && CLAUSE_END.test(before.text)) return "boundary";

  const after = marks.some((m) => m.tMs > p.endMs);
  return after ? "internal" : "unknown";
}

/** `unknown` is reported but never counted toward the actionable total. */
export function summarise(classified) {
  const internal = classified.filter((c) => c.placement === "internal").length;
  const boundary = classified.filter((c) => c.placement === "boundary").length;
  const unknown = classified.filter((c) => c.placement === "unknown").length;
  return { total: internal + boundary, internal, boundary, unknown };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- src/lib/prosody/placement.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/prosody/placement.js client/src/lib/prosody/placement.test.js
git commit -m "feat(prosody): classify pauses as clause-internal or boundary"
```

---

### Task 5: The imperative sentence (pure)

**Files:**
- Create: `client/src/lib/prosody/summary.js`
- Create: `client/src/lib/prosody/summary.test.js`

**Interfaces:**
- Consumes: `summarise()` output from Task 4.
- Produces: `MIN_INTERNAL_TO_SURFACE: number`, `pauseSentence(counts) => string | null`, `sessionPauseSentence(counts) => string | null`.

**Why templates, never an LLM:** an LLM handed acoustic numbers invents ones it was not given. Spec §8.4. This module is also the single source of the string — the visible caption, the one live-region announcement and any `aria-label` summary must all reuse the identical output.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/prosody/summary.test.js`:

```js
import { describe, it, expect } from "vitest";
import { pauseSentence, sessionPauseSentence, MIN_INTERNAL_TO_SURFACE } from "./summary.js";

describe("pauseSentence", () => {
  it("stays silent below the surfacing threshold", () => {
    expect(pauseSentence({ total: 5, internal: 2, boundary: 3, unknown: 0 })).toBeNull();
  });

  it("names the count and gives one instruction when the threshold is met", () => {
    const s = pauseSentence({ total: 6, internal: 4, boundary: 2, unknown: 0 });
    expect(s).toContain("4");
    expect(s).toMatch(/comma|phrase/i);
  });

  it("never emits undefined, NaN or [object Object]", () => {
    const s = pauseSentence({ total: 9, internal: 9, boundary: 0, unknown: 0 });
    expect(s).not.toMatch(/undefined|NaN|\[object/);
  });

  it("stays under 120 characters so it fits one line under a bubble", () => {
    expect(pauseSentence({ total: 40, internal: 40, boundary: 0, unknown: 0 }).length).toBeLessThan(120);
  });

  it("exposes the threshold as a named constant", () => {
    expect(MIN_INTERNAL_TO_SURFACE).toBe(3);
  });
});

describe("sessionPauseSentence", () => {
  it("is silent when nothing accumulated", () => {
    expect(sessionPauseSentence({ total: 0, internal: 0, boundary: 0, unknown: 0 })).toBeNull();
  });

  it("reports the day and names tomorrow's focus", () => {
    const s = sessionPauseSentence({ total: 20, internal: 11, boundary: 9, unknown: 0 });
    expect(s).toBe("You broke mid-phrase 11 times today. Tomorrow starts with chunking.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- src/lib/prosody/summary.test.js`
Expected: FAIL — `Failed to resolve import "./summary.js"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/prosody/summary.js`:

```js
/**
 * Deterministic coach copy for the pause profile (spec §7.4, §8.4).
 * Templates only — never an LLM, which would invent numbers it wasn't given.
 * The string produced here is the SINGLE source: the visible caption, the one
 * live-region announcement and any aria-label summary all reuse it verbatim.
 */

/** UNCALIBRATED — project-chosen heuristic: below 3 breaks, the signal is indistinguishable from normal speech planning. */
export const MIN_INTERNAL_TO_SURFACE = 3;

/** One turn. Returns null when there is nothing worth saying. */
export function pauseSentence(counts) {
  if (!counts || counts.internal < MIN_INTERNAL_TO_SURFACE) return null;
  const n = counts.internal;
  return `You broke mid-phrase ${n} ${n === 1 ? "time" : "times"} — let the breath land on the comma instead.`;
}

/** End of session. Frames tomorrow rather than grading today. */
export function sessionPauseSentence(counts) {
  if (!counts || counts.internal < 1) return null;
  const n = counts.internal;
  return `You broke mid-phrase ${n} ${n === 1 ? "time" : "times"} today. Tomorrow starts with chunking.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- src/lib/prosody/summary.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/prosody/summary.js client/src/lib/prosody/summary.test.js
git commit -m "feat(prosody): deterministic pause-profile coach copy"
```

---

### Task 6: The AudioWorklet processor

**Files:**
- Create: `client/src/lib/prosody/pcm.worklet.js`
- Create: `client/src/lib/prosody/pcm.worklet.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a processor registered as `"pcm-processor"` that posts `{ type: "frames", rmsDb: Float32Array }` batches, and answers `{ type: "dumpRing" }` with `{ type: "ring", pcm, sampleRate }`. `BATCH_HOPS` and `RING_SECONDS` are read from `processorOptions`; **the hop is never configured** — it is the render quantum the browser hands `process()`.

**Why zero imports (deviation D-a):** Vite serves a worklet in dev as an ES module with static imports, but emits a self-contained IIFE on build — a worklet that works in `vite build` can fail in `vite dev`. A processor with no imports at all cannot hit that. It also keeps the audio thread doing nothing but arithmetic: no nuclei, no counts, no rates. Spec §4.1.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/prosody/pcm.worklet.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * jsdom has no Web Audio, so we test the processor directly by stubbing the
 * exact four globals an AudioWorkletGlobalScope provides, then driving
 * process() in 128-sample quanta. (standardized-audio-context-mock is not an
 * option — its AudioWorkletNodeMock is a literal `// @todo` empty stub.)
 */
let registered = null;

class FakePort {
  constructor() { this.messages = []; }
  postMessage(m) { this.messages.push(m); }
}

async function loadProcessor(options) {
  registered = null;
  vi.stubGlobal("AudioWorkletProcessor", class { constructor() { this.port = new FakePort(); } });
  vi.stubGlobal("registerProcessor", (name, ctor) => { registered = { name, ctor }; });
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal("currentTime", 0);
  vi.resetModules();
  await import("./pcm.worklet.js");
  return new registered.ctor({ processorOptions: options });
}

/** Drive N quanta of 128 samples at a constant amplitude. */
function pump(proc, quanta, amplitude) {
  const block = new Float32Array(128).fill(amplitude);
  for (let i = 0; i < quanta; i += 1) proc.process([[block]], [[new Float32Array(128)]], {});
}

beforeEach(() => { registered = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("pcm.worklet", () => {
  it("registers under the name micStream looks up", async () => {
    await loadProcessor({});
    expect(registered.name).toBe("pcm-processor");
  });

  it("batches frames instead of posting every hop", async () => {
    const proc = await loadProcessor({ batchHops: 32 });
    pump(proc, 31, 0.5);
    expect(proc.port.messages).toHaveLength(0);
    pump(proc, 1, 0.5);
    expect(proc.port.messages).toHaveLength(1);
    expect(proc.port.messages[0].rmsDb).toHaveLength(32);
  });

  it("reports a full-scale block near 0 dB and a silent block far below it", async () => {
    const proc = await loadProcessor({ batchHops: 1 });
    pump(proc, 1, 1.0);
    expect(proc.port.messages[0].rmsDb[0]).toBeCloseTo(0, 1);
    pump(proc, 1, 0.0);
    expect(proc.port.messages[1].rmsDb[0]).toBeLessThan(-100);
  });

  it("keeps returning true so the node is never garbage collected mid-turn", async () => {
    const proc = await loadProcessor({});
    expect(proc.process([[new Float32Array(128)]], [[new Float32Array(128)]], {})).toBe(true);
  });

  it("survives a quantum with no input channel (the node is connected but the track is muted)", async () => {
    const proc = await loadProcessor({ batchHops: 1 });
    expect(() => proc.process([[]], [[new Float32Array(128)]], {})).not.toThrow();
  });

  // The ring is the only part of this file with non-obvious index arithmetic,
  // and *.worklet.js is excluded from coverage instrumentation — these two
  // tests are the only regression net it will ever have.
  it("returns the ring in chronological order once it has wrapped", async () => {
    const proc = await loadProcessor({ batchHops: 1, ringSeconds: (128 * 3) / 48000 }); // exactly 3 quanta
    pump(proc, 1, 0.1);
    pump(proc, 1, 0.2);
    pump(proc, 1, 0.3);
    pump(proc, 1, 0.4); // overwrites the 0.1 quantum
    proc.port.onmessage({ data: { type: "dumpRing" } });

    const ring = proc.port.messages.find((m) => m.type === "ring");
    expect(ring.pcm).toHaveLength(384);
    expect(ring.pcm[0]).toBeCloseTo(0.2, 5); // oldest surviving sample first
    expect(ring.pcm[128]).toBeCloseTo(0.3, 5);
    expect(ring.pcm[383]).toBeCloseTo(0.4, 5); // newest sample last
    expect(ring.sampleRate).toBe(48000);
  });

  it("returns only what has been written before the ring wraps", async () => {
    const proc = await loadProcessor({ batchHops: 1, ringSeconds: (128 * 3) / 48000 });
    pump(proc, 2, 0.5);
    proc.port.onmessage({ data: { type: "dumpRing" } });

    const ring = proc.port.messages.find((m) => m.type === "ring");
    expect(ring.pcm).toHaveLength(256); // two quanta, not the full 384
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- src/lib/prosody/pcm.worklet.test.js`
Expected: FAIL — `Failed to resolve import "./pcm.worklet.js"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/prosody/pcm.worklet.js`:

```js
/**
 * AudioWorklet: per-hop RMS in dB, plus a bounded raw PCM ring.
 *
 * DELIBERATELY IMPORT-FREE. Vite serves worklets as ESM in dev and as a
 * self-contained IIFE after build; a processor with no imports cannot diverge
 * between the two. It also keeps the audio thread to arithmetic only — no
 * nuclei detection, no counts, no rates (spec §4.1). The main thread owns all
 * interpretation.
 */

// No hopSize here: the hop IS the render quantum the browser hands process(),
// so the worklet never needs telling. Only the main thread needs the number,
// to turn a frame index back into a time.
const DEFAULTS = { batchHops: 32, ringSeconds: 15 };

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = { ...DEFAULTS, ...(options?.processorOptions ?? {}) };
    this.batchHops = o.batchHops;
    this.batch = new Float32Array(this.batchHops);
    this.batchIndex = 0;

    this.ring = new Float32Array(Math.ceil(sampleRate * o.ringSeconds));
    this.ringWrite = 0;
    this.ringFilled = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === "dumpRing") {
        this.port.postMessage({ type: "ring", pcm: this.readRing(), sampleRate });
      }
    };
  }

  readRing() {
    if (this.ringFilled < this.ring.length) return this.ring.slice(0, this.ringWrite);
    const out = new Float32Array(this.ring.length);
    out.set(this.ring.subarray(this.ringWrite), 0);
    out.set(this.ring.subarray(0, this.ringWrite), this.ring.length - this.ringWrite);
    return out;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const s = channel[i];
      sum += s * s;
      this.ring[this.ringWrite] = s;
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
      if (this.ringFilled < this.ring.length) this.ringFilled += 1;
    }

    const rms = Math.sqrt(sum / channel.length);
    this.batch[this.batchIndex] = 20 * Math.log10(rms || 1e-9);
    this.batchIndex += 1;

    if (this.batchIndex === this.batchHops) {
      // Copy, do not transfer: transferring detaches the buffer and forces a
      // fresh allocation inside process() ~12x/s, which is the GC pressure
      // we are avoiding in the first place.
      this.port.postMessage({ type: "frames", rmsDb: this.batch.slice(0) });
      this.batchIndex = 0;
    }
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- src/lib/prosody/pcm.worklet.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/prosody/pcm.worklet.js client/src/lib/prosody/pcm.worklet.test.js
git commit -m "feat(prosody): import-free AudioWorklet emitting per-hop RMS"
```

---

### Task 7: `micStream.js` — the single Web Audio boundary

> **AMENDED after review — the Step 3 code below is superseded by what shipped in `805441c`.**
> The reference implementation had two resource bugs that broke the module's own stated invariant, plus a coverage shortfall:
> 1. **Mic leak on partial acquisition.** `getUserMedia` and `new AudioContext()` both succeed before `current` is assigned, so a throw from `addModule` / `new AudioWorkletNode` / `.connect()` (worklet 404, CSP blocking module workers, no `AudioWorklet`) abandoned a live track that `releaseMicStream()` could then never stop. Fixed with a `teardown(stream, ctx, node)` helper called from a `catch`.
> 2. **Release during acquisition silently dropped.** `releaseMicStream()` while opening was a no-op, and acquisition then published the stream anyway — reachable from `main.jsx`'s own `visibilitychange` handler. Fixed with a `releaseRequested` flag the acquisition honours before publishing.
> 3. **Branch coverage 64.28%**, under the 80% gate this plan enforces. Seven tests added, including one per bug above.
>
> Read `client/src/lib/micStream.js` at `805441c` as the source of truth for this task.

**Files:**
- Create: `client/src/lib/micStream.js`
- Create: `client/src/lib/micStream.test.js`
- Modify: `client/src/main.jsx`

**Interfaces:**
- Consumes: the `"pcm-processor"` worklet from Task 6; `detectPauses` from Task 3.
- Produces:
  - `getMicStream(): Promise<void>` — idempotent; opens capture if not already open.
  - `releaseMicStream(): void`
  - `micNowMs(): number` — worklet-clock milliseconds; `0` when closed.
  - `resetFrames(): void`
  - `getFrames(): Float32Array`
  - `getHopMs(): number`
  - `getCaptureSettings(): MediaTrackSettings | null`
  - `isMicOpen(): boolean`

**Why a plain singleton with no refcount:** a leaked reference leaves the microphone hot in the one project whose headline claim is that audio stays on the machine. One owner, one release path. Spec §4.1.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/micStream.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Web Audio stubs live HERE, not in setup.js — the 93 existing tests must not
 * suddenly gain a fake AudioContext. navigator is a getter, so it is patched
 * with defineProperty; replacing it wholesale breaks user-event.
 */
let workletNode;
let addModuleCalls;
let stopCalls;

function installWebAudioStubs() {
  addModuleCalls = 0;
  stopCalls = 0;
  const track = {
    stop: () => { stopCalls += 1; },
    getSettings: () => ({ sampleRate: 48000, echoCancellation: false, autoGainControl: false }),
  };
  const stream = { getAudioTracks: () => [track] };

  vi.stubGlobal("AudioWorkletNode", class {
    constructor() { this.port = { onmessage: null, postMessage: vi.fn() }; workletNode = this; }
    connect() {}
    disconnect() {}
  });
  vi.stubGlobal("AudioContext", class {
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.audioWorklet = { addModule: async () => { addModuleCalls += 1; } }; }
    createMediaStreamSource() { return { connect: () => {} }; }
    close() { return Promise.resolve(); }
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
}

beforeEach(() => { vi.resetModules(); installWebAudioStubs(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("micStream", () => {
  it("requests the mic with every browser processor disabled", async () => {
    const { getMicStream } = await import("./micStream.js");
    await getMicStream();
    const constraints = navigator.mediaDevices.getUserMedia.mock.calls[0][0];
    expect(constraints.audio.echoCancellation).toBe(false);
    expect(constraints.audio.noiseSuppression).toBe(false);
    expect(constraints.audio.autoGainControl).toBe(false);
    expect(constraints.audio.channelCount).toBe(1);
  });

  it("opens capture only once no matter how often it is called", async () => {
    const { getMicStream } = await import("./micStream.js");
    await getMicStream();
    await getMicStream();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(addModuleCalls).toBe(1);
  });

  it("accumulates frames posted by the worklet", async () => {
    const { getMicStream, getFrames } = await import("./micStream.js");
    await getMicStream();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10, -20]) } });
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-30]) } });
    expect(Array.from(getFrames())).toEqual([-10, -20, -30]);
  });

  it("keeps the ring across a reset of nothing — resetFrames only clears frames", async () => {
    const { getMicStream, getFrames, resetFrames } = await import("./micStream.js");
    await getMicStream();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10]) } });
    resetFrames();
    expect(getFrames()).toHaveLength(0);
  });

  it("reports the hop duration derived from the real sample rate", async () => {
    const { getMicStream, getHopMs } = await import("./micStream.js");
    await getMicStream();
    expect(getHopMs()).toBeCloseTo((128 / 48000) * 1000, 5);
  });

  it("records what the browser actually applied, not what we asked for", async () => {
    const { getMicStream, getCaptureSettings } = await import("./micStream.js");
    await getMicStream();
    expect(getCaptureSettings()).toEqual({ sampleRate: 48000, echoCancellation: false, autoGainControl: false });
  });

  it("stops the track on release so the mic indicator goes out", async () => {
    const { getMicStream, releaseMicStream, isMicOpen } = await import("./micStream.js");
    await getMicStream();
    releaseMicStream();
    expect(stopCalls).toBe(1);
    expect(isMicOpen()).toBe(false);
  });

  it("is safe to release when never opened", async () => {
    const { releaseMicStream } = await import("./micStream.js");
    expect(() => releaseMicStream()).not.toThrow();
  });

  it("returns 0 from micNowMs when capture is closed", async () => {
    const { micNowMs } = await import("./micStream.js");
    expect(micNowMs()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- src/lib/micStream.test.js`
Expected: FAIL — `Failed to resolve import "./micStream.js"`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/micStream.js`:

```js
/**
 * The ONLY place in the client that touches getUserMedia or Web Audio.
 *
 * useConversation must never import a Web Audio module (spec §12) — it imports
 * this, and tests mock this. A plain module singleton with no refcount and no
 * idle-grace timer: one owner, one release path. A leaked reference would
 * leave the microphone hot in the one project whose headline claim is that
 * audio stays on the machine.
 */

const HOP_SIZE = 128;
const BATCH_HOPS = 32;
const RING_SECONDS = 15;

/** Everything the browser is allowed to do to the signal, switched off. */
const CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
};

let current = null;
let opening = null;
let frames = [];

export function isMicOpen() {
  return current !== null;
}

export async function getMicStream() {
  if (current) return;
  if (opening) return opening;

  opening = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    const track = stream.getAudioTracks()[0];
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL("./prosody/pcm.worklet.js", import.meta.url));

    const node = new AudioWorkletNode(ctx, "pcm-processor", {
      // HOP_SIZE is deliberately not passed: the worklet's hop is whatever
      // quantum the browser hands it. This module keeps the number only to
      // convert a frame index back into milliseconds.
      processorOptions: { batchHops: BATCH_HOPS, ringSeconds: RING_SECONDS },
    });
    node.port.onmessage = (e) => {
      if (e.data?.type === "frames") {
        for (let i = 0; i < e.data.rmsDb.length; i += 1) frames.push(e.data.rmsDb[i]);
      }
    };
    ctx.createMediaStreamSource(stream).connect(node);

    current = { stream, track, ctx, node, settings: track.getSettings() };
  })();

  try {
    await opening;
  } finally {
    opening = null;
  }
}

export function releaseMicStream() {
  if (!current) return;
  try { current.node.disconnect(); } catch { /* already torn down */ }
  current.track.stop();
  current.ctx.close?.();
  current = null;
  frames = [];
}

/** Worklet-clock milliseconds. Monotonic, and aligned with the frame indices. */
export function micNowMs() {
  return current ? current.ctx.currentTime * 1000 : 0;
}

export function resetFrames() {
  frames = [];
}

export function getFrames() {
  return Float32Array.from(frames);
}

export function getHopMs() {
  const rate = current?.ctx.sampleRate ?? 48000;
  return (HOP_SIZE / rate) * 1000;
}

export function getCaptureSettings() {
  return current?.settings ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- src/lib/micStream.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Release the mic when the tab is hidden**

Modify `client/src/main.jsx` — replace the whole file with:

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { releaseMicStream } from "./lib/micStream.js";
import "./index.css";

// The single release path. Capture is only ever acquired from an event
// handler (never an effect), so StrictMode's double-invoke can't open it twice.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") releaseMicStream();
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 6: Run the whole suite**

Run: `npm --prefix client test`
Expected: PASS — the 93 pre-existing tests plus the new ones. No pre-existing test may change.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/micStream.js client/src/lib/micStream.test.js client/src/main.jsx
git show :client/src/main.jsx
git commit -m "feat(prosody): micStream singleton owning capture and the worklet"
```

---

### Task 8: Wire the pause profile into the conversation

**Files:**
- Modify: `client/src/hooks/useConversation.js`
- Modify: `client/src/hooks/useConversation.test.js:8-12` (add a third `vi.mock`)
- Modify: `server/src/prompts/coach-system.js` (one-line drive-by)

**Interfaces:**
- Consumes: `micStream` (Task 7), `detectPauses` (Task 3), `classifyPauses` + `summarise` (Task 4), `pauseSentence` (Task 5).
- Produces: two new members on the hook's return value — `pauseNote: string | null` and `sessionPauseCounts: {total,internal,boundary,unknown}`. Task 9 renders `pauseNote`; Task 12 persists the counts.

- [ ] **Step 1: Add the mock and write the failing tests**

Modify `client/src/hooks/useConversation.test.js` — insert after the `vi.mock("../lib/speech.js", …)` block (i.e. after line 40):

```js
vi.mock("../lib/micStream.js", () => ({
  getMicStream: vi.fn(async () => {}),
  releaseMicStream: vi.fn(),
  micNowMs: vi.fn(() => 0),
  resetFrames: vi.fn(),
  getFrames: vi.fn(() => new Float32Array(0)),
  getHopMs: vi.fn(() => 10),
  getCaptureSettings: vi.fn(() => null),
  isMicOpen: vi.fn(() => true),
}));
```

Then append this block to the **end of the file**. It defines its own mount helper: the existing `mounted()` is `async` **and scoped inside** `describe("useConversation — speech machine", …)` (`:111-116`), so a new top-level describe cannot reach it. The top-level `beforeEach` (`:46-54`) already mocks `getHealth`, so the wait below works.

```js
describe("useConversation — pause profile", () => {
  async function mountedProsody() {
    const utils = renderHook(() => useConversation());
    await waitFor(() => expect(utils.result.current.providers.tts).toBe("kokoro"));
    return utils;
  }

  /** [durationMs, dB] segments at the 10ms hop getHopMs is mocked to report. */
  function buildFrames(segments) {
    const out = [];
    for (const [ms, db] of segments) for (let i = 0; i < ms / 10; i += 1) out.push(db);
    return Float32Array.from(out);
  }

  let mic;

  beforeEach(async () => {
    mic = await import("../lib/micStream.js");
    // The module mock persists across tests; the top-level beforeEach doesn't know about it.
    mic.getMicStream.mockClear();
    mic.resetFrames.mockClear();
    mic.getFrames.mockReturnValue(new Float32Array(0));
    mic.getHopMs.mockReturnValue(10);
    mic.micNowMs.mockReturnValue(0);
  });

  it("opens capture and clears the frame buffer when listening starts", async () => {
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    expect(mic.getMicStream).toHaveBeenCalled();
    expect(mic.resetFrames).toHaveBeenCalled();
  });

  it("stays silent when the turn had fewer than three mid-phrase breaks", async () => {
    // 1s speech / 400ms silence / 1s speech -> one pause, and with the only
    // finalization at t=0 it classifies as trailing-unknown, not internal.
    mic.getFrames.mockReturnValue(buildFrames([[1000, -20], [400, -70], [1000, -20]]));
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("hello there"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toBeNull();
  });

  it("surfaces one sentence once three mid-phrase breaks are detected", async () => {
    mic.getFrames.mockReturnValue(
      buildFrames([[500, -20], [300, -70], [500, -20], [300, -70], [500, -20], [300, -70], [500, -20]]),
    );
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 5000)); // finalizations land after every pause
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that we should go"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toMatch(/broke mid-phrase 3/);
  });

  it("does not clear the frame buffer when the recognizer auto-restarts mid-turn", async () => {
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    mic.resetFrames.mockClear();
    await act(async () => { recHandlers.onEnd(); }); // silence self-termination -> restart
    expect(mic.resetFrames).not.toHaveBeenCalled();
  });
});
```

The last test is **slice 1's gate condition** — a restart must not throw away the contour accumulated so far.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix client test -- src/hooks/useConversation.test.js`
Expected: FAIL — `result.current.pauseNote` is `undefined`.

- [ ] **Step 3: Wire the hook**

Modify `client/src/hooks/useConversation.js`.

Add to the import block after line 10:

```js
import { getMicStream, micNowMs, resetFrames, getFrames, getHopMs } from "../lib/micStream.js";
import { detectPauses } from "../lib/prosody/pauses.js";
import { classifyPauses, summarise } from "../lib/prosody/placement.js";
import { pauseSentence } from "../lib/prosody/summary.js";
```

Add these state and ref declarations after line 32 (`const [ttsFallbackActive, …]`):

```js
  const [pauseNote, setPauseNote] = useState(null);
  const [sessionPauseCounts, setSessionPauseCounts] = useState({ total: 0, internal: 0, boundary: 0, unknown: 0 });
  const finalizationsRef = useRef([]);
```

Add this function immediately before `finishListening` (line 120):

```js
  /**
   * Runs once at end of turn, on the main thread, over the buffered contour.
   * It cannot stream: the silence floor is a global statistic over the whole
   * utterance (spec §5.2, M1).
   */
  function computePauseProfile() {
    const pauses = detectPauses(getFrames(), { hopMs: getHopMs() });
    const classified = classifyPauses(pauses, finalizationsRef.current);
    const counts = summarise(classified);
    setSessionPauseCounts((prev) => ({
      total: prev.total + counts.total,
      internal: prev.internal + counts.internal,
      boundary: prev.boundary + counts.boundary,
      unknown: prev.unknown + counts.unknown,
    }));
    setPauseNote(pauseSentence(counts));
  }
```

In `finishListening` (line 120), call it as the first statement:

```js
  function finishListening(announceEmpty) {
    computePauseProfile();
    const combined = `${draftRef.current} ${interimRef.current}`.trim();
```

In `startListening` (line 174), after `emptyRestartsRef.current = 0;` add:

```js
    finalizationsRef.current = [];
    setPauseNote(null);
    resetFrames();
    getMicStream().catch(() => { /* capture is optional; the turn still works */ });
```

In the `onResult` handler (line 186), record the finalization timestamp:

```js
      onResult: (chunk) => {
        emptyRestartsRef.current = 0;
        finalizationsRef.current.push({ tMs: micNowMs(), text: chunk });
        setDraft((d) => `${d} ${chunk}`.trim());
      },
```

In `handleRecognizerEnd` (line 163), record the restart as a finalization — a restart **is** an endpoint decision, so the hole reads as `boundary`:

```js
    emptyRestartsRef.current += 1;
    finalizationsRef.current.push({ tMs: micNowMs(), text: "" });
```

Finally add both to the return object (line 270), next to `ttsFallbackActive`:

```js
    pauseNote,
    sessionPauseCounts,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix client test -- src/hooks/useConversation.test.js`
Expected: PASS — the 40 pre-existing hook tests plus 3 new ones.

- [ ] **Step 5: Patch the coach's level (spec §14, one-line drive-by)**

Run: `grep -n "B1" server/src/prompts/coach-system.js`
Replace the `B1–B2` / `B1-B2` level description with `C1–C2`. Shipping a C1–C2 prosody engine behind a B1–B2 coach is a contradiction audible every turn.

- [ ] **Step 6: Run the whole client suite and coverage**

Run: `npm --prefix client run test:coverage`
Expected: all tests pass; every file in the coverage allowlist ≥80% on all four metrics.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useConversation.js client/src/hooks/useConversation.test.js server/src/prompts/coach-system.js
git show :client/src/hooks/useConversation.js | grep -n "pauseNote"
git commit -F - <<'EOF'
feat(prosody): accumulate a per-turn silent-pause profile

Pause placement is anchored on the recognizer's own finalization events
rather than interpolated timestamps: event.timeStamp is dispatch time, and
the recognizer finalizes BECAUSE it detected the silence, so that anchor is
displaced by exactly the interval being measured. A restart counts as a
finalization, which makes the auto-restart hole read as a clause boundary.

Also patches the coach system prompt from B1-B2 to C1-C2.
EOF
```

---

### Task 9: Render the pause note

**Files:**
- Create: `client/src/components/PauseNote.jsx`
- Create: `client/src/components/PauseNote.test.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/__a11y__.test.jsx`

**Interfaces:**
- Consumes: `pauseNote` from Task 8.
- Produces: a rendered note. Nothing later depends on it.

**Accessibility constraint:** `VoiceStatus` already renders a persistent `aria-live="polite"` region in the footer, **and aria-live is inherited by descendants**. The pause note must **not** render inside that subtree — it goes in `<main>`, under the last user bubble, as ordinary静 text. Spec §8.1.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/PauseNote.test.jsx`:

```jsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PauseNote from "./PauseNote.jsx";

describe("PauseNote", () => {
  it("renders nothing when there is no note", () => {
    const { container } = render(<PauseNote note={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the sentence verbatim", () => {
    render(<PauseNote note="You broke mid-phrase 4 times — let the breath land on the comma instead." />);
    expect(screen.getByText(/broke mid-phrase 4 times/)).toBeInTheDocument();
  });

  it("is not a live region — VoiceStatus owns the only polite announcement", () => {
    const { container } = render(<PauseNote note="anything" />);
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- src/components/PauseNote.test.jsx`
Expected: FAIL — `Failed to resolve import "./PauseNote.jsx"`.

- [ ] **Step 3: Write the component**

Create `client/src/components/PauseNote.jsx`:

```jsx
/**
 * One plain sentence about where the learner breathed. No chart, no number
 * badge, no colour coding — "move the breath to the comma" is a tomorrow
 * instruction, not a three-seconds-from-now one (spec §7.4).
 *
 * Deliberately NOT a live region: VoiceStatus already owns the single polite
 * announcement, and aria-live is inherited by descendants (spec §8.1).
 */
export default function PauseNote({ note }) {
  if (!note) return null;
  return (
    <p className="text-xs text-muted pl-1 italic border-l-2 border-line/60 ml-1">
      {note}
    </p>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- src/components/PauseNote.test.jsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mount it in App**

Modify `client/src/App.jsx`. Add the import after line 6:

```jsx
import PauseNote from "./components/PauseNote.jsx";
```

Then inside `<main>`, immediately after the `{c.messages.map(…)}` block and before the `thinking` paragraph (line 72), add:

```jsx
        <PauseNote note={c.pauseNote} />
```

- [ ] **Step 6: Add it to the accessibility suite**

Modify `client/src/components/__a11y__.test.jsx` — add `PauseNote` to the components it renders and asserts `toHaveNoViolations()` on, following the existing pattern in that file for `VoiceStatus`. Also add `StatHeader`, which the suite does not currently cover (spec §12).

- [ ] **Step 7: Run the whole suite**

Run: `npm --prefix client test`
Expected: PASS, all suites including axe.

- [ ] **Step 8: Verify the worklet loads in BOTH dev and build**

This is slice 1's real gate — Vite serves worklets differently in the two modes.

```bash
npm --prefix client run dev
```
Open `http://localhost:5173`, click the mic, speak a sentence with two deliberate mid-phrase hesitations, stop. Confirm: no console errors, and the note appears. Then:

```bash
npm --prefix client run build && npm --prefix client run preview
```
Repeat the same check against the preview URL. **Both must work.** If dev fails and build succeeds (or vice versa), the worklet URL resolution is wrong — fix it before continuing.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/PauseNote.jsx client/src/components/PauseNote.test.jsx client/src/components/__a11y__.test.jsx client/src/App.jsx
git commit -m "feat(prosody): render the per-turn pause note under the conversation"
```

**SLICE 1 GATE — all must hold before Task 10:**
- Worklet emits in **both** `vite dev` and `vite build`.
- All pre-existing hook tests pass with the third `vi.mock` in place.
- `coverage.include` was extended in the same commit as the first prosody test.
- The Task 8 test *"does not clear the frame buffer when the recognizer auto-restarts mid-turn"* passes — `resetFrames()` is called only from `startListening`, never from `handleRecognizerEnd`.

---

# SLICE 2 — PERSISTENCE SPINE

---

### Task 10: Split the app from the listener, add a server test runner

**Files:**
- Create: `server/src/app.js`
- Create: `server/vitest.config.js`
- Create: `server/test/global-setup.js`
- Create: `server/test/health.test.js`
- Modify: `server/src/index.js`
- Modify: `server/package.json:6-12`
- Modify: `package.json:7-15` (root)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const app` from `server/src/app.js`. Every later server test imports it.

**Why first:** `server/src/index.js:8` creates the app and `:32` calls `app.listen(PORT)` at module scope with **no export** — importing it in a test binds port 3001. Six lines of change, and it blocks every server test until done.

- [ ] **Step 1: Add the test runner and scripts**

Run: `npm --prefix server install -D vitest@^4.1.10`

Modify `server/package.json` scripts to:

```json
  "scripts": {
    "dev": "node --env-file=.env --watch src/index.js",
    "start": "node --env-file=.env src/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:studio": "prisma studio"
  },
```

Modify the root `package.json` scripts — add after `"dev:client"`:

```json
    "test": "npm --prefix client test && npm --prefix server test",
```

- [ ] **Step 2: Write the failing test**

Create `server/test/health.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";

/**
 * Port 0 gets an ephemeral port from the OS, so tests never collide with a
 * running dev server. Node's global fetch means no supertest dependency.
 */
let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("GET /health", () => {
  it("reports every provider slot", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("brain");
    expect(body).toHaveProperty("tts");
    expect(body).toHaveProperty("stt");
  });
});

describe("POST /turn", () => {
  it("rejects a missing utterance with 400", async () => {
    const res = await fetch(`${base}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix server test`
Expected: FAIL — `Failed to resolve import "../src/app.js"`.

- [ ] **Step 4: Split the module**

Create `server/src/app.js` with everything from today's `index.js` except the listener:

```js
import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";

/**
 * Builds the Express app but never listens — so tests can import it and bind
 * an ephemeral port. index.js owns the listener.
 */
export const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    brain: currentProvider(),
    tts: currentTTSProvider(),
    stt: currentSTTProvider(),
    ts: Date.now(),
  });
});

app.use("/turn", turnRouter);

// Fallback error handler so nothing crashes the single-user server.
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});
```

Replace the whole of `server/src/index.js` with:

```js
import { app } from "./app.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()})`,
  );
});
```

- [ ] **Step 5: Configure Vitest for the server**

Create `server/vitest.config.js`:

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["./test/global-setup.js"],
    // Prisma's SQLite path is resolved relative to the schema directory,
    // so this lands at server/prisma/test.db.
    env: { DATABASE_URL: "file:./test.db" },
  },
});
```

Create `server/test/global-setup.js`:

```js
import { execSync } from "node:child_process";

/**
 * Pushes the schema into a throwaway SQLite file before the suite runs.
 * `db push` rather than `migrate deploy` — the test DB has no history to keep,
 * and this stays correct while the schema is still moving.
 */
export default function setup() {
  execSync("npm exec -- prisma db push --skip-generate --accept-data-loss", {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "inherit",
  });
}
```

Modify `.gitignore` — add under the sqlite section:

```
server/prisma/test.db
server/prisma/test.db-journal
server/.data/
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --prefix server test`
Expected: PASS, 2 tests. The `prisma db push` output appears first.

- [ ] **Step 7: Verify the dev server still boots**

Run: `npm --prefix server run dev`
Expected: `[server] SpeakUp API → http://localhost:3001 …`. Stop it with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add server/src/app.js server/src/index.js server/vitest.config.js server/test package.json server/package.json server/package-lock.json .gitignore
git show :server/src/index.js
git commit -F - <<'EOF'
test(server): split app from listener and add a Vitest harness

index.js called app.listen() at module scope with no export, so importing it
in a test bound port 3001. app.js now builds and exports the app; index.js
only listens. Tests bind port 0 and use global fetch, so no supertest.
EOF
```

---

### Task 11: Prisma comes alive — `Session` and `Turn`

**Files:**
- Create: `server/src/db.js`
- Create: `server/src/repo/session.js`
- Create: `server/test/session-repo.test.js`
- Modify: `server/prisma/schema.prisma:20-30`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getPrisma(): PrismaClient`
  - `startSession(): Promise<{id: string}>`
  - `recordTurn({sessionId, role, text, xp, prosody}): Promise<{id: string}>` — `prosody` is a plain object, JSON-encoded on the way in.
  - `getSessionWithTurns(id): Promise<Session & {turns: Turn[]}>`

- [ ] **Step 1: Add the prosody column**

Modify `server/prisma/schema.prisma` — the `Turn` model becomes:

```prisma
model Turn {
  id         String   @id @default(cuid())
  sessionId  String
  session    Session  @relation(fields: [sessionId], references: [id])
  role       String // "coach" | "user"
  text       String
  fluency    Int?
  confidence Int?
  xp         Int?
  // JSON-encoded pause profile. String rather than Json so the SQLite
  // connector's Json capability is not a migrate-time risk; the volume here is
  // a handful of counts per turn. Slice 4 decides for PronAttempt with data.
  prosody    String?
  createdAt  DateTime @default(now())
}
```

- [ ] **Step 2: Write the failing test**

Create `server/test/session-repo.test.js`:

```js
import { describe, it, expect, afterAll } from "vitest";
import { startSession, recordTurn, getSessionWithTurns } from "../src/repo/session.js";
import { getPrisma } from "../src/db.js";

afterAll(() => getPrisma().$disconnect());

describe("session repo", () => {
  it("creates a session and reads it back with no turns", async () => {
    const s = await startSession();
    expect(s.id).toBeTruthy();
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns).toEqual([]);
  });

  it("records turns in order", async () => {
    const s = await startSession();
    await recordTurn({ sessionId: s.id, role: "user", text: "hello" });
    await recordTurn({ sessionId: s.id, role: "coach", text: "hi there", xp: 5 });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns.map((t) => t.role)).toEqual(["user", "coach"]);
    expect(loaded.turns[1].xp).toBe(5);
  });

  it("round-trips the prosody payload as an object", async () => {
    const s = await startSession();
    const counts = { total: 4, internal: 3, boundary: 1, unknown: 0 };
    await recordTurn({ sessionId: s.id, role: "user", text: "hmm", prosody: counts });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].prosody).toEqual(counts);
  });

  it("stores null prosody when none was supplied", async () => {
    const s = await startSession();
    await recordTurn({ sessionId: s.id, role: "coach", text: "sure" });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].prosody).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix server test -- test/session-repo.test.js`
Expected: FAIL — `Failed to resolve import "../src/repo/session.js"`.

- [ ] **Step 4: Write the implementation**

Create `server/src/db.js`:

```js
import { PrismaClient } from "@prisma/client";

/** Lazy singleton — the client is expensive and the server is single-user. */
let _prisma = null;

export function getPrisma() {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}
```

Create `server/src/repo/session.js`:

```js
import { getPrisma } from "../db.js";

/**
 * The only module that writes Session/Turn. Keeping the JSON encode/decode of
 * `prosody` here means no caller ever sees a string where it expects counts.
 */

export async function startSession() {
  return getPrisma().session.create({ data: {} });
}

export async function recordTurn({ sessionId, role, text, xp = null, prosody = null }) {
  return getPrisma().turn.create({
    data: { sessionId, role, text, xp, prosody: prosody ? JSON.stringify(prosody) : null },
  });
}

export async function getSessionWithTurns(id) {
  const session = await getPrisma().session.findUnique({
    where: { id },
    include: { turns: { orderBy: { createdAt: "asc" } } },
  });
  if (!session) return null;
  return { ...session, turns: session.turns.map(decodeTurn) };
}

function decodeTurn(turn) {
  return { ...turn, prosody: turn.prosody ? JSON.parse(turn.prosody) : null };
}
```

- [ ] **Step 5: Regenerate the client and run tests**

```bash
npm --prefix server run prisma:generate
npm --prefix server test
```
Expected: PASS, 6 tests total.

- [ ] **Step 6: Create the dev migration**

Run: `npm --prefix server run prisma:migrate`
When prompted for a name, enter: `turn_prosody`
Expected: a new folder under `server/prisma/migrations/`.

- [ ] **Step 7: Record the `Json` finding for slice 4**

Append to `docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md` (or create `docs/superpowers/spikes/2026-07-26-prisma-sqlite-json.md` if you prefer it separate):

> **Prisma + SQLite `Json`:** `Turn.prosody` shipped as `String?`. Before slice 4 defines `PronAttempt`, test whether `Json` works on this connector version by adding a scratch model and running `prisma db push`. Record the answer here so §9.1's `captureSettings Json` / `metrics Json?` is a decision, not a hope.

- [ ] **Step 8: Commit**

```bash
git add server/src/db.js server/src/repo server/test/session-repo.test.js server/prisma/schema.prisma server/prisma/migrations docs/superpowers/spikes
git show :server/prisma/schema.prisma | grep -n prosody
git commit -m "feat(server): first Prisma writes — Session, Turn, and a prosody column"
```

---

### Task 12: Persist a real conversation

**Files:**
- Modify: `server/src/routes/turn.js:52-69`
- Modify: `client/src/lib/api.js:3-15`
- Modify: `client/src/hooks/useConversation.js`
- Create: `server/test/turn-persistence.test.js`

**Interfaces:**
- Consumes: `startSession` / `recordTurn` (Task 11), `sessionPauseCounts` (Task 8).
- Produces: `POST /turn` now accepts an optional `sessionId` and `prosody`, and returns `sessionId`. The client holds the id for the life of the tab.

- [ ] **Step 1: Write the failing test**

Create `server/test/turn-persistence.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getSessionWithTurns } from "../src/repo/session.js";
import { getPrisma } from "../src/db.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await getPrisma().$disconnect();
});

async function turn(body) {
  const res = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /turn persistence", () => {
  it("opens a session on the first turn and returns its id", async () => {
    const { status, body } = await turn({ utterance: "hello" });
    expect(status).toBe(200);
    expect(body.sessionId).toBeTruthy();
  });

  it("writes both the user turn and the coach reply", async () => {
    const { body } = await turn({ utterance: "hello" });
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns.map((t) => t.role)).toEqual(["user", "coach"]);
    expect(session.turns[0].text).toBe("hello");
  });

  it("reuses the session id it is given instead of opening a new one", async () => {
    const first = await turn({ utterance: "one" });
    const second = await turn({ utterance: "two", sessionId: first.body.sessionId });
    expect(second.body.sessionId).toBe(first.body.sessionId);
    const session = await getSessionWithTurns(first.body.sessionId);
    expect(session.turns).toHaveLength(4);
  });

  it("stores the prosody counts on the user turn only", async () => {
    const counts = { total: 5, internal: 4, boundary: 1, unknown: 2 };
    const { body } = await turn({ utterance: "hmm well", prosody: counts });
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns[0].prosody).toEqual(counts);
    expect(session.turns[1].prosody).toBeNull();
  });

  it("still answers when the session id does not exist — the loop never breaks on a DB miss", async () => {
    const { status, body } = await turn({ utterance: "hello", sessionId: "does-not-exist" });
    expect(status).toBe(200);
    expect(body.coach_reply).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- test/turn-persistence.test.js`
Expected: FAIL — `body.sessionId` is `undefined`.

- [ ] **Step 3: Persist inside the route**

Modify `server/src/routes/turn.js`. Add to the import block after line 5:

```js
import { startSession, recordTurn } from "../repo/session.js";
```

Replace the `router.post("/", …)` handler (lines 52-69) with:

```js
router.post("/", async (req, res) => {
  const { utterance, history, sessionId, prosody } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  try {
    const result = await runTurn(utterance.trim(), history);
    // Persistence must never break the loop: a DB failure costs us a row,
    // not the learner's turn.
    const persistedId = await persistTurn({ sessionId, utterance: utterance.trim(), prosody, result });
    return res.json({ ...result, sessionId: persistedId });
  } catch (err) {
    console.error("[turn] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }
});

async function persistTurn({ sessionId, utterance, prosody, result }) {
  try {
    let id = sessionId;
    if (!id) id = (await startSession()).id;
    await recordTurn({ sessionId: id, role: "user", text: utterance, prosody: prosody ?? null });
    await recordTurn({ sessionId: id, role: "coach", text: result.coach_reply, xp: result.xp ?? null });
    return id;
  } catch (dbErr) {
    console.warn("[turn] persistence failed, continuing:", dbErr.message);
    return sessionId ?? null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix server test`
Expected: PASS, 11 tests total.

> **Note on the "session id does not exist" test:** `recordTurn` will reject on the foreign key, `persistTurn` swallows it, and the turn still returns 200. That is the intended behaviour — degrade, never break.

- [ ] **Step 5: Send the id and the counts from the client**

Modify `client/src/lib/api.js` — replace `postTurn` (lines 3-15) with:

```js
export async function postTurn({ utterance, history, sessionId, prosody }) {
  const res = await fetch("/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance, history, sessionId, prosody }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error ${res.status}`);
  }
  return res.json(); // { coach_reply, xp, audio?, audioFormat?, ttsProvider, sessionId }
}
```

Modify `client/src/hooks/useConversation.js`:

Add a ref beside the others (after line 46):

```js
  const sessionIdRef = useRef(null);
  const lastTurnProsodyRef = useRef(null);
```

In `computePauseProfile`, capture the per-turn counts for the next `postTurn` — add before `setPauseNote(...)`:

```js
    lastTurnProsodyRef.current = counts;
```

In `runTurn` (line 100), pass and store the id:

```js
      const { coach_reply, xp, audio, audioFormat, sessionId } = await postTurn({
        utterance,
        history: [...historyBefore, userMsg],
        sessionId: sessionIdRef.current,
        prosody: lastTurnProsodyRef.current,
      });
      if (sessionId) sessionIdRef.current = sessionId;
      lastTurnProsodyRef.current = null;
```

- [ ] **Step 6: Run the client suite**

Run: `npm --prefix client test`
Expected: PASS. The hook tests mock `postTurn`, so the extra fields are inert there.

- [ ] **Step 7: Verify end to end**

```bash
npm run dev
```
Speak two turns, then:
```bash
npm --prefix server run prisma:studio
```
Confirm one `Session` row with four `Turn` rows, and `prosody` populated on the user turns.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/turn.js server/test/turn-persistence.test.js client/src/lib/api.js client/src/hooks/useConversation.js
git show :server/src/routes/turn.js | grep -n persistTurn
git commit -F - <<'EOF'
feat(server): persist Session and Turn, including the pause profile

Persistence is wrapped so a DB failure costs a row, not the learner's turn —
the same degrade-never-break rule the TTS path already follows.
EOF
```

**SLICE 2 GATE — before Task 13:** `npm test` at the repo root runs both suites green, and a real conversation writes a `Session` with its `Turn`s.

---

# SLICE 3 — SIDECAR WALKING SKELETON

No metrics, no UI. Proves the transport contract and the degrade path.

> **Stop here** if K1 (Task 2) did not produce a phone tier. Take the §3.1/C1 branch, record it in the spec's §3 table, and ship slices 1–2 as M7.

---

### Task 13: The pronunciation factory

**Files:**
- Create: `server/src/pronunciation/index.js`
- Create: `server/src/pronunciation/mock.js`
- Create: `server/test/pron-factory.test.js`
- Modify: `server/src/app.js` (health payload)
- Modify: `server/test/health.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getPron(): {score(pcmBuffer, referenceText): Promise<object>} | null`
  - `currentPronProvider(): "local" | "mock" | "none"`
  - `__resetForTests(): void`

**Two deliberate divergences from the `brain|tts|stt` factories:** `none` is a first-class degraded state rather than an error, and the module exposes `__resetForTests()` so the resolve-once cache can be cleared without module mocking. Spec §4.4.

- [ ] **Step 1: Write the failing test**

Create `server/test/pron-factory.test.js`:

```js
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPron, currentPronProvider, __resetForTests } from "../src/pronunciation/index.js";

const ORIGINAL = process.env.PRONUNCIATION_PROVIDER;

beforeEach(() => { __resetForTests(); });
afterAll(() => { process.env.PRONUNCIATION_PROVIDER = ORIGINAL; });

describe("pronunciation factory", () => {
  it("defaults to none when nothing is configured", () => {
    delete process.env.PRONUNCIATION_PROVIDER;
    expect(currentPronProvider()).toBe("none");
    expect(getPron()).toBeNull();
  });

  it("returns a scorer for the mock provider", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    expect(currentPronProvider()).toBe("mock");
    const result = await getPron().score(Buffer.alloc(16), "hello world");
    expect(result.scored).toBe(true);
    expect(result.words.map((w) => w.word)).toEqual(["hello", "world"]);
  });

  it("gives the mock provider stress digits, because that is the whole point of the phone tier", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const result = await getPron().score(Buffer.alloc(16), "hello");
    expect(result.words[0].phones.some((p) => /[012]$/.test(p.label))).toBe(true);
  });

  it("is deterministic — the same input twice gives byte-identical output", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const a = await getPron().score(Buffer.alloc(16), "hello world");
    const b = await getPron().score(Buffer.alloc(16), "hello world");
    expect(a).toEqual(b);
  });

  it("treats an unknown provider name as none rather than throwing", () => {
    process.env.PRONUNCIATION_PROVIDER = "nonsense";
    expect(currentPronProvider()).toBe("none");
    expect(getPron()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- test/pron-factory.test.js`
Expected: FAIL — `Failed to resolve import "../src/pronunciation/index.js"`.

- [ ] **Step 3: Write the mock provider**

Create `server/src/pronunciation/mock.js`:

```js
/**
 * Deterministic scorer. Exists so the server suite never needs Docker, and so
 * the client can be developed against a stable payload shape.
 *
 * The phone labels carry ARPAbet stress digits because that is precisely what
 * english_us_arpa gives us for free and what M-LEX/M3 read (spec §5.1).
 */

const PHONES_PER_SYLLABLE = 3;
const MS_PER_PHONE = 80;

export class MockPronunciation {
  async score(_pcm, referenceText) {
    const words = String(referenceText).trim().split(/\s+/).filter(Boolean);
    let cursor = 0;
    return {
      scored: true,
      provider: "mock",
      referenceText,
      words: words.map((word, wordIndex) => {
        const syllables = Math.max(1, Math.ceil(word.length / 3));
        const phones = [];
        for (let s = 0; s < syllables; s += 1) {
          for (let p = 0; p < PHONES_PER_SYLLABLE; p += 1) {
            phones.push({
              label: p === 1 ? `AH${s === 0 ? 1 : 0}` : "T",
              startMs: cursor,
              endMs: cursor + MS_PER_PHONE,
            });
            cursor += MS_PER_PHONE;
          }
        }
        return {
          word,
          wordIndex,
          startMs: phones[0].startMs,
          endMs: phones[phones.length - 1].endMs,
          phones,
        };
      }),
    };
  }
}
```

- [ ] **Step 4: Write the factory**

Create `server/src/pronunciation/index.js`:

```js
import { MockPronunciation } from "./mock.js";
import { LocalPronunciation } from "./local.js";

/**
 * Pluggable pronunciation factory, matching brain/ tts/ stt/ — with two
 * deliberate differences (spec §4.4):
 *   1. `none` is a first-class degraded state, not an error.
 *   2. __resetForTests() clears the resolve-once cache, so the suite needs no
 *      module mocking.
 *
 * There is NO health probe and no re-probe timer. Reachability is reported by
 * the score call itself returning { scored: false, reason: 'scorer-offline' },
 * which is how starting Docker mid-session works for free: the next attempt
 * simply succeeds.
 */
let _initialized = false;
let _pron = null;
let _provider = null;

function resolveProvider() {
  const raw = process.env.PRONUNCIATION_PROVIDER?.trim().toLowerCase() || "none";
  return ["local", "mock", "none"].includes(raw) ? raw : "none";
}

export function getPron() {
  if (_initialized) return _pron;
  _provider = resolveProvider();
  _pron =
    _provider === "local"
      ? new LocalPronunciation()
      : _provider === "mock"
        ? new MockPronunciation()
        : null;
  _initialized = true;
  console.log(`[pron] provider = ${_provider}`);
  return _pron;
}

export function currentPronProvider() {
  if (!_initialized) getPron();
  return _provider;
}

export function __resetForTests() {
  _initialized = false;
  _pron = null;
  _provider = null;
}
```

- [ ] **Step 5: Write the local provider stub**

Create `server/src/pronunciation/local.js`:

```js
/**
 * HTTP client for the MFA sidecar. Unreachable and timed-out are the SAME
 * outcome: `{ scored: false, reason: 'scorer-offline' }`. Callers never see an
 * exception for a container being down — that is a normal state, not an error.
 */

const DEFAULT_TIMEOUT_MS = 30_000; // a cold align_one is plausibly 4-10s (spec §4.5)

export class LocalPronunciation {
  constructor({ baseUrl = process.env.PRON_SIDECAR_URL || "http://127.0.0.1:7654", timeoutMs = Number(process.env.PRON_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async score(pcmBuffer, referenceText) {
    const form = new FormData();
    form.append("audio", new Blob([pcmBuffer], { type: "audio/wav" }), "attempt.wav");
    form.append("text", referenceText);

    try {
      const res = await fetch(`${this.baseUrl}/align`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 503) return { scored: false, reason: "scorer-busy" };
      if (!res.ok) return { scored: false, reason: "scorer-error", status: res.status };
      const data = await res.json();
      return { scored: true, provider: "local", referenceText, words: data.words ?? [] };
    } catch {
      // Connect-refused, DNS, abort-on-timeout — all one state to the caller.
      return { scored: false, reason: "scorer-offline" };
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --prefix server test -- test/pron-factory.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Add the pill to /health**

Modify `server/src/app.js` — add the import:

```js
import { currentPronProvider } from "./pronunciation/index.js";
```

and add `pron: currentPronProvider(),` to the `/health` JSON body, after `stt`.

Modify `server/test/health.test.js` — add `expect(body).toHaveProperty("pron");` to the health assertion.

- [ ] **Step 8: Run the full server suite**

Run: `npm --prefix server test`
Expected: PASS, 16 tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/pronunciation server/src/app.js server/test/pron-factory.test.js server/test/health.test.js
git show :server/src/pronunciation/index.js | head -25
git commit -m "feat(server): pronunciation provider factory with none as a first-class state"
```

---

### Task 14: The sidecar image

**Files:**
- Create: `sidecar/Dockerfile`
- Create: `sidecar/app.py`
- Create: `sidecar/entrypoint.sh`
- Create: `sidecar/.dockerignore`
- Create: `docker-compose.yml`
- Create: `THIRD-PARTY-NOTICES.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the K1 findings doc — the working PostgreSQL incantation and the exact pip/python path go into this Dockerfile.
- Produces: `GET /healthz` → `{ok: true}` and `POST /align` (multipart `audio` + form field `text`) → `{words: [{word, wordIndex, startMs, endMs, phones: [{label, startMs, endMs}]}]}`.

- [ ] **Step 1: Write the FastAPI app**

Create `sidecar/app.py`:

```python
"""
MFA sidecar. One asyncio lock: alignment is CPU-bound and MFA holds a database,
so concurrent requests are refused rather than queued (spec 4.5).
"""
import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

app = FastAPI()
LOCK = asyncio.Lock()

DICTIONARY = os.environ.get("MFA_DICT", "english_us_arpa")
ACOUSTIC = os.environ.get("MFA_ACOUSTIC", "english_us_arpa")


@app.get("/healthz")
def healthz():
    return {"ok": True, "dictionary": DICTIONARY, "acoustic": ACOUSTIC}


@app.post("/align")
async def align(response: Response, audio: UploadFile = File(...), text: str = Form(...)):
    if LOCK.locked():
        raise HTTPException(status_code=503, detail="busy", headers={"Retry-After": "1"})

    async with LOCK:
        with tempfile.TemporaryDirectory(dir="/tmp/mfa") as work:
            wav = Path(work) / "attempt.wav"
            lab = Path(work) / "attempt.txt"
            out = Path(work) / "attempt.json"
            wav.write_bytes(await audio.read())
            lab.write_text(text, encoding="utf-8")

            proc = subprocess.run(
                ["mfa", "align_one", str(wav), str(lab), DICTIONARY, ACOUSTIC,
                 str(out), "--output_format", "json", "--clean"],
                capture_output=True, text=True,
            )
            if proc.returncode != 0 or not out.exists():
                raise HTTPException(status_code=500, detail=proc.stderr[-2000:] or "alignment failed")

            return {"words": _to_words(json.loads(out.read_text(encoding="utf-8")))}


def _to_words(doc):
    """MFA emits seconds and separate word/phone tiers; we emit ms and nest."""
    tiers = doc.get("tiers", {})
    words = tiers.get("words", {}).get("entries", [])
    phones = tiers.get("phones", {}).get("entries", [])

    out = []
    for index, (start, end, label) in enumerate(words):
        if not label:
            continue
        nested = [
            {"label": p_label, "startMs": round(p_start * 1000), "endMs": round(p_end * 1000)}
            for p_start, p_end, p_label in phones
            if p_start >= start and p_end <= end and p_label
        ]
        out.append({
            "word": label,
            "wordIndex": index,
            "startMs": round(start * 1000),
            "endMs": round(end * 1000),
            "phones": nested,
        })
    return out
```

- [ ] **Step 2: Write the entrypoint**

Create `sidecar/entrypoint.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail

# The official image starts PostgreSQL only from ~/.bashrc, which an ENTRYPOINT
# never sources. Use whichever line K1 proved works, and delete the other.
mfa server start || mfa configure --disable_auto_server

mkdir -p /tmp/mfa
exec uvicorn app:app --host 0.0.0.0 --port 7654 --app-dir /srv
```

- [ ] **Step 3: Write the Dockerfile**

Create `sidecar/Dockerfile` — substitute the pip path recorded in K1 Step 7 if it differs:

```dockerfile
FROM mmcauliffe/montreal-forced-aligner:v3.3.9

USER root
ENV MFA_ROOT_DIR=/mfa

# Models are baked at BUILD time so the running container needs no network.
RUN pip install --no-cache-dir fastapi uvicorn python-multipart \
 && mfa server init \
 && mfa model download acoustic english_us_arpa \
 && mfa model download dictionary english_us_arpa

COPY app.py /srv/app.py
COPY entrypoint.sh /srv/entrypoint.sh
RUN chmod +x /srv/entrypoint.sh && mkdir -p /tmp/mfa

EXPOSE 7654
ENTRYPOINT ["/srv/entrypoint.sh"]
```

Create `sidecar/.dockerignore`:

```
sample/
*.md
```

- [ ] **Step 4: Write the compose file**

Create `docker-compose.yml` at the repo root:

```yaml
services:
  pron-sidecar:
    build: ./sidecar
    # Loopback only — never 0.0.0.0.
    ports:
      - "127.0.0.1:7654:7654"
    volumes:
      # A NAMED volume, never a Windows bind mount: MFA runs PostgreSQL under
      # MFA_ROOT_DIR and PG socket/lock behaviour on WSL2 bind mounts is exactly
      # what breaks.
      - mfa_root:/mfa
      - mfa_tmp:/tmp/mfa
    restart: "no"

volumes:
  mfa_root:
  mfa_tmp:
```

- [ ] **Step 5: Build and smoke test**

```bash
docker compose build pron-sidecar
docker compose up -d pron-sidecar
curl -s http://127.0.0.1:7654/healthz
```
Expected: `{"ok":true,"dictionary":"english_us_arpa","acoustic":"english_us_arpa"}`

Then align the K1 fixture:

```bash
curl -s -F "audio=@sidecar/sample/hello.wav" -F "text=I've been thinking about it all week" http://127.0.0.1:7654/align | head -c 600
```
Expected: JSON with a `words` array whose `phones[].label` values carry stress digits (`AY1`, `AH0`, …).

- [ ] **Step 6: Test the egress claim, and record the truth**

The spec claims `audioLeftDevice` is *architecturally* enforced (§10). Verify it rather than assert it:

```bash
docker compose exec pron-sidecar bash -lc "curl -s -m 5 https://example.com > /dev/null && echo REACHABLE || echo BLOCKED"
```

- If it prints `BLOCKED`, note that in the notices file.
- If it prints `REACHABLE`, try adding an `internal: true` network to `docker-compose.yml`, rebuild, and re-run **both** this check and Step 5's `curl` from the host. If publishing a port stops working on an internal network, revert it and **write in `docs/superpowers/spikes/2026-07-26-K1-mfa-wsl2.md`**: *"`audioLeftDevice` is currently a convention (models baked, no outbound calls made), not an enforced boundary. Spec §10 is not yet met."* Do not leave the spec claiming something the architecture does not do.

- [ ] **Step 7: Ship the attribution**

Create `THIRD-PARTY-NOTICES.md`:

```markdown
# Third-party notices

## Montreal Forced Aligner
MIT License. <https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner>
Pinned to `v3.3.9`.

## english_us_arpa acoustic model and pronunciation dictionary (v3.0.0)
**Creative Commons Attribution 4.0 International (CC BY 4.0).**
<https://mfa-models.readthedocs.io>
Trained on LibriSpeech. Used unmodified for forced alignment. Full licence:
<https://creativecommons.org/licenses/by/4.0/>
```

Modify `README.md` — add a line in the Architecture section linking to it:

```markdown
Third-party attributions: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
```

- [ ] **Step 8: Commit**

```bash
git add sidecar docker-compose.yml THIRD-PARTY-NOTICES.md README.md
git show :sidecar/Dockerfile
git commit -F - <<'EOF'
feat(sidecar): MFA v3.3.9 aligner behind FastAPI

Models baked at build time so the container needs no network. MFA_ROOT_DIR
lives on a named volume, never a Windows bind mount — PG socket behaviour on
WSL2 bind mounts is the documented failure. Ships CC BY 4.0 attribution for
english_us_arpa.
EOF
```

---

### Task 15: `POST /pron/score` end to end

**Files:**
- Create: `server/src/routes/pron.js`
- Create: `server/test/pron-route.test.js`
- Create: `client/src/lib/pron.js`
- Create: `client/src/lib/pron.test.js`
- Modify: `server/src/app.js`
- Modify: `client/vite.config.js:10-14`

**Interfaces:**
- Consumes: `getPron()` (Task 13), the sidecar (Task 14).
- Produces: `POST /pron/score` (multipart: `audio` file + `text` field) → the provider's result, or `{scored: false, reason}`. Client: `scorePronunciation({blob, referenceText}) => Promise<object>`.

**Why multipart, not JSON:** `server/src/app.js` caps JSON at 1 MB, and the catch-all error handler swallows `err.status` — so a 413 would surface as a bare 500. `multer` is already a dependency.

- [ ] **Step 1: Write the failing test**

Create `server/test/pron-route.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../src/app.js";
import { __resetForTests } from "../src/pronunciation/index.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { __resetForTests(); });

async function post({ text, audio = new Blob([new Uint8Array(64)]) } = {}) {
  const form = new FormData();
  if (audio) form.append("audio", audio, "attempt.wav");
  if (text !== undefined) form.append("text", text);
  const res = await fetch(`${base}/pron/score`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

describe("POST /pron/score", () => {
  it("reports scorer-offline rather than an error when no provider is configured", async () => {
    delete process.env.PRONUNCIATION_PROVIDER;
    const { status, body } = await post({ text: "hello world" });
    expect(status).toBe(200);
    expect(body).toEqual({ scored: false, reason: "scorer-offline" });
  });

  it("returns a phone tier from the mock provider", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const { status, body } = await post({ text: "hello world" });
    expect(status).toBe(200);
    expect(body.scored).toBe(true);
    expect(body.words).toHaveLength(2);
  });

  it("rejects a request with no reference text", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const { status } = await post({ text: undefined });
    expect(status).toBe(400);
  });

  it("rejects a request with no audio", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const { status } = await post({ text: "hello", audio: null });
    expect(status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- test/pron-route.test.js`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Write the route**

Create `server/src/routes/pron.js`:

```js
import { Router } from "express";
import multer from "multer";
import { getPron } from "../pronunciation/index.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/**
 * POST /pron/score
 * multipart: audio (16kHz mono WAV), text (the reference sentence)
 *
 * A missing or unreachable scorer is NOT an error — it is a normal state that
 * the UI renders as an unscored card, the same way a dead TTS falls back to
 * the browser voice. So this always answers 200 for a well-formed request.
 */
router.post("/score", upload.single("audio"), async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: 'Missing "text" (the reference sentence).' });
  }
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: 'Missing "audio" file.' });
  }

  const pron = getPron();
  if (!pron) return res.json({ scored: false, reason: "scorer-offline" });

  try {
    return res.json(await pron.score(req.file.buffer, text.trim()));
  } catch (err) {
    console.warn("[pron] scorer threw, reporting offline:", err.message);
    return res.json({ scored: false, reason: "scorer-offline" });
  }
});

export default router;
```

Modify `server/src/app.js` — add the import and mount it beside `/turn`:

```js
import pronRouter from "./routes/pron.js";
```
```js
app.use("/pron", pronRouter);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix server test`
Expected: PASS, 20 tests.

- [ ] **Step 5: Add the client wrapper with a failing test**

Create `client/src/lib/pron.test.js`:

```js
import { describe, it, expect, vi, afterEach } from "vitest";
import { scorePronunciation } from "./pron.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("scorePronunciation", () => {
  it("posts multipart to /pron/score", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ scored: true, words: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await scorePronunciation({ blob: new Blob([new Uint8Array(8)]), referenceText: "hello" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/pron/score");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("degrades to scorer-offline instead of throwing when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(scorePronunciation({ blob: new Blob(), referenceText: "hello" }))
      .resolves.toEqual({ scored: false, reason: "scorer-offline" });
  });

  it("degrades on a non-ok response too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(scorePronunciation({ blob: new Blob(), referenceText: "hello" }))
      .resolves.toEqual({ scored: false, reason: "scorer-offline" });
  });
});
```

Run: `npm --prefix client test -- src/lib/pron.test.js`
Expected: FAIL — `Failed to resolve import "./pron.js"`.

- [ ] **Step 6: Write the client wrapper**

Create `client/src/lib/pron.js`:

```js
/**
 * Client for POST /pron/score. Mirrors the server contract: a dead scorer is a
 * normal state, never a thrown error, so callers render an unscored card
 * instead of an error banner.
 */
export async function scorePronunciation({ blob, referenceText }) {
  const form = new FormData();
  form.append("audio", blob, "attempt.wav");
  form.append("text", referenceText);

  try {
    const res = await fetch("/pron/score", { method: "POST", body: form });
    if (!res.ok) return { scored: false, reason: "scorer-offline" };
    return await res.json();
  } catch {
    return { scored: false, reason: "scorer-offline" };
  }
}
```

Run: `npm --prefix client test -- src/lib/pron.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 7: Add the proxy line and delete the dead one**

Modify `client/vite.config.js` — replace the `proxy` block:

```js
    proxy: {
      "/turn": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/pron": "http://localhost:3001",
    },
```

(`/progress` is removed — no such route exists.)

- [ ] **Step 8: Verify the degrade path by hand**

```bash
docker compose up -d pron-sidecar
PRONUNCIATION_PROVIDER=local npm --prefix server run dev
```
In another shell:
```bash
curl -s -F "audio=@sidecar/sample/hello.wav" -F "text=I've been thinking about it all week" http://localhost:3001/pron/score | head -c 400
```
Expected: `{"scored":true,...}` with a phone tier.

Now kill the container and repeat:
```bash
docker compose stop pron-sidecar
curl -s -F "audio=@sidecar/sample/hello.wav" -F "text=I've been thinking about it all week" http://localhost:3001/pron/score
```
Expected: `{"scored":false,"reason":"scorer-offline"}` — **200, not 500**, and the server stays up.

Start the container again and re-run the first curl **without restarting the server**. Expected: it succeeds. That is the whole point of having no cached health probe.

- [ ] **Step 9: Document the knobs**

Modify `server/.env.example` — append:

```
# Pronunciation scoring (M7). Unset or "none" = no scoring, and that is a
# supported state: the UI shows an unscored card, nothing errors.
#   none  -> no scorer (default)
#   mock  -> deterministic fake, no Docker needed
#   local -> the MFA sidecar (docker compose up -d pron-sidecar)
PRONUNCIATION_PROVIDER=none
PRON_SIDECAR_URL=http://127.0.0.1:7654
PRON_TIMEOUT_MS=30000
```

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/pron.js server/src/app.js server/test/pron-route.test.js client/src/lib/pron.js client/src/lib/pron.test.js client/vite.config.js server/.env.example
git show :client/vite.config.js
git commit -F - <<'EOF'
feat: POST /pron/score end to end, with offline as a normal state

A dead or absent scorer answers 200 with { scored: false, reason }, never an
exception — the same layering the TTS fallback already uses. There is no
health probe and no re-probe timer, which is why starting Docker mid-session
works without restarting the server.

Also drops the dead /progress proxy entry.
EOF
```

**SLICE 3 GATE:** a phone tier round-trips from the browser origin; killing the container yields `{scored:false, reason:'scorer-offline'}` and the UI stays alive; starting it again works with no server restart.

---

### Task 16: The stress lexicon

**Files:**
- Create: `server/scripts/build-stress-lexicon.js`
- Create: `server/src/curriculum/lexicon.js`
- Create: `server/test/lexicon.test.js`
- Create: `server/src/curriculum/stress-lexicon.json` (generated)
- Modify: `server/package.json` (script)

**Interfaces:**
- Consumes: the `english_us_arpa` dictionary inside the sidecar image (Task 14).
- Produces:
  - `lookupWord(word): {syllables: number, stressIndex: number} | null`
  - `isEchoEligible(sentence): boolean`
  - `daDaNotation(sentence): string | null` — e.g. `"da-DA-da-da-DA"`

**Why it exists:** three things need stress data **with the sidecar stopped** — echo eligibility, the `da-DA` notation plus the bolded model sentence, and M-LEX's expected stress index. Spec §6.2.

- [ ] **Step 1: Extract the dictionary from the image**

```bash
docker compose up -d pron-sidecar
docker compose exec pron-sidecar bash -lc "find /mfa -name '*.dict' -o -name 'english_us_arpa*' -type f | head"
```
Record the dictionary path, then copy it out:
```bash
docker compose cp pron-sidecar:<PATH_FROM_ABOVE> ./server/scripts/english_us_arpa.dict
```

- [ ] **Step 2: Write the failing test**

Create `server/test/lexicon.test.js`:

```js
import { describe, it, expect } from "vitest";
import { lookupWord, isEchoEligible, daDaNotation } from "../src/curriculum/lexicon.js";

describe("lookupWord", () => {
  it("returns syllable count and stress index for a known polysyllable", () => {
    const entry = lookupWord("comfortable");
    expect(entry.syllables).toBeGreaterThan(1);
    expect(entry.stressIndex).toBe(0);
  });

  it("is case insensitive", () => {
    expect(lookupWord("Comfortable")).toEqual(lookupWord("comfortable"));
  });

  it("returns null for a word that is not in the dictionary", () => {
    expect(lookupWord("zzqxwv")).toBeNull();
  });
});

describe("isEchoEligible", () => {
  it("accepts a sentence whose words all resolve and which has something to get wrong", () => {
    expect(isEchoEligible("I have been thinking about it")).toBe(true);
  });

  it("rejects a sentence containing an unknown word", () => {
    expect(isEchoEligible("I have been zzqxwv about it")).toBe(false);
  });

  it("rejects a sentence that is too short to be worth echoing", () => {
    expect(isEchoEligible("yes no")).toBe(false);
  });

  it("rejects a sentence that is too long to hold in one breath", () => {
    expect(isEchoEligible("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(false);
  });
});

describe("daDaNotation", () => {
  it("marks stressed syllables in upper case and unstressed in lower", () => {
    const n = daDaNotation("comfortable");
    expect(n).toMatch(/^(da|DA)(-(da|DA))*$/);
    expect(n.startsWith("DA")).toBe(true);
  });

  it("returns null when any word is unknown, so the UI never renders a half-truth", () => {
    expect(daDaNotation("zzqxwv word")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix server test -- test/lexicon.test.js`
Expected: FAIL — `Failed to resolve import "../src/curriculum/lexicon.js"`.

- [ ] **Step 4: Write the generator**

Create `server/scripts/build-stress-lexicon.js`:

```js
/**
 * Turns the MFA english_us_arpa dictionary into the runtime stress lexicon.
 *
 * Input lines look like:  COMFORTABLE  K AH1 M F ER0 T AH0 B AH0 L
 * A syllable nucleus is any phone ending in a stress digit; the stressed
 * syllable is the one carrying digit 1. Words with only secondary stress (2)
 * are skipped — spec §5.2 excludes them from v1 rather than modelling them.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SRC = new URL("./english_us_arpa.dict", import.meta.url);
const OUT = new URL("../src/curriculum/stress-lexicon.json", import.meta.url);

const NUCLEUS = /[012]$/;

const lexicon = {};
let skipped = 0;

for (const line of readFileSync(SRC, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [rawWord, ...rest] = line.trim().split(/\s+/);
  const word = rawWord.toLowerCase().replace(/\(\d+\)$/, ""); // drop variant markers
  if (lexicon[word]) continue; // first pronunciation wins

  const nuclei = rest.filter((p) => NUCLEUS.test(p));
  if (nuclei.length === 0) { skipped += 1; continue; }

  const stressIndex = nuclei.findIndex((p) => p.endsWith("1"));
  if (stressIndex === -1) { skipped += 1; continue; }

  lexicon[word] = { syllables: nuclei.length, stressIndex };
}

writeFileSync(OUT, JSON.stringify(lexicon));
console.log(`[lexicon] ${Object.keys(lexicon).length} words written, ${skipped} skipped`);
```

Add to `server/package.json` scripts:

```json
    "build:lexicon": "node scripts/build-stress-lexicon.js",
```

- [ ] **Step 5: Generate it**

Run: `npm --prefix server run build:lexicon`
Expected: `[lexicon] <N> words written, <M> skipped` with N in the low hundreds of thousands.

- [ ] **Step 6: Write the runtime module**

Create `server/src/curriculum/lexicon.js`:

```js
import lexicon from "./stress-lexicon.json" with { type: "json" };

/**
 * Stress data available with the sidecar stopped (spec §6.2): echo
 * eligibility, the da-DA notation, and M-LEX's expected stress index.
 */

/** UNCALIBRATED — short enough to hold in one breath, long enough to have rhythm. */
export const ECHO_MIN_WORDS = 4;
export const ECHO_MAX_WORDS = 12;

const WORD = /[a-z']+/gi;

export function lookupWord(word) {
  return lexicon[String(word).toLowerCase()] ?? null;
}

function wordsOf(sentence) {
  return String(sentence).match(WORD) ?? [];
}

/**
 * A line is offerable iff every word resolves AND there is something to be
 * right or wrong about. Any unknown word means no offer — silently.
 */
export function isEchoEligible(sentence) {
  const words = wordsOf(sentence);
  if (words.length < ECHO_MIN_WORDS || words.length > ECHO_MAX_WORDS) return false;

  const entries = words.map(lookupWord);
  if (entries.some((e) => e === null)) return false;
  return entries.some((e) => e.syllables > 1);
}

/** "da-DA-da-da-DA" — the notation an ELT teacher would draw, and it prints. */
export function daDaNotation(sentence) {
  const words = wordsOf(sentence);
  if (words.length === 0) return null;

  const beats = [];
  for (const word of words) {
    const entry = lookupWord(word);
    if (!entry) return null;
    for (let i = 0; i < entry.syllables; i += 1) {
      beats.push(i === entry.stressIndex ? "DA" : "da");
    }
  }
  return beats.join("-");
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm --prefix server test -- test/lexicon.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 8: Verify it works with the sidecar stopped**

```bash
docker compose stop pron-sidecar
npm --prefix server test -- test/lexicon.test.js
```
Expected: PASS. This is the whole point — the model step must render when the scorer is down.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: both client and server suites pass.

- [ ] **Step 10: Commit**

```bash
git add server/scripts/build-stress-lexicon.js server/src/curriculum server/test/lexicon.test.js server/package.json
git show :server/src/curriculum/lexicon.js | head -20
git commit -F - <<'EOF'
feat(curriculum): stress lexicon for echo eligibility and da-DA notation

Derived at build time from the MFA english_us_arpa dictionary, whose ARPAbet
labels already carry stress digits — so no G2P and no syllabifier are needed.
Works with the sidecar stopped, which is required: the model step must render
when the scorer is offline.
EOF
```

> **Note on `english_us_arpa.dict` in the repo:** it is CC BY 4.0, attributed in `THIRD-PARTY-NOTICES.md`. If its size is uncomfortable, add `server/scripts/english_us_arpa.dict` to `.gitignore` and treat Task 16 Step 1 as a prerequisite of `npm run build:lexicon` — but then the generated `stress-lexicon.json` **must** stay committed, or a clean checkout cannot build.

---

## Self-Review

**Spec coverage for the sections in scope:**

| Spec section | Covered by |
|---|---|
| §4.1 Free conversation path | Tasks 3–9 |
| §4.4 Provider factory | Task 13 |
| §4.5 Transport | Tasks 14–15 |
| §5.2 M1 (pause profile) | Tasks 3–5, 8 |
| §6.2 Stress lexicon | Task 16 |
| §7.4 Free-conversation surfacing | Tasks 5, 9 |
| §8.1 aria-live budget | Task 9 (PauseNote is outside the live region, asserted) |
| §9 Persistence | Tasks 10–12 |
| §10 Privacy | Task 14 Step 6 — **verified, not assumed** |
| §11 Attribution | Task 14 Step 7 |
| §12 Testing | Tasks 3 (coverage allowlist), 6 (worklet stubs), 10 (server runner) |
| §13 K1, K2 | Tasks 1–2 |
| §14 slices 1–3 + drive-by prompt patch | Tasks 3–16, Task 8 Step 5 |

**Known gaps, deliberately deferred to plan 2:** §5.2 M2–M6, §6.1 contrast inventory, §7.1–7.3 the Gym and echo loops, §8 visualisations B/C/D and the hum, §9.1 `PronAttempt`, §9.3 XP, K3 and K4. All belong to slices 4–8.

**Constraints not yet met, and where that is recorded:**
- `audioLeftDevice` architectural enforcement — Task 14 Step 6 requires writing down whichever outcome is true rather than letting the spec's claim stand unverified.
- Spec §12's `createRecognizer(track)` and `processLocally` — deviation D-c, deferred with the STT work.
- Spec §5.1's "vendored `pitchy`" — deviation D-b, moves to plan 2.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-accent-layer-phase0-slices1-3.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — tasks executed in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
