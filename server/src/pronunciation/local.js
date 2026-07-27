/**
 * HTTP client for the MFA sidecar. Unreachable and timed-out are the SAME
 * outcome: `{ scored: false, reason: 'scorer-offline' }`. Callers never see an
 * exception for a container being down — that is a normal state, not an error.
 */

// UNCALIBRATED — spec §4.5: a cold align_one is plausibly 4-10s; 30s is a
// project-chosen margin on top of that, not a measured bound.
const DEFAULT_TIMEOUT_MS = 30_000;

export class LocalPronunciation {
  constructor({ baseUrl = process.env.PRON_SIDECAR_URL || "http://127.0.0.1:7654", timeoutMs = Number(process.env.PRON_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async score(pcmBuffer, referenceText) {
    const form = new FormData();
    form.append("audio", new Blob([pcmBuffer], { type: "audio/wav" }), "attempt.wav");
    form.append("text", referenceText);

    try {
      const res = await fetch(`${this.baseUrl}/align`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 503) return { scored: false, reason: "scorer-busy" };
      if (!res.ok) return { scored: false, reason: "scorer-error", status: res.status };
      const data = await res.json();
      return { scored: true, provider: "local", referenceText, words: data.words ?? [] };
    } catch {
      // Connect-refused, DNS, abort-on-timeout — all one state to the caller.
      return { scored: false, reason: "scorer-offline" };
    }
  }
}
