import { getPrisma } from "../db.js";

/**
 * The only module that writes Session/Turn. Keeping the JSON encode/decode of
 * `prosody` here means no caller ever sees a string where it expects counts.
 */

export async function startSession() {
  return getPrisma().session.create({ data: {} });
}

export async function recordTurn({ sessionId, role, text, xp = null, prosody = null }) {
  return getPrisma().turn.create({
    data: { sessionId, role, text, xp, prosody: prosody ? JSON.stringify(prosody) : null },
  });
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
  return { ...turn, prosody: turn.prosody ? JSON.parse(turn.prosody) : null };
}
