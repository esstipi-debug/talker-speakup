/** Browser voice in/out (Ruta A). STT via Web Speech API, TTS via SpeechSynthesis. */

function getRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSTTSupported() {
  return !!getRecognitionCtor();
}

export function isTTSSupported() {
  return typeof window !== "undefined" && !!window.speechSynthesis;
}

/**
 * Create a one-shot recognizer. Caller starts it with .start() and stops/aborts as needed.
 * Returns null if the browser doesn't support Web Speech (use the text fallback then).
 */
export function createRecognizer({ lang = "en-US", onResult, onError, onEnd } = {}) {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false;

  rec.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((r) => r[0]?.transcript ?? "")
      .join(" ")
      .trim();
    onResult?.(transcript);
  };
  rec.onerror = (event) => onError?.(event.error || "speech-error");
  rec.onend = () => onEnd?.();

  return rec;
}

/** Warm up the voice list (Chrome populates it asynchronously). */
export function warmUpVoices() {
  if (!isTTSSupported()) return;
  window.speechSynthesis.getVoices();
}

function pickEnglishVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => /en[-_]US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    null
  );
}

export function speak(text, { lang = "en-US", onStart, onEnd } = {}) {
  if (!isTTSSupported() || !text) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  const voice = pickEnglishVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();

  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (isTTSSupported()) window.speechSynthesis.cancel();
}

/**
 * Play server-generated audio (e.g. Kokoro) from a base64 payload.
 * Returns the HTMLAudioElement so the caller can pause/stop it, or null if
 * there's nothing to play.
 */
export function playAudio(base64, { format = "mp3", onStart, onEnd, onError } = {}) {
  if (!base64) {
    onEnd?.();
    return null;
  }
  const mime =
    format === "wav"
      ? "audio/wav"
      : format === "opus" || format === "ogg"
      ? "audio/ogg"
      : "audio/mpeg";

  const audio = new Audio(`data:${mime};base64,${base64}`);
  audio.onplay = () => onStart?.();
  audio.onended = () => onEnd?.();
  audio.onerror = () => (onError ? onError() : onEnd?.());
  // Autoplay is allowed because each turn starts from a user gesture (mic/Send).
  audio.play().catch(() => (onError ? onError() : onEnd?.()));
  return audio;
}
