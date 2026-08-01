import { Router } from "express";
import multer from "multer";
import { getPron, currentPronProvider } from "../pron/index.js";
import { listPrompts } from "../pron/prompts.js";
import {
  AUDIO_TOO_LARGE_MESSAGE,
  MAX_AUDIO_BYTES,
  PRON_ERROR_CODES,
  stripPhones,
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
 * Codes the sidecar raises about the *submission* rather than about itself.
 * Anything absent from this table is an outage from the learner's point of
 * view and degrades to listen-and-repeat (design §7).
 */
const PROVIDER_ERROR_RESPONSES = Object.freeze({
  [PRON_ERROR_CODES.NO_SPEECH]: {
    status: 422,
    error: "Couldn't make out any speech in that recording.",
  },
  [PRON_ERROR_CODES.UNPRONOUNCEABLE_TEXT]: {
    status: 400,
    error: "Couldn't turn that sentence into phonemes. Try plain English words.",
  },
});

/**
 * POST /pron/assess
 * multipart/form-data: audio (file), text (reference sentence), mode? ("scripted"|"unscripted")
 * resp: { version, mode, pronProvider, model, overall, prosody, words }
 *
 * `mode` is the design §3 switch: scripted shows phonemes, unscripted never
 * does. That guarantee is enforced here: `stripPhones` (../pron/contract.js)
 * runs on every response in unscripted mode, for every provider — even one
 * that ignores `mode` and returns phones anyway.
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
      // The real MIME type of the uploaded bytes (e.g. `audio/webm;
      // codecs=opus` from the browser's MediaRecorder). AzurePron threads
      // this into its Content-Type header instead of asserting WAV — see
      // ../pron/azure.js for why lying about the content type there
      // guarantees a 4xx from Azure.
      mimeType: req.file.mimetype,
    });
  } catch (err) {
    console.error("[pron/assess] provider error:", err);
    const mapped = PROVIDER_ERROR_RESPONSES[err?.code];
    if (mapped) {
      return res.status(mapped.status).json({
        error: mapped.error,
        code: err.code,
        detail: String(err?.message ?? err),
      });
    }
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

  // Design §3: without a trustworthy reference text a per-phoneme score is a
  // fabricated number. Strip after validation, for every provider, always.
  const body = mode === "unscripted" ? stripPhones(report) : report;
  // Prefer what the provider itself reported (design §13.2): a wrapping
  // BudgetCappedPron may have silently served its fallback instead of the
  // configured provider once the spend cap trips, and `currentPronProvider()`
  // only ever reflects the CONFIGURED provider, not who actually served this
  // request. Only fall back to the configured-provider string when the
  // provider genuinely didn't set one (e.g. the sidecar — see contract.js).
  return res.json({ ...body, mode, pronProvider: body.pronProvider ?? currentPronProvider() });
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
