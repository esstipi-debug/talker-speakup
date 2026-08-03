import { Router } from "express";
import multer from "multer";
import { getBrain } from "../brain/index.js";
import { getTTS, currentTTSProvider } from "../tts/index.js";
import { getSTT } from "../stt/index.js";
import { startSession, recordTurn, recordSeed } from "../repo/session.js";
import { nextSeed } from "../seed/index.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const HISTORY_WINDOW = 8; // cap how much context we forward (handoff: ~8 turns)

/**
 * Runs one turn: brain reply + basic XP, then synthesizes that reply into
 * audio (handoff §5). On any TTS failure we still return the turn — the
 * client falls back to the browser voice, so the loop never breaks just
 * because the TTS provider is down. Shared by POST /turn and POST /turn/audio.
 */
async function runTurn(utterance, history) {
  const window = Array.isArray(history) ? history.slice(-HISTORY_WINDOW) : [];

  const brain = getBrain();
  const result = await brain.evaluateTurn({
    userUtterance: utterance,
    history: window,
    scenario: null, // scenarios land in M5
  });

  let audio = null;
  let audioFormat = null;
  const tts = getTTS();
  if (tts && result?.coach_reply) {
    try {
      const out = await tts.speak(result.coach_reply);
      audio = out.audio.toString("base64");
      audioFormat = out.format;
    } catch (ttsErr) {
      console.warn("[turn] TTS failed → client will use browser voice:", ttsErr.message);
    }
  }

  return { ...result, audio, audioFormat, ttsProvider: currentTTSProvider() };
}

/**
 * POST /turn
 * body: { utterance: string, history?: { role: "coach"|"user", text: string }[],
 *         sessionId?: string, prosody?: object, captureSettings?: object }
 * resp: { coach_reply: string, xp: number, audio?: base64, audioFormat?: string,
 *         ttsProvider: string, sessionId: string|null, turnId: string|null }
 *
 * The brain returns the next coach line + basic XP. `turnId` identifies the
 * persisted user row: POST /feedback attaches this turn's structured feedback
 * (M2) to it, and keys its idempotency by it. It is null when the row could
 * not be written.
 *
 * The turn is persisted (Session/Turn) as a side effect — see persistTurn below.
 * A DB failure there never fails the request; it only costs the row.
 */
