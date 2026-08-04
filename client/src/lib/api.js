/** Thin client for the SpeakUp server. Paths are proxied to :3001 by Vite. */

export async function postTurn({ utterance, history, sessionId, prosody, captureSettings }) {
  const res = await fetch("/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance, history, sessionId, prosody, captureSettings }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error ${res.status}`);
  }
  return res.json(); // { coach_reply, xp, audio?, audioFormat?, ttsProvider, sessionId }
}

export async function getHealth() {
  try {
    const res = await fetch("/health");
    if (!res.ok) return null;
    return res.json(); // { status, brain, tts, stt, ts }
  } catch {
    return null;
  }
}

const AUDIO_EXTENSIONS = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a" };

function extensionFor(mimeType) {
  const base = mimeType?.split(";")[0];
  return AUDIO_EXTENSIONS[base] || "webm";
}

/** Server-side STT path (Ruta B) — uploads the raw recording instead of a Web Speech transcript. */
export async function postTurnAudio({ blob, history }) {
  const form = new FormData();
  form.append("audio", blob, `turn.${extensionFor(blob.type)}`);
  form.append("history", JSON.stringify(history));

  const res = await fetch("/turn/audio", { method: "POST", body: form });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error ${res.status}`);
  }
  return res.json(); // { transcript, coach_reply, xp, audio?, audioFormat?, ttsProvider }
}

/**
 * The coach's opening turn. Returns null on ANY failure — a session that
 * cannot reach the server must still open with the local greeting, so this
 * never throws and never makes the caller handle an error path.
 */
export async function postTurnOpen({ sessionId }) {
  try {
    const res = await fetch("/turn/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Deferred structured feedback. Never throws: a missing panel is a degraded
 * view, not a conversation error, and must not surface as one.
 */
export async function postFeedback({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables, probedPattern }) {
  try {
    const res = await fetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance, turnId, history, prosody, sessionPhonationMs, sessionSyllables, probedPattern }),
    });
    if (!res.ok) return null;
    // Awaited (not returned bare): a promise returned from inside a try block
    // is not adopted by that try — its rejection would skip this catch
    // entirely. A 200 with a truncated/non-JSON body must still resolve null.
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The read-only patterns view (M4, spec D4). Never throws — a missing panel
 * is a degraded view, not a conversation error, same contract as getHealth.
 */
export async function getPatterns() {
  try {
    const res = await fetch("/patterns");
    if (!res.ok) return null;
    return await res.json(); // { patterns: [...] }
  } catch {
    return null;
  }
}
