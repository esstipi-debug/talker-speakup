import { Router } from "express";
import { buildFeedback } from "../feedback/index.js";
import { saveTurnFeedback, getTurnFeedback } from "../repo/session.js";
import { applyProbeOutcome } from "../repo/ledger.js";

const router = Router();

/**
 * In-flight de-duplication, keyed by turnId. The stored-payload check in the
 * handler below only catches retries that arrive AFTER the first request has
 * finished writing — two requests that both read `null` before either has
 * written would otherwise both call buildFeedback and both write, inflating
 * the ledger's frequency counts. This map closes that window: a second
 * request for a turnId already in flight awaits the same promise instead of
 * starting its own. Entries are removed in a `finally` so the map cannot grow
 * without bound; no timeout/LRU is needed for a single-user local app.
 */
const inFlight = new Map();

/**
 * POST /feedback
 * body: { utterance, turnId?, history?, prosody?,
 *         sessionPhonationMs?, sessionSyllables? }
 *
 * Deferred, per-turn structured feedback (spec D1/D7). The coach has already
 * replied by the time this runs — nothing is blocked on it.
 *
 * `utterance` MUST be byte-identical to the one sent to /turn: the correction
 * spans are offsets into it.
 */
router.post("/", async (req, res) => {
  const { utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables, probedPattern } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  // Idempotency (spec §7.2): a retry must not inflate ledger frequencies.
  // This is the database gate: it catches duplicates separated in time,
  // including across a server restart. It is NOT a reload cache — client
  // turnIds live in memory only, so a reloaded page never asks about a turn
  // it could still identify.
  if (turnId) {
    const stored = await getTurnFeedback(turnId).catch(() => null);
    if (stored) return res.json(stored);
  }

  async function computeAndPersist() {
    const raw = await buildFeedback({
      utterance,
      history: Array.isArray(history) ? history : [],
      prosody: prosody ?? null,
      sessionPhonationMs: Number(sessionPhonationMs) || 0,
      sessionSyllables: Number(sessionSyllables) || 0,
    });
    const { recordedPatterns, frequenciesBeforeWrite, ...publicFields } = raw;

    // M4: attach recurrence to each correction from the pre-write snapshot
    // buildFeedback already read, +1 for the sighting the write just
    // recorded (spec §5.2 — the raw snapshot is "as of the previous turn").
    const corrections = publicFields.corrections.map((c) => {
      const prior = frequenciesBeforeWrite[c.pattern];
      return { ...c, recurrence: { frequency: (prior?.frequency ?? 0) + 1, status: prior?.status ?? "active" } };
    });

    // M4: resolve this turn's probe, if any. Reads recordedPatterns (pre-cap)
    // rather than the capped `corrections`/`upgrades` above, so a reappeared
    // pattern that got bumped out of the display cap is still scored
    // correctly. This MUST stay inside computeAndPersist, behind both the
    // stored-payload check above and the in-flight map below — see the
    // Global Constraints note on applyProbeOutcome.
    let probeResult = null;
    if (probedPattern) {
      const reappeared = recordedPatterns.includes(probedPattern);
      const outcome = await applyProbeOutcome(probedPattern, !reappeared);
      if (outcome) probeResult = outcome;
    }

    const payload = { ...publicFields, corrections, probeResult };

    // Persistence must never cost the payload — the rule /turn has followed
    // since M3.
    if (turnId) {
      try {
        // spec §6.2: the turn also carries the session-level fluency current
        // at that turn, so M4 can query the trend without a per-turn metric.
        // A null value leaves the column untouched rather than writing 0.
        await saveTurnFeedback(turnId, payload, payload?.sessionFluency);
      } catch (dbErr) {
        console.warn("[feedback] persistence failed, continuing:", dbErr.message);
      }
    }

    return payload;
  }

  // In-flight gate: catches duplicates that race each other, both arriving
  // before the first has finished writing. Only requests carrying a turnId
  // participate — a request without one always runs standalone.
  let work = turnId ? inFlight.get(turnId) : undefined;
  if (!work) {
    work = computeAndPersist();
    if (turnId) {
      inFlight.set(turnId, work);
      // `.finally()` returns a NEW promise that adopts the original's
      // rejection. `work` itself is awaited under try/catch below, but this
      // derived promise has no handler of its own — without the `.catch`, a
      // rejecting buildFeedback becomes an unhandled rejection and takes the
      // process down under Node's default policy.
      work.catch(() => {}).finally(() => inFlight.delete(turnId));
    }
  }

  let payload;
  try {
    payload = await work;
  } catch (err) {
    console.error("[feedback] build failed:", err);
    return res.status(502).json({ error: "Feedback could not be generated.", detail: String(err?.message ?? err) });
  }

  return res.json(payload);
});

export default router;