router.post("/", async (req, res) => {
  const { utterance, history, sessionId, prosody, captureSettings } = req.body ?? {};

  if (typeof utterance !== "string" || !utterance.trim()) {
    return res.status(400).json({ error: 'Missing "utterance" (non-empty string).' });
  }

  try {
    const result = await runTurn(utterance.trim(), history);
    // Persistence must never break the loop: a DB failure costs us a row,
    // not the learner's turn.
    const { sessionId: persistedId, turnId } = await persistTurn({ sessionId, utterance: utterance.trim(), prosody, captureSettings, result });
    return res.json({ ...result, sessionId: persistedId, turnId });
  } catch (err) {
    console.error("[turn] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }
});

async function persistTurn({ sessionId, utterance, prosody, captureSettings, result }) {
  let id = sessionId ?? null;
  let sessionUsable = false;
  let turnId = null;
  try {
    if (!id) id = (await startSession()).id;
    const userTurn = await recordTurn({
      sessionId: id,
      role: "user",
      text: utterance,
      prosody: prosody ?? null,
      captureSettings: captureSettings ?? null,
    });
    turnId = userTurn.id;
    sessionUsable = true; // a write to this session has now succeeded
    await recordTurn({ sessionId: id, role: "coach", text: result.coach_reply, xp: result.xp ?? null });
    return { sessionId: id, turnId };
  } catch (dbErr) {
    console.warn("[turn] persistence failed, continuing:", dbErr.message);
    // Never hand back a session id we could not write to. The client re-adopts
    // whatever comes back, so echoing an unusable id would make every later
    // turn fail the same way, silently and forever. Returning null makes the
    // next turn open a fresh session instead.
    // turnId is echoed when the user row itself landed: /feedback can still
    // attach to it even if the coach row failed.
    return { sessionId: sessionUsable ? id : null, turnId };
  }
}

/**
 * POST /turn/open
 * body: { sessionId?: string }
 * resp: { coach_reply, xp, audio?, audioFormat?, ttsProvider, sessionId, seedProvider }
 *
 * The coach's first turn, before the learner has said anything. This exists as
 * a sibling of POST /turn rather than as a nullable `utterance` on it: /turn's
 * validation catches real client bugs and is worth keeping strict.
 *
 * The opening line is deliberately NOT the client's business to compose. The
 * learner should never be asked "what would you like to talk about?" — that
 * hands the work back to the person who came here to be pushed.
 */
router.post("/open", async (req, res) => {
  const { sessionId } = req.body ?? {};

  const seed = await nextSeed().catch(() => null);

  let result;
  try {
    result = await getBrain().openTurn({ topic: seed?.topic ?? null });
  } catch (err) {
    console.error("[turn/open] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }

  let audio = null;
  let audioFormat = null;
  const tts = getTTS();
  if (tts && result?.coach_reply) {
    try {
      const out = await tts.speak(result.coach_reply);
      audio = out.audio.toString("base64");
      audioFormat = out.format;
    } catch (ttsErr) {
      console.warn("[turn/open] TTS failed → client will use browser voice:", ttsErr.message);
    }
  }

  const persisted = await persistOpening({ sessionId, seed, coachReply: result.coach_reply });

  return res.json({
    ...result,
    audio,
    audioFormat,
    ttsProvider: currentTTSProvider(),
    sessionId: persisted.sessionId,
    // Honesty of measurement: report the provenance we actually managed to
    // stamp, not the in-memory seed we merely picked. If recordSeed never
    // landed (persistence failed outright, or it threw after the opener turn
    // itself was written), there is no stamp for later comparison to read —
    // the response must not claim one exists.
    seedProvider: persisted.seedProvider,
  });
});

/**
 * Same rule persistTurn follows: a DB failure costs the row, never the turn.
 * Mirrors persistTurn's sessionUsable handling exactly: once recordTurn (the
 * opener turn itself) has landed, the session id is worth handing back even
 * if recordSeed then fails — otherwise a session that already holds the
 * opener turn gets dropped and orphaned for no reason.
 *
 * seedProvider in the returned object reflects whether recordSeed actually
 * persisted, not merely whether a seed was picked in memory — see the
 * seedProvider comment at the call site.
 */
async function persistOpening({ sessionId, seed, coachReply }) {
  let id = sessionId ?? null;
  let sessionUsable = false;
  let seedPersisted = false;
  try {
    if (!id) id = (await startSession()).id;
    await recordTurn({ sessionId: id, role: "coach", text: coachReply });
    sessionUsable = true; // a write to this session has now succeeded
    if (seed) {
      await recordSeed(id, { provider: seed.provider, topicId: seed.topicId });
      seedPersisted = true;
    }
    return { sessionId: id, seedProvider: seedPersisted ? seed.provider : null };
  } catch (dbErr) {
    console.warn("[turn/open] persistence failed, continuing:", dbErr.message);
    return {
      sessionId: sessionUsable ? id : null,
      seedProvider: seedPersisted ? seed.provider : null,
    };
  }
}

/**
 * POST /turn/audio
 * multipart/form-data: audio (file), history? (JSON-stringified array, same shape as POST /turn)
 * resp: { transcript: string, coach_reply, xp, audio?, audioFormat?, ttsProvider }
 *
 * M6 candidate: the server transcribes the recording itself (via STT_PROVIDER)
 * instead of relying on the client's Web Speech transcript — the prerequisite
 * for audio-aware pronunciation feedback (M7). 501s when no STT is configured.
 */
router.post("/audio", upload.single("audio"), async (req, res) => {
  const stt = getSTT();
  if (!stt) {
    return res.status(501).json({
      error: "No server-side STT configured. Set STT_PROVIDER in server/.env, or use the text/browser-voice input.",
    });
  }
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: 'Missing "audio" file.' });
  }

  let history;
  try {
    history = req.body?.history ? JSON.parse(req.body.history) : [];
  } catch {
    return res.status(400).json({ error: '"history" must be JSON-encoded.' });
  }

  let transcript;
  try {
    const transcription = await stt.transcribe(req.file.buffer, { filename: req.file.originalname });
    transcript = transcription.text?.trim();
  } catch (err) {
    console.error("[turn/audio] STT error:", err);
    return res.status(502).json({
      error: "Transcription failed. Check the STT service / network.",
      detail: String(err?.message ?? err),
    });
  }

  if (!transcript) {
    return res.status(422).json({ error: "Couldn't make out any speech in that recording." });
  }

  try {
    const result = await runTurn(transcript, [...history, { role: "user", text: transcript }]);
    return res.json({ transcript, ...result });
  } catch (err) {
    console.error("[turn/audio] brain error:", err);
    return res.status(502).json({
      error: "The coach brain failed to respond. Check your API key / network.",
      detail: String(err?.message ?? err),
    });
  }
});

export default router;
