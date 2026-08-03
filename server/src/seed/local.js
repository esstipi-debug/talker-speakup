/**
 * The terminal seed provider: no network, no database, never returns null.
 *
 * Every other provider may come up empty — no feeds configured, nothing
 * cached, everything already used — and falls through to this one. That is
 * why it cannot fail: it is what stands between a dead feed and a session
 * that will not open.
 *
 * The subjects are chosen to be arguable rather than merely answerable. "How
 * was your weekend" has a three-word answer and the M2 coach prompt would
 * spend its first turn dragging the learner off it.
 */
const OPENERS = [
  "whether working from home actually makes people better at their jobs, or just more available",
  "why some films are worth watching twice and most are not",
  "whether a city is better judged by its public transport or its food",
  "what a person should be allowed to keep private from an employer",
  "whether learning a language as an adult is harder than people claim, or just less forgiving",
  "why some jobs are respected far more than they are paid, and others the reverse",
  "whether the best way to learn something is to teach it, or to fail at it in public",
  "what makes a place feel like home when you did not grow up there",
];

export { OPENERS };

/**
 * Pure and deterministic. `n` is any integer — the caller supplies a clock, so
 * this module keeps no state and the tests keep no fixtures.
 */
export function pickOpener(n) {
  const index = ((Math.trunc(n) % OPENERS.length) + OPENERS.length) % OPENERS.length;
  return {
    provider: "local",
    topic: OPENERS[index],
    sourceLabel: null,
    sourceUrl: null,
    topicId: null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A real daily rotation: the day number changes once every 24h, so
 * consecutive sessions on the same day draw the same opener and walk the
 * list in order day over day. `pickOpener(Date.now())` would have re-rolled
 * on every millisecond instead — independent draws with a 1-in-OPENERS.length
 * chance of repeating back to back, which is not a rotation at all.
 */
export async function nextSeed() {
  return pickOpener(Math.floor(Date.now() / DAY_MS));
}
