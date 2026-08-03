import { getPrisma } from "../db.js";

/**
 * The only module that reads or writes ErrorLedger. `pattern` carries @unique
 * since M0, which is what makes the twelfth sighting the same row rather than
 * a new one.
 *
 * M2 writes it; M4 is what schedules from it. Shipping M2 without the writes
 * would leave M4 starting from zero history.
 */

export async function getFrequencies(patterns) {
  if (!patterns.length) return new Map();
  const rows = await getPrisma().errorLedger.findMany({
    where: { pattern: { in: patterns } },
    select: { pattern: true, frequency: true },
  });
  return new Map(rows.map((r) => [r.pattern, r.frequency]));
}

/**
 * `entries` must already be unique by `pattern` — buildFeedback de-duplicates
 * before calling. Two entries sharing a key here would increment the same row
 * twice for a single turn, which is not something this function can detect.
 */
export async function recordFindings(entries) {
  for (const { pattern, type, example, explanation } of entries) {
    await getPrisma().errorLedger.upsert({
      where: { pattern },
      update: { frequency: { increment: 1 }, lastSeenAt: new Date(), example, explanation },
      create: { pattern, type, example, explanation },
    });
  }
}
