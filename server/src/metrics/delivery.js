/**
 * Objective delivery signals. No LLM judgement, no I/O, no clock — arithmetic
 * over data that already exists, so it can be tested against constructed
 * inputs with closed-form expectations (spec §6).
 */

/**
 * Spoken hesitation markers. "I mean" is deliberately NOT here — it is a
 * repair marker and lives in SELF_REPAIRS. Listing it in both would
 * double-count the same three words against the learner.
 */
const FILLERS = [
  /\byou know\b/gi, /\bsort of\b/gi, /\bkind of\b/gi,
  /\bum+\b/gi, /\buh+\b/gi, /\ber+\b/gi, /\bhmm+\b/gi, /\blike\b/gi,
];
/** Explicit self-repair markers — the learner audibly restarting. */
const SELF_REPAIRS = [/\bi mean\b/gi, /\bsorry,? no\b/gi, /\bno wait\b/gi, /\bthat is\b/gi];

/** de Jong & Wempe: below this, a per-turn rate is noise (spec §6.2). */
const MIN_PHONATION_MS = 5000;
/** Centre of the English articulation-rate band, syllables per second. */
const TARGET_SYLL_PER_SEC = 4.4;
/** Distance from target, in syll/s, at which the score reaches 0. */
const FLUENCY_HALF_WIDTH = 3.2;

/**
 * UNCALIBRATED — spec §11.1. Band edges on mid-phrase pauses + fillers +
 * self-repairs per 10 words. These are starting values, to be re-fitted
 * against the learner's own first sessions rather than defended as measured.
 * Same convention as PAUSE_NOTE_TURN_INTERVAL in useConversation.js.
 */
const SOME_PER_10W = 1.0;
const EFFORTFUL_PER_10W = 2.5;

export function computeDelivery({ text, prosody = null, sessionPhonationMs = 0, sessionSyllables = 0 }) {
  const words = countWords(text);
  const fillers = countMatches(text, FILLERS);
  const selfRepairs = countMatches(text, SELF_REPAIRS);
  const midPhrasePauses = prosody ? prosody.internal : 0;

  const per10w = words === 0 ? 0 : ((midPhrasePauses + fillers + selfRepairs) / words) * 10;
  const band = per10w >= EFFORTFUL_PER_10W ? "effortful" : per10w >= SOME_PER_10W ? "some" : "steady";

  return {
    hesitation: {
      band,
      basis: prosody ? "audio" : "text-only",
      midPhrasePauses,
      fillers,
      selfRepairs,
    },
    sessionFluency: articulationScore(sessionPhonationMs, sessionSyllables),
  };
}

function countWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function countMatches(text, patterns) {
  const source = String(text ?? "");
  return patterns.reduce((n, re) => n + (source.match(re)?.length ?? 0), 0);
}

/**
 * Curvilinear: both directions are penalised. L1-Spanish speakers
 * characteristically run fast, so "faster is better" would reward the error.
 * Returns null below the phonation floor — the meter is absent, not zero,
 * because zero-for-lack-of-data is indistinguishable from zero-for-poor.
 */
function articulationScore(phonationMs, syllables) {
  if (phonationMs < MIN_PHONATION_MS || syllables <= 0) return null;
  const rate = syllables / (phonationMs / 1000);
  const distance = Math.abs(rate - TARGET_SYLL_PER_SEC);
  const score = 100 * (1 - distance / FLUENCY_HALF_WIDTH);
  return Math.round(Math.max(0, Math.min(100, score)));
}
