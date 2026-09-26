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

/** The adaptive silence floor, or null when the buffer has no speech/silence contrast. */
function silenceFloor(framesDb, floorDropDb) {
  const sorted = Array.from(framesDb).sort((a, b) => a - b);
  const p95 = percentile(sorted, 0.95);
  const p05 = percentile(sorted, 0.05);
  if (p95 - p05 < MIN_DYNAMIC_RANGE_DB) return null;
  return p95 - floorDropDb;
}

/**
 * @param {Float32Array|number[]} framesDb per-hop RMS in dB
 * @param {{hopMs: number, minPauseMs?: number, floorDropDb?: number}} opts
 * @returns {Array<{startMs: number, endMs: number, durationMs: number}>}
 */
export function detectPauses(framesDb, { hopMs, minPauseMs = PAUSE_MIN_MS, floorDropDb = FLOOR_DROP_DB }) {
  const n = framesDb.length;
  if (!n || !hopMs) return [];

  const floor = silenceFloor(framesDb, floorDropDb);
  if (floor === null) return []; // no speech/silence contrast

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

/**
 * Milliseconds from the first voiced hop to the last — the stretch the learner
 * actually spent talking, pauses inside it included. Leading silence (waiting
 * to start) and trailing silence (waiting for the turn to end) fall outside
 * it; counting them is what made "elapsed minus pauses" overstate phonation.
 * Same floor as detectPauses, so the two always agree on what "silent" means.
 *
 * @param {Float32Array|number[]} framesDb per-hop RMS in dB
 * @param {{hopMs: number, floorDropDb?: number}} opts
 * @returns {number | null} null when there is no speech/silence contrast to measure
 */
export function voicedSpanMs(framesDb, { hopMs, floorDropDb = FLOOR_DROP_DB }) {
  if (!framesDb.length || !hopMs) return null;
  const floor = silenceFloor(framesDb, floorDropDb);
  if (floor === null) return null;

  let first = -1;
  let last = -1;
  for (let i = 0; i < framesDb.length; i += 1) {
    if (framesDb[i] >= floor) {
      if (first === -1) first = i;
      last = i;
    }
  }
  return (last - first + 1) * hopMs;
}

function pushIfLongEnough(pauses, startIdx, endIdx, hopMs, minPauseMs) {
  const durationMs = (endIdx - startIdx) * hopMs;
  if (durationMs >= minPauseMs) {
    pauses.push({ startMs: startIdx * hopMs, endMs: endIdx * hopMs, durationMs });
  }
}
