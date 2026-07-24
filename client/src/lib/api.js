/** Thin client for the SpeakUp server. Paths are proxied to :3001 by Vite. */

export async function postTurn({ utterance, history }) {
  const res = await fetch("/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance, history }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error ${res.status}`);
  }
  return res.json(); // { coach_reply, xp, audio?, audioFormat?, ttsProvider }
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
