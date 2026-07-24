/**
 * Voicebox STT adapter (Whisper via voicebox's REST API).
 *
 *   POST {VOICEBOX_URL}/transcribe  multipart/form-data { file, language?, model? }
 *   -> { text, duration }
 *
 * On the first request for a given Whisper size, voicebox returns 202 while
 * it downloads the model in the background; this adapter polls until it's
 * ready (or a max wait is hit) instead of surfacing that as a caller-facing
 * error.
 */

const DEFAULTS = {
  url: "http://localhost:17493",
  language: "en",
  timeoutMs: 30000,
  downloadPollMs: 3000,
  downloadMaxWaitMs: 180000, // first-ever model download can take a while
};

export class VoiceboxSTT {
  constructor() {
    this.baseUrl = (process.env.VOICEBOX_URL?.trim() || DEFAULTS.url).replace(/\/+$/, "");
    this.language = process.env.VOICEBOX_STT_LANGUAGE?.trim() || DEFAULTS.language;
    this.model = process.env.VOICEBOX_STT_MODEL?.trim() || null; // unset -> voicebox's own default (currently "base")
    this.timeoutMs = Number(process.env.VOICEBOX_TIMEOUT_MS) || DEFAULTS.timeoutMs;
    this.downloadMaxWaitMs =
      Number(process.env.VOICEBOX_STT_DOWNLOAD_MAX_WAIT_MS) || DEFAULTS.downloadMaxWaitMs;
  }

  /**
   * @param {Buffer} audioBuffer
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<{ text: string, duration: number }>}
   */
  async transcribe(audioBuffer, { filename = "audio.wav" } = {}) {
    const deadline = Date.now() + this.downloadMaxWaitMs;

    while (true) {
      const res = await this._postOnce(audioBuffer, filename);

      if (res.status === 202) {
        if (Date.now() >= deadline) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(
            `Voicebox STT model download timed out: ${detail?.detail?.message || "still downloading"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, DEFAULTS.downloadPollMs));
        continue;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Voicebox ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`);
      }

      return res.json();
    }
  }

  async _postOnce(audioBuffer, filename) {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer]), filename);
    if (this.language) form.append("language", this.language);
    if (this.model) form.append("model", this.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}/transcribe`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
