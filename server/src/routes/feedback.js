import { Router } from "express";
import { buildFeedback } from "../feedback/index.js";
import { saveTurnFeedback, getTurnFeedback } from "../repo/session.js";

const router = Router();

/**
 * POST /feedback
 * body: { utterance, turnId?, sessionId?, history?, prosody?,
 *         sessionPhonationMs?, sessionSyllables? }
 *
 * Deferred, per-turn structured feedback (spec D1/D7). The coach has already
 * replied by the time this runs — nothing is blocked on it.
 *
 * `utterance` MUST be byte-identical to the one sent to /turn: the correction
 * spans are offsets into it.
 */
router.post("/", async (req, res) => {
  const { utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  // Idempotency (spec §7.2): a retry must not inflate ledger frequencies.
  // Also yields caching for free — a reload does not re-pay the LLM call.
  if (turnId) {
    const stored = await getTurnFeedback(turnId).catch(() => null);
    if (stored) return res.json(stored);
  }

  let payload;
  try {
    payload = await buildFeedback({
      utterance,
      history: Array.isArray(history) ? history : [],
      prosody: prosody ?? null,
      sessionPhonationMs: Number(sessionPhonationMs) || 0,
      sessionSyllables: Number(sessionSyllables) || 0,
    });
  } catch (err) {
    console.error("[feedback] build failed:", err);
    return res.status(502).json({ error: "Feedback could not be generated.", detail: String(err?.message ?? err) });
  }

  // Persistence must never cost the payload — the rule /turn has followed
  // since M3.
  if (turnId) {
    try {
      await saveTurnFeedback(turnId, payload);
    } catch (dbErr) {
      console.warn("[feedback] persistence failed, continuing:", dbErr.message);
    }
  }

  return res.json(payload);
});

export default router;
