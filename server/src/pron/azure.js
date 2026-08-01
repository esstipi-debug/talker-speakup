import { clampScore, PRON_ERROR_CODES, validateReport } from "./contract.js";

/**
 * Azure Speech pronunciation-assessment adapter — a manually-selected,
 * budget-capped runtime supplement (design §13), never the default and never
 * auto-selected. Wrapped in BudgetCappedPron by the factory (./index.js) when
 * explicitly chosen. This class enforces presence of
 * AZURE_SPEECH_KEY and AZURE_SPEECH_REGION; provider selection is delegated to
 * the factory that instantiates this class.
 *
 * EXTERNAL CALL SITE — verified 2026-07-27 against:
 *   - https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short
 *   - https://learn.microsoft.com/azure/ai-services/speech-service/how-to-pronunciation-assessment
 *
 * Confirmed against live docs:
 *   - Auth header is `Ocp-Apim-Subscription-Key` (short-audio REST page).
 *   - `Pronunciation-Assessment` header carries base64-encoded JSON config
 *     (short-audio REST page, "Pronunciation assessment parameters").
 *   - Config keys `ReferenceText`, `GradingSystem`, `Granularity`, `Dimension`,
 *     `EnableMiscue` appear verbatim in that page's parameter table.
 *   - `Offset` / `Duration` are 100-nanosecond ticks (both pages, explicitly).
 *   - The nested response shape used below — NBest[].PronunciationAssessment,
 *     Words[].PronunciationAssessment, Phonemes[].PronunciationAssessment — is
 *     exactly the worked JSON example on the pronunciation-assessment page.
 *
 * NOT independently confirmed — verify against a real Azure resource before
 * this is ever pointed at a paid endpoint:
 *   - The endpoint HOST used here, `{region}.stt.speech.microsoft.com`, is the
 *     long-standing regional form used across Azure Speech SDK samples, but
 *     the short-audio REST page's CURRENT "Regions and endpoints" section
 *     documents a different, resource-name-based host instead:
 *     `https://{YourResourceName}.cognitiveservices.azure.com/stt/speech/recognition/...`.
 *     That page no longer shows the regional hostname anywhere. Which host
 *     (or whether both work) could not be confirmed from documentation alone.
 *     Override via AZURE_SPEECH_ENDPOINT when using a different host.
 *   - `PhonemeAlphabet` is not listed in that same REST parameter table (only
 *     ReferenceText/GradingSystem/Granularity/Dimension/EnableMiscue/
 *     EnableProsodyAssessment/ScenarioId are). It only appears, camelCase
 *     (`phonemeAlphabet`), in SDK `PronunciationAssessmentConfig.fromJson`
 *     samples on the other page — those samples configure the SDK, not
 *     necessarily the REST header verbatim. Casing/acceptance for the REST
 *     header specifically is unconfirmed.
 *   - The short-audio REST page also shows a second, FLAT example response for
 *     "recognition with pronunciation assessment" (scores directly on NBest/
 *     Word, no `PronunciationAssessment` wrapper) that contradicts the nested
 *     shape used here. The nested shape was kept because it is the one shown
 *     in a full worked example on the page specifically about pronunciation
 *     assessment, but the inconsistency between Microsoft's own pages is real
 *     and unresolved. `_toReport` refuses to guess which shape it received —
 *     see the `NBest[0].PronunciationAssessment` guard below — rather than
 *     silently mapping the flat shape's absent scores to zero.
 *   - Content-Type for the request body: the short-audio REST parameter
 *     tables only show WAV PCM examples (`audio/wav; codecs=audio/pcm;
 *     samplerate=...`). A real client upload arrives as whatever the
 *     browser's MediaRecorder produced — typically `audio/webm;
 *     codecs=opus` — not WAV. This adapter forwards the upload's actual
 *     MIME type as Content-Type (honest about what the bytes are) rather
 *     than mislabeling non-WAV audio as WAV PCM, but whether Azure's
 *     short-audio endpoint accepts anything other than WAV PCM is NOT
 *     confirmed from documentation alone — verify against a live resource
 *     before relying on a non-WAV drill against a real Azure key.
 */
const DEFAULTS = {
  locale: "en-US",
  timeoutMs: 30000,
};

const TICKS_PER_SECOND = 1e7; // Azure offsets are 100-nanosecond ticks
const DETAIL_CAP = 200;

function seconds(ticks) {
  return Math.round((Number(ticks) / TICKS_PER_SECOND) * 1000) / 1000;
}

/**
 * Azure JSON -> PronunciationReport. Deliberately emits no `substituted`:
 * Azure reports an ErrorType per word, not the phone it actually heard, and
 * inventing one would fabricate the single most pedagogically load-bearing
 * field in the contract.
 *
 * Refuses to map the alternate FLAT Azure response shape (see file header):
 * without `NBest[0].PronunciationAssessment`, every score would silently
 * clamp to 0 via `clampScore(undefined)`, shipping the learner a report that
 * claims they scored zero on everything instead of a clean failure.
 */
