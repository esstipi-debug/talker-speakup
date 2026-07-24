/**
 * Kokoro TTS adapter (handoff §7.2).
 *
 * Talks to kokoro-fastapi's OpenAI-compatible endpoint:
 *   POST {KOKORO_URL}/audio/speech  { model, voice, input, response_format }
 *
 * Because the shape is OpenAI-compatible, the same adapter works later for
 * OpenAI / ElevenLabs by just pointing KOKORO_URL elsewhere.
 */

const DEFAULTS = {
  url: "http://localhost:8880/v1",
  voice: "af_heart", // English voice (af_* = American female). Override via KOKORO_VOICE.
  model: "kokoro",
  format: "mp3",
  timeoutMs: 20000,
};

export class KokoroTTS {
  constructor() {
    this.baseUrl = (process.env.KOKORO_URL?.trim() || DEFAULTS.url).replace(/\/+$/, "");
    this.voice = process.env.KOKORO_VOICE?.trim() || DEFAULTS.voice;
    this.model = process.env.KOKORO_MODEL?.trim() || DEFAULTS.model;
    this.format = process.env.KOKORO_FORMAT?.trim() || DEFAULTS.format;
    this.timeoutMs = Number(process.env.KOKORO_TIMEOUT_MS) || DEFAULTS.timeoutMs;
  }

  /**
   * @param {string} text
   * @param {{ voice?: string }} [opts]
   * @returns {Promise<{ audio: Buffer, format: string }>}
   */
  async speak(text, { voice } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          voice: voice || this.voice,
          input: text,
          response_format: this.format,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Kokoro ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`);
      }

      const audio = Buffer.from(await res.arrayBuffer());
      return { audio, format: this.format };
    } finally {
      clearTimeout(timer);
    }
  }
}
