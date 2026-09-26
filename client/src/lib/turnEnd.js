/**
 * When has the learner finished their turn? (hands-free conversation)
 *
 * Web Speech gives no end-of-turn signal worth using: with `continuous=false`
 * Chrome cuts at the first pause, which is how this app behaved before the
 * July voice spec. So the hook times the silence itself — from the last
 * recognizer event that carried text — and this module decides how long that
 * silence must be.
 *
 * The costs are asymmetric, and the word list leans on that: a false
 * "unfinished" makes the learner wait two more seconds; a false "finished"
 * cuts them off mid-thought and the coach answers half an idea.
 */

/** UNCALIBRATED — chosen by the learner: silence that ends a turn which reads as complete. */
export const END_OF_TURN_SILENCE_MS = 2000;

/** UNCALIBRATED — chosen by the learner: the longer grace when the words so far dangle. */
export const DANGLING_SILENCE_MS = 4000;

/**
 * UNCALIBRATED — words an English sentence (almost) never ends on: articles,
 * possessive determiners, conjunctions, common prepositions, fillers. Left
 * out on purpose because they often DO end one: this/that, so, her, when,
 * while, though, like, and the auxiliaries (is, can, will…).
 */
const DANGLING_WORDS = new Set([
  "a", "an", "the",
  "my", "your", "his", "its", "our", "their",
  "and", "but", "or", "nor", "because", "although", "unless", "whereas",
  "of", "to", "with", "for", "from", "at", "in", "on", "about", "into", "onto", "than",
  "which", "whose", "i", "very",
  "um", "uh", "er", "erm", "uhm",
]);

/**
 * @param {string} [text] the words heard so far this turn
 * @returns {number} milliseconds of silence that end the turn
 */
export function silenceWindowMs(text) {
  const heard = String(text ?? "").trim().toLowerCase();
  if (heard.endsWith(",")) return DANGLING_SILENCE_MS;
  const lastWord = heard.match(/([a-z']+)[^a-z']*$/)?.[1];
  return lastWord && DANGLING_WORDS.has(lastWord) ? DANGLING_SILENCE_MS : END_OF_TURN_SILENCE_MS;
}