function _toReport(azureJson) {
  const best = azureJson?.NBest?.[0];
  if (!best?.PronunciationAssessment) {
    const err = new Error(
      "Azure response is missing NBest[0].PronunciationAssessment — refusing to map " +
        "scores from the unconfirmed flat response shape (see file header) rather " +
        "than fabricating zeros.",
    );
    err.code = PRON_ERROR_CODES.BAD_REPORT;
    throw err;
  }
  const assessment = best.PronunciationAssessment;
  const words = (best.Words ?? []).map((word) => {
    const start = seconds(word.Offset ?? 0);
    const end = seconds((word.Offset ?? 0) + (word.Duration ?? 0));
    const phones = (word.Phonemes ?? []).map((phone) => ({
      ipa: String(phone.Phoneme ?? ""),
      score: clampScore(phone.PronunciationAssessment?.AccuracyScore),
      start: seconds(phone.Offset ?? 0),
      end: seconds((phone.Offset ?? 0) + (phone.Duration ?? 0)),
    }));
    const mapped = {
      word: String(word.Word ?? ""),
      start,
      end,
      accuracy: clampScore(word.PronunciationAssessment?.AccuracyScore),
    };
    if (phones.length) mapped.phones = phones;
    return mapped;
  });

  const totalSec = words.length ? words.at(-1).end : 0;

  return {
    version: 1,
    mode: "scripted",
    pronProvider: "azure",
    model: "azure-pronunciation-assessment",
    // Required so BudgetCappedPron.recordUsage() has anything to meter at
    // all (design §13.2) — without this the monthly spend cap can never
    // engage. Reuses the same last-word-end computation already needed for
    // speechRateWpm below, rather than probing the audio a second time.
    durationSec: totalSec,
    overall: {
      accuracy: clampScore(assessment.AccuracyScore),
      fluency: clampScore(assessment.FluencyScore),
      completeness: clampScore(assessment.CompletenessScore),
    },
    prosody: {
      speechRateWpm: totalSec > 0 ? Math.round((words.length / totalSec) * 60 * 1000) / 1000 : 0,
      articulationRateSyllPerSec: 0,
      pauseCount: 0,
      pauseTotalSec: 0,
      f0MinHz: null,
      f0MaxHz: null,
      f0RangeSemitones: null,
    },
    words,
  };
}

export class AzurePron {
  constructor() {
    this.apiKey = process.env.AZURE_SPEECH_KEY?.trim() || null;
    this.region = process.env.AZURE_SPEECH_REGION?.trim() || null;
    this.locale = process.env.AZURE_SPEECH_LOCALE?.trim() || DEFAULTS.locale;
    this.timeoutMs = Number(process.env.AZURE_SPEECH_TIMEOUT_MS) || DEFAULTS.timeoutMs;
    this.endpoint = process.env.AZURE_SPEECH_ENDPOINT?.trim() || null;
  }

  _assessmentHeader(text) {
    const config = {
      ReferenceText: text,
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true,
      PhonemeAlphabet: "IPA",
    };
    return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  }

  /**
   * @param {Buffer} audioBuffer WAV is the only content type confirmed against
   *   Azure's documentation (see file header); pass `mimeType` for anything
   *   else and it is forwarded honestly as-is, never relabeled as WAV.
   * @param {{ text: string, mode?: "scripted"|"unscripted", filename?: string, mimeType?: string }} [opts]
   * @returns {Promise<import("./contract.js").PronunciationReport>}
   */
  async assess(audioBuffer, { text, mode = "scripted", filename = "drill.wav", mimeType } = {}) {
    void mode;
    void filename;
    if (!this.apiKey || !this.region) {
      const err = new Error("Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.");
      err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
      throw err;
    }

    const baseUrl = this.endpoint || `https://${this.region}.stt.speech.microsoft.com`;
    const url =
      baseUrl +
      `/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(this.locale)}`;

    // Honest, not hardcoded: the upload's real MIME type (threaded through
    // from the multer upload at the route layer) rather than a fixed WAV
    // label — see the "Content-Type" bullet in the file header for why
    // silently declaring non-WAV bytes as WAV would be a lie that
    // guarantees a 4xx from Azure.
    const contentType = mimeType || "audio/wav; codecs=audio/pcm; samplerate=16000";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json;
    try {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.apiKey,
            "Content-Type": contentType,
            Accept: "application/json",
            "Pronunciation-Assessment": this._assessmentHeader(text),
          },
          body: audioBuffer,
          signal: controller.signal,
        });
      } catch (err) {
        err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
        throw err;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(
          `Azure ${res.status} ${res.statusText} — ${detail.slice(0, DETAIL_CAP)}`,
        );
        err.code = PRON_ERROR_CODES.PRON_UNAVAILABLE;
        throw err;
      }
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const report = _toReport(json);
    const valid = validateReport(report);
    if (!valid.ok) {
      const err = new Error(`Azure returned an unmappable report — ${valid.error}`);
      err.code = PRON_ERROR_CODES.BAD_REPORT;
      throw err;
    }
    return report;
  }

  /**
   * Local-only readiness check — deliberately makes no network call. Azure's
   * short-audio REST API has no cheap health endpoint of its own, and
   * probing it would mean either spending real money on a synthetic
   * assessment or maintaining a second, unmetered call path; neither is
   * worth it just so `BudgetCappedPron.health()` (which delegates to
   * whatever `this.metered` is) has something to call.
   *
   * @returns {Promise<{ status: "ok"|"unconfigured", model: string }>}
   */
  async health() {
    return {
      status: this.apiKey && this.region ? "ok" : "unconfigured",
      model: "azure-pronunciation-assessment",
    };
  }
}
