import { KokoroTTS } from "./kokoro.js";
import { VoiceboxTTS } from "./voicebox.js";
import { slotDefault } from "../config/mode.js";

/**
 * Pluggable TTS factory (handoff §7.2).
 *   kokoro   -> server synthesizes the coach voice via kokoro-fastapi (default)
 *   voicebox -> server synthesizes via a local voicebox instance (also Kokoro-backed, plus others)
 *   browser  -> server returns no audio; the client speaks via SpeechSynthesis
 * Swap with TTS_PROVIDER in server/.env.
 */
let _initialized = false;
let _tts = null;
let _provider = null;

function resolveProvider() {
  return process.env.TTS_PROVIDER?.trim().toLowerCase() || slotDefault("tts") || "kokoro";
}

export function getTTS() {
  if (_initialized) return _tts;
  _provider = resolveProvider();
  _tts =
    _provider === "kokoro"
      ? new KokoroTTS()
      : _provider === "voicebox"
        ? new VoiceboxTTS()
        : null; // null => client-side voice
  _initialized = true;
  console.log(`[tts] provider = ${_provider}`);
  return _tts;
}

export function currentTTSProvider() {
  if (!_initialized) getTTS();
  return _provider;
}
