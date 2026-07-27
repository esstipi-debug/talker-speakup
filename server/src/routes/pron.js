import { Router } from "express";
import { listPrompts } from "../pron/prompts.js";

const router = Router();

/**
 * GET /pron/prompts
 * query: focus? (one of the slugs in content/drills.v1.json; omitted -> full set)
 * resp:  { version, updated, focuses, prompts }
 *
 * The server owns the drill set so M3/M4 can make it ledger-derived without
 * touching the client (design §4.1).
 */
router.get("/prompts", (req, res) => {
  const result = listPrompts({ focus: req.query?.focus });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, code: result.code });
  }
  return res.json(result.value);
});

export default router;
