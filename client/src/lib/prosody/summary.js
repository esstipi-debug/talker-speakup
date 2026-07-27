/**
 * Deterministic coach copy for the pause profile (spec §7.4, §8.4).
 * Templates only — never an LLM, which would invent numbers it wasn't given.
 * The string produced here is the SINGLE source: the visible caption, the one
 * live-region announcement and any aria-label summary all reuse it verbatim.
 */

/** UNCALIBRATED — below this the signal is indistinguishable from normal speech planning. */
export const MIN_INTERNAL_TO_SURFACE = 3;

/**
 * One turn. Returns null when there is nothing worth saying.
 * @param {{total: number, internal: number, boundary: number, unknown: number}} counts
 * @returns {string | null}
 */
export function pauseSentence(counts) {
  if (!counts || counts.internal < MIN_INTERNAL_TO_SURFACE) return null;
  const n = counts.internal;
  return `You broke mid-phrase ${n} ${n === 1 ? "time" : "times"} — let the breath land on the comma instead.`;
}

/**
 * End of session. Frames tomorrow rather than grading today.
 * @param {{total: number, internal: number, boundary: number, unknown: number}} counts
 * @returns {string | null}
 */
export function sessionPauseSentence(counts) {
  if (!counts || counts.internal < 1) return null;
  return `You broke mid-phrase ${counts.internal} times today. Tomorrow starts with chunking.`;
}
