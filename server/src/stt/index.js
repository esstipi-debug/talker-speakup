import { VoiceboxSTT } from "./voicebox.js";

/**
 * Pluggable STT factory, mirrors brain/tts (handoff §7.2 candidate for M6).
 *   voicebox -> server transcribes audio via a local voicebox instance (Whisper)
 *   (unset)  -> no server-side STT; the client relies on the Web Speech API only
 * Swap with STT_PROVIDER in server/.env. No route consumes this yet — routes/turn.js
 * still only accepts a text utterance; wiring client audio capture + a route is separate.
 */
let _initialized = false;
let _stt = null;
let _provider = null;

function resolveProvider() {
  return process.env.STT_PROVIDER?.trim().toLowerCase() || "none";
}

export function getSTT() {
  if (_initialized) return _stt;
  _provider = resolveProvider();
  _stt = _provider === "voicebox" ? new VoiceboxSTT() : null;
  _initialized = true;
  console.log(`[stt] provider = ${_provider}`);
  return _stt;
}

export function currentSTTProvider() {
  if (!_initialized) getSTT();
  return _provider;
}
