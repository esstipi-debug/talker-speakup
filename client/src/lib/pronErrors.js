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
