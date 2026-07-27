import { Router } from "express";
import multer from "multer";
import { getPron, currentPronProvider } from "../pron/index.js";
import { listPrompts } from "../pron/prompts.js";
import {
  AUDIO_TOO_LARGE_MESSAGE,
  MAX_AUDIO_BYTES,
  PRON_ERROR_CODES,
  validateAssessInput,
  validateReport,
} from "../pron/contract.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

/**
 * multer surfaces an oversized part as a MulterError. turn.js lets that fall
 * through to the global 500 handler; the drill needs the typed 413 so the
 * client can tell the learner to record a shorter take.
 */
function uploadSingleAudio(req, res, next) {
  upload.single("audio")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: AUDIO_TOO_LARGE_MESSAGE,
        code: PRON_ERROR_CODES.AUDIO_TOO_LARGE,
      });
    }
    return next(err);
  });
}

/**
 * POST /pron/assess
 * multipart/form-data: audio (file), text (reference sentence), mode? ("scripted"|"unscripted")
 * resp: { version, mode, pronProvider, model, overall, prosody, words }
 *
 * `mode` is the design §3 switch: scripted shows phonemes, unscripted never
 * does. That guarantee is NOT enforced yet — `stripPhones` (../pron/contract.js)
 * is not wired into this route. It lands in a later task; until then a
 * provider that ignores `mode` and returns phones anyway will leak them.
 */
router.post("/assess", uploadSingleAudio, async (req, res) => {
  const check = validateAssessInput({
    text: req.body?.text,
    mode: req.body?.mode,
    audioBytes: req.file?.buffer?.length,
  });
  if (!check.ok) {
    return res.status(check.status).json({ error: check.error, code: check.code });
  }
  const { text, mode } = check.value;

  let report;
  try {
    report = await getPron().assess(req.file.buffer, {
      text,
      mode,
      // Defensive fallback, not exercised by an HTTP test: multer >= 2.2.0
      // (make-middleware.js) does `if (!filename) return fileStream.resume()`
      // on the busboy "file" event, so a part with a falsy filename never
      // becomes req.file at all — it 400s as MISSING_AUDIO upstream instead.
      // req.file.originalname is therefore always truthy in practice; this
      // stays as a boundary guard in case that multer behaviour ever changes.
      filename: req.file.originalname || "drill.webm",
    });
  } catch (err) {
    console.error("[pron/assess] provider error:", err);
    return res.status(502).json({
      error: "Pronunciation scoring is offline. The drill continues as listen-and-repeat.",
      code: PRON_ERROR_CODES.PRON_UNAVAILABLE,
      detail: String(err?.message ?? err),
    });
  }

  const valid = validateReport(report);
  if (!valid.ok) {
    console.error("[pron/assess] provider error:", valid.error);
    return res.status(502).json({
      error: "The pronunciation scorer returned an unreadable report.",
      code: PRON_ERROR_CODES.BAD_REPORT,
      detail: valid.error,
    });
  }

  return res.json({ ...report, mode, pronProvider: currentPronProvider() });
});

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
