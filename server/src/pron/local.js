import { PRON_ERROR_CODES } from "./contract.js";

/**
 * HTTP client for the pronunciation sidecar (design §4.2). Wire protocol:
 *   POST {PRON_URL}/assess  multipart: audio (file), text (form), mode (form)
 *        -> 200 PronunciationReport envelope | 4xx/5xx { error, code }
 *   GET  {PRON_URL}/health  -> { status, model, ... }
 * The Node server never decodes audio; it forwards the bytes verbatim.
 */
const DEFAULTS = {
  url: "http://localhost:8899",
  timeoutMs: 30000,
};

const DETAIL_CAP = 200;

export class LocalPron {
  constructor() {
    this.baseUrl = (process.env.PRON_URL?.trim() || DEFAULTS.url).replace(/\/+$/, "");
    this.timeoutMs = Number(process.env.PRON_TIMEOUT_MS) || DEFAULTS.timeoutMs;
  }

  /**
   * @param {Buffer} audioBuffer
   * @param {{ text: string, mode?: "scripted"|"unscripted", filename?: string }} [opts]
   * @returns {Promise<import("./contract.js").PronunciationReport>}
   */
  async assess(audioBuffer, { text, mode = "scripted", filename = "drill.webm" } = {}) {
    const form = new FormData();
    form.append("audio", new Blob([audioBuffer]), filename);
    form.append("text", text);
    form.append("mode", mode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/assess`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
      } catch (err) {
        // abort, ECONNREFUSED, DNS — all mean "no score this round".
        err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
        throw err;
      }
      if (res.ok) return await res.json();
      throw await this._toTypedError(res);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @returns {Promise<{ status: string, model: string, alignAvailable: boolean, espeakAvailable: boolean, ffmpegAvailable: boolean, ts: number }>}
   */
  async health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Pron sidecar ${res.status} ${res.statusText} — ${detail.slice(0, DETAIL_CAP)}`,
        );
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The body is read exactly once — reading it twice throws on an already
   * disturbed stream, which would mask the real upstream failure.
   */
  async _toTypedError(res) {
    const raw = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 422) {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const code = body?.code;
      if (code && PRON_ERROR_CODES[code]) {
        const err = new Error(body.error || `Pron sidecar ${res.status} ${res.statusText}`);
        err.code = code;
        return err;
      }
    }
    const err = new Error(
      `Pron sidecar ${res.status} ${res.statusText} — ${raw.slice(0, DETAIL_CAP)}`,
    );
    err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
    return err;
  }
}
