import { Router } from "express";
import { listPatterns } from "../repo/ledger.js";

const router = Router();

/**
 * GET /patterns
 * resp: { patterns: [{ pattern, example, frequency, status, probesPassed, lastSeenAt, lastProbedAt }] }
 *
 * Read-only (spec D4/§7). `pattern` is included for React reconciliation
 * keys only — the client must not render it (see PatternsPanel.jsx).
 */
router.get("/", async (_req, res) => {
  try {
    const patterns = await listPatterns();
    return res.json({ patterns });
  } catch (err) {
    console.error("[patterns] read failed:", err);
    return res.status(502).json({ error: "Could not load patterns." });
  }
});

export default router;
