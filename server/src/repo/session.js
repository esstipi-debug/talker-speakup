import { getPrisma } from "../db.js";

/**
 * The only module that writes Session/Turn. Keeping the JSON encode/decode of
 * `prosody` and `captureSettings` here means no caller ever sees a string
 * where it expects counts or a settings object.
 */

export async function startSession() {
  return getPrisma().session.create({ data: {} });
}

export async function recordTurn({ sessionId, role, text, xp = null, prosody = null, captureSettings = null, feedback = null }) {
  return getPrisma().turn.create({
    data: {
      sessionId,
      role,
      text,
      xp,
      prosody: prosody ? JSON.stringify(prosody) : null,
      captureSettings: captureSettings ? JSON.stringify(captureSettings) : null,
      feedback: feedback ? JSON.stringify(feedback) : null,
    },
  });
}

export async function saveTurnFeedback(turnId, payload) {
  await getPrisma().turn.update({
    where: { id: turnId },
    data: { feedback: JSON.stringify(payload) },
  });
}

export async function getTurnFeedback(turnId) {
  const turn = await getPrisma().turn.findUnique({
    where: { id: turnId },
    select: { feedback: true },
  });
  return parseJsonColumn(turn?.feedback, "feedback");
}

export async function getSessionWithTurns(id) {
  const session = await getPrisma().session.findUnique({
    where: { id },
    include: { turns: { orderBy: { createdAt: "asc" } } },
  });
  if (!session) return null;
  return { ...session, turns: session.turns.map(decodeTurn) };
}

function decodeTurn(turn) {
  return {
    ...turn,
    prosody: parseJsonColumn(turn.prosody, "prosody"),
    captureSettings: parseJsonColumn(turn.captureSettings, "captureSettings"),
    feedback: parseJsonColumn(turn.feedback, "feedback"),
  };
}

/**
 * One unreadable row must not take down the whole session read. This is the
 * only place a stored string re-enters the application, so it is the boundary
 * the rest of the code gets to trust.
 *
 * The write side is deliberately left unguarded: a bad `JSON.stringify` throws
 * loudly at the call site, in the caller's face, rather than silently
 * corrupting somebody else's later read.
 */
function parseJsonColumn(raw, columnName) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[repo] discarding unreadable ${columnName} payload`);
    return null;
  }
}
