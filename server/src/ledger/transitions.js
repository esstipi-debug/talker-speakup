/**
 * Pure state machine for ErrorLedger.status / probesPassed. No I/O, no
 * clock — `current` and `event` are both supplied by the caller, so this is
 * verifiable against constructed inputs with closed-form expectations
 * (spec §4.1, §9.1). This is the function that decides whether the product
 * tells someone they fixed a habit, so it has to be this boring.
 */

/**
 * UNCALIBRATED — spec §11. Starting value, not a measurement: the ledger was
 * empty when this was designed. Revisit once real probe outcomes exist.
 */
export const PROBE_PASSES_TO_RESOLVE = 3;

/**
 * @param {{ probesPassed: number } | null} current - ignored for "failed"/"sighted"
 * @param {"passed" | "failed" | "sighted"} event
 * @returns {{ status: "active" | "improving" | "resolved", probesPassed: number }}
 */
export function nextLedgerState(current, event) {
  if (event === "passed") {
    const probesPassed = Math.min((current?.probesPassed ?? 0) + 1, PROBE_PASSES_TO_RESOLVE);
    const status = probesPassed >= PROBE_PASSES_TO_RESOLVE ? "resolved" : "improving";
    return { status, probesPassed };
  }
  // "failed": a probed opportunity to repeat the mistake was taken.
  // "sighted": the mistake appeared in ordinary conversation, unprompted.
  // Both mean the habit is not fixed, and are indistinguishable in outcome:
  // any single relapse revokes a "resolved" status (spec §6, §10).
  return { status: "active", probesPassed: 0 };
}
