/**
 * Voicebox TTS adapter (handoff §7.2 candidate).
 *
 * Talks to voicebox's REST API (https://github.com/jamiepine/voicebox):
 *   POST {VOICEBOX_URL}/generate/stream  { profile_id, text, language, engine }
 * Synchronous — returns raw WAV bytes directly, same shape as KokoroTTS.speak().
 *
 * Unlike Kokoro, voicebox needs a voice *profile* to exist before it can
 * generate — profiles are per-instance UUIDs, not a config value, so this
 * adapter resolves (or creates) one on first use and caches it per voice id.
 * It also needs the target engine's model warmed once before /generate/stream
 * will serve it; on a "not downloaded yet" response this adapter triggers the
 * warm-up (POST /generate + poll its SSE status) and retries once.
 */

const DEFAULTS = {
  url: "http://localhost:17493",
  engine: "kokoro",
  voiceId: "af_heart", // English voice; matches KOKORO_VOICE's default so swapping providers keeps the same voice.
  language: "en",
  profileName: "SpeakUp Coach",
  timeoutMs: 30000,
  warmupTimeoutMs: 180000, // first-ever model download can take a while
};

export class VoiceboxTTS {
  constructor() {
    this.baseUrl = (process.env.VOICEBOX_URL?.trim() || DEFAULTS.url).replace(/\/+$/, "");
    this.engine = process.env.VOICEBOX_ENGINE?.trim() || DEFAULTS.engine;
    this.voiceId = process.env.VOICEBOX_VOICE?.trim() || DEFAULTS.voiceId;
    this.language = process.env.VOICEBOX_LANGUAGE?.trim() || DEFAULTS.language;
    this.profileName = process.env.VOICEBOX_PROFILE_NAME?.trim() || DEFAULTS.profileName;
    this.timeoutMs = Number(process.env.VOICEBOX_TIMEOUT_MS) || DEFAULTS.timeoutMs;
    this.warmupTimeoutMs = Number(process.env.VOICEBOX_WARMUP_TIMEOUT_MS) || DEFAULTS.warmupTimeoutMs;
    this._profileIds = new Map(); // voiceId -> resolved profile id
  }

  /**
   * @param {string} text
   * @param {{ voice?: string }} [opts]
   * @returns {Promise<{ audio: Buffer, format: string }>}
   */
  async speak(text, { voice } = {}) {
    const voiceId = voice || this.voiceId;
    const profileId = await this._resolveProfileId(voiceId);

    try {
      return await this._streamGenerate(profileId, text);
    } catch (err) {
      if (err.code !== "MODEL_NOT_READY") throw err;
      await this._warmModel(profileId, text);
      return await this._streamGenerate(profileId, text);
    }
  }

  async _resolveProfileId(voiceId) {
    if (this._profileIds.has(voiceId)) return this._profileIds.get(voiceId);

    const profiles = await this._fetchJson("/profiles");
    const existing = profiles.find(
      (p) => p.preset_engine === this.engine && p.preset_voice_id === voiceId,
    );
    const profile =
      existing ||
      (await this._fetchJson("/profiles", {
        method: "POST",
        body: JSON.stringify({
          name: `${this.profileName} (${voiceId})`,
          language: this.language,
          voice_type: "preset",
          preset_engine: this.engine,
          preset_voice_id: voiceId,
          default_engine: this.engine,
        }),
      }));

    this._profileIds.set(voiceId, profile.id);
    return profile.id;
  }

  async _streamGenerate(profileId, text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/generate/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: profileId,
          text,
          language: this.language,
          engine: this.engine,
        }),
        signal: controller.signal,
      });

      if (res.status === 400) {
        const detail = await res.json().catch(() => ({}));
        if (/not downloaded/i.test(detail?.detail || "")) {
          const err = new Error(detail.detail);
          err.code = "MODEL_NOT_READY";
          throw err;
        }
        throw new Error(`Voicebox 400 — ${detail?.detail || "bad request"}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Voicebox ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`);
      }

      const audio = Buffer.from(await res.arrayBuffer());
      return { audio, format: "wav" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Triggers the async /generate path once so its engine/model gets cached, then waits for it to finish via its SSE status stream. */
  async _warmModel(profileId, text) {
    const generation = await this._fetchJson("/generate", {
      method: "POST",
      body: JSON.stringify({
        profile_id: profileId,
        text,
        language: this.language,
        engine: this.engine,
      }),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.warmupTimeoutMs);
    let body;
    try {
      const res = await fetch(`${this.baseUrl}/generate/${generation.id}/status`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Voicebox status ${res.status} ${res.statusText}`);
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const events = body
      .trim()
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data:")))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(5).trim()));

    const last = events[events.length - 1];
    if (!last || last.status !== "completed") {
      throw new Error(`Voicebox model warm-up failed: ${last?.error || last?.status || "no status received"}`);
    }
  }

  async _fetchJson(path, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        ...opts,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Voicebox ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`);
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
