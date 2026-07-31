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
    return res.json(); // { status, brain, tts, stt, pron, ts }
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
 * Pronunciation drill scoring (design §4.4). Uploads the raw take together with
 * the reference sentence the learner was asked to read. Rejects with an Error
 * carrying `.code` (a PRON_ERROR_CODES member) so the caller can tell "offline"
 * from "we heard nothing".
 *
 * @param {{ blob: Blob, text: string, mode?: "scripted"|"unscripted" }} args
 */
export async function postPronAssess({ blob, text, mode = "scripted" }) {
  const form = new FormData();
  form.append("audio", blob, `drill.${extensionFor(blob.type)}`);
  form.append("text", text);
  form.append("mode", mode);

  const res = await fetch("/pron/assess", { method: "POST", body: form });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Server error ${res.status}`);
    err.code = data.code || "PRON_UNAVAILABLE";
    err.status = res.status;
    throw err;
  }
  return res.json(); // { version, mode, pronProvider, model, overall, prosody, words }
}

/** Curated drill set. `focus` omitted returns every prompt. */
export async function getPronPrompts({ focus } = {}) {
  const res = await fetch(`/pron/prompts${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`);

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Server error ${res.status}`);
    err.code = data.code || "PRON_UNAVAILABLE";
    err.status = res.status;
    throw err;
  }
  return res.json(); // { version, updated, focuses, prompts }
}
