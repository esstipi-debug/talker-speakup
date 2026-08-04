import { getPrisma } from "../db.js";
import { nextLedgerState } from "../ledger/transitions.js";

/**
 * The only module that reads or writes ErrorLedger. `pattern` carries @unique
 * since M0, which is what makes the twelfth sighting the same row rather than
 * a new one.
 *
 * M2 writes it; M4 is what schedules from it and reads it back for the
 * patterns view. `ledger/transitions.js` owns the status math; this module
 * owns the I/O around it.
 */

/** `{frequency, status}` — status is what §5.2's `recurrence` block needs (M4). */
export async function getFrequencies(patterns) {
  if (!patterns.length) return new Map();
  const rows = await getPrisma().errorLedger.findMany({
    where: { pattern: { in: patterns } },
    select: { pattern: true, frequency: true, status: true },
  });
  return new Map(rows.map((r) => [r.pattern, { frequency: r.frequency, status: r.status }]));
}

/**
 * `entries` must already be unique by `pattern` — buildFeedback de-duplicates
 * before calling. Two entries sharing a key here would increment the same row
 * twice for a single turn, which is not something this function can detect.
 *
 * M4: every sighting is an ordinary one from this function's point of view —
 * even the pattern's twelfth appearance resets status to active and zeroes
 * probesPassed. A relapse is a relapse, regardless of how many probes were
 * passed before it (spec §6).
 */
export async function recordFindings(entries) {
  const reset = nextLedgerState(null, "sighted");
  for (const { pattern, type, example, explanation } of entries) {
    await getPrisma().errorLedger.upsert({
      where: { pattern },
      update: { frequency: { increment: 1 }, lastSeenAt: new Date(), example, explanation, ...reset },
      create: { pattern, type, example, explanation },
    });
  }
}

/**
 * All rows, unfiltered by status or frequency — coach/probe.js's chooseProbe
 * owns that policy (spec §4.1: "the choice is pure; the read lives in repo").
 */
export async function getProbeCandidates() {
  return getPrisma().errorLedger.findMany({
    select: { pattern: true, example: true, explanation: true, frequency: true, status: true, lastProbedAt: true },
  });
}

/** Stamped the moment a probe is issued (routes/turn.js), not when its outcome resolves. */
export async function markProbed(pattern) {
  await getPrisma().errorLedger.update({ where: { pattern }, data: { lastProbedAt: new Date() } });
}

/**
 * Resolves a probe's outcome. An unknown pattern is a no-op (spec §8: "a
 * probe never creates a ledger row") — this can only ever transition a row
 * that recordFindings has already created.
 *
 * Idempotency is the CALLER's responsibility (spec §8.1) — routes/feedback.js
 * must only reach this from inside its existing turnId-gated computeAndPersist.
 */
export async function applyProbeOutcome(pattern, passed) {
  const row = await getPrisma().errorLedger.findUnique({ where: { pattern }, select: { probesPassed: true } });
  if (!row) return null;
  const next = nextLedgerState({ probesPassed: row.probesPassed }, passed ? "passed" : "failed");
  await getPrisma().errorLedger.update({ where: { pattern }, data: next });
  return { pattern, passed, status: next.status };
}

/** Ordered by status then frequency (spec §7) — resolved rows are the reward D4 exists to deliver, so they are included, not hidden. */
export async function listPatterns() {
  return getPrisma().errorLedger.findMany({
    orderBy: [{ status: "asc" }, { frequency: "desc" }],
    select: {
      pattern: true,
      example: true,
      frequency: true,
      status: true,
      probesPassed: true,
      lastSeenAt: true,
      lastProbedAt: true,
    },
  });
}
