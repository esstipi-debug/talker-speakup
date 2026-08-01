import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AzurePron } from "./azure.js";
import { validateReport } from "./contract.js";

const AUDIO = Buffer.from("riff-bytes");

// Canned Azure short-audio pronunciation-assessment body. Offsets are
// 100-nanosecond ticks: 4_200_000 ticks = 0.42 s.
const AZURE_BODY = {
  RecognitionStatus: "Success",
  DisplayText: "Sheep.",
  NBest: [
    {
      Lexical: "sheep",
      PronunciationAssessment: { AccuracyScore: 41, FluencyScore: 84, CompletenessScore: 100 },
      Words: [
        {
          Word: "sheep",
          Offset: 4200000,
          Duration: 3900000,
          PronunciationAssessment: { AccuracyScore: 41, ErrorType: "Mispronunciation" },
          Phonemes: [
            { Phoneme: "ʃ", Offset: 4200000, Duration: 800000, PronunciationAssessment: { AccuracyScore: 88 } },
            { Phoneme: "iː", Offset: 5000000, Duration: 2200000, PronunciationAssessment: { AccuracyScore: 31 } },
            { Phoneme: "p", Offset: 7200000, Duration: 900000, PronunciationAssessment: { AccuracyScore: 79 } },
          ],
        },
      ],
    },
  ],
};

function response(body, { status = 200, statusText = "OK" } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

beforeEach(() => {
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_LOCALE;
  delete process.env.AZURE_SPEECH_TIMEOUT_MS;
  delete process.env.AZURE_SPEECH_ENDPOINT;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_LOCALE;
  delete process.env.AZURE_SPEECH_TIMEOUT_MS;
  delete process.env.AZURE_SPEECH_ENDPOINT;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("azure — guards", () => {
  it("refuses to run without a key or a region", async () => {
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.message).toBe("Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.");
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses with a key but no region", async () => {
    process.env.AZURE_SPEECH_KEY = "k";
    await expect(new AzurePron().assess(AUDIO, { text: "sheep" })).rejects.toThrow(
      "Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a whitespace-only key before any fetch", async () => {
    process.env.AZURE_SPEECH_KEY = "   \t  ";
    process.env.AZURE_SPEECH_REGION = "westeurope";
    await expect(new AzurePron().assess(AUDIO, { text: "sheep" })).rejects.toThrow(
      "Azure pron requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("azure — assess", () => {
  beforeEach(() => {
    process.env.AZURE_SPEECH_KEY = "secret-key";
    process.env.AZURE_SPEECH_REGION = "westeurope";
  });

  it("sends the reference text in the base64 Pronunciation-Assessment header", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    await new AzurePron().assess(AUDIO, { text: "sheep" });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("https://westeurope.stt.speech.microsoft.com/");
    expect(url).toContain("language=en-US");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("secret-key");
    const config = JSON.parse(
      Buffer.from(init.headers["Pronunciation-Assessment"], "base64").toString("utf8"),
    );
    expect(config).toMatchObject({
      ReferenceText: "sheep",
      Granularity: "Phoneme",
      PhonemeAlphabet: "IPA",
    });
  });

  it("uses AZURE_SPEECH_ENDPOINT when set", async () => {
    process.env.AZURE_SPEECH_ENDPOINT = "https://custom-endpoint.cognitiveservices.azure.com";
    fetch.mockResolvedValue(response(AZURE_BODY));
    await new AzurePron().assess(AUDIO, { text: "sheep" });

    const [url] = fetch.mock.calls[0];
    expect(url).toContain("https://custom-endpoint.cognitiveservices.azure.com/");
    expect(url).not.toContain("westeurope.stt.speech.microsoft.com");
  });

  it("uses default endpoint when AZURE_SPEECH_ENDPOINT is not set", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    await new AzurePron().assess(AUDIO, { text: "sheep" });

    const [url] = fetch.mock.calls[0];
    expect(url).toContain("https://westeurope.stt.speech.microsoft.com/");
  });

  it("maps the Azure body onto a valid PronunciationReport with seconds, not ticks", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    const report = await new AzurePron().assess(AUDIO, { text: "sheep" });

    expect(validateReport(report)).toEqual({ ok: true });
    expect(report.overall).toEqual({ accuracy: 41, fluency: 84, completeness: 100 });
    expect(report.words[0].start).toBe(0.42);
    expect(report.words[0].end).toBe(0.81);
    expect(report.words[0].phones.map((p) => p.ipa)).toEqual(["ʃ", "iː", "p"]);
    expect(report.words[0].phones[1]).toEqual({ ipa: "iː", score: 31, start: 0.5, end: 0.72 });
  });

  it("never invents a substitution — Azure does not report one", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    const report = await new AzurePron().assess(AUDIO, { text: "sheep" });
    expect(JSON.stringify(report)).not.toContain("substituted");
  });

  it("throws BAD_REPORT when the mapping produces something the contract rejects", async () => {
    fetch.mockResolvedValue(response({ RecognitionStatus: "Success", NBest: [] }));
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.code).toBe("BAD_REPORT");
  });

  it("surfaces a non-OK Azure response as PRON_UNAVAILABLE", async () => {
    fetch.mockResolvedValue(response("forbidden", { status: 403, statusText: "Forbidden" }));
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(error.message).toContain("Azure 403 Forbidden");
  });

  it("tags a network failure (fetch rejects before any response) as PRON_UNAVAILABLE", async () => {
    fetch.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: "ECONNREFUSED" }));
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(error.message).toBe("fetch failed");
  });

  it("stamps its own pronProvider so a wrapping BudgetCappedPron can report honestly even after a fallback swap elsewhere", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    const report = await new AzurePron().assess(AUDIO, { text: "sheep" });
    expect(report.pronProvider).toBe("azure");
  });

  it("includes durationSec on the report, derived from the last word's end time — required for BudgetCappedPron.recordUsage() to ever fire (finding 1)", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    const report = await new AzurePron().assess(AUDIO, { text: "sheep" });
    expect(typeof report.durationSec).toBe("number");
    expect(report.durationSec).toBeGreaterThanOrEqual(0);
    // AZURE_BODY's sole word ("sheep") ends at 0.42 + 0.39 = 0.81 s.
    expect(report.durationSec).toBe(0.81);
  });

  it("throws BAD_REPORT instead of a zero-filled report when the response uses the alternate flat shape (no PronunciationAssessment wrapper)", async () => {
    const flatBody = {
      RecognitionStatus: "Success",
      DisplayText: "Sheep.",
      NBest: [
        {
          Lexical: "sheep",
          // No `PronunciationAssessment` key at all — Microsoft's own docs
          // show this alternate flat shape on the same page (see the file
          // header comment). Mapping this naively would clampScore(undefined)
          // every score to 0 and ship a fabricated "you scored zero" report.
          Words: [{ Word: "sheep", Offset: 0, Duration: 3900000 }],
        },
      ],
    };
    fetch.mockResolvedValue(response(flatBody));
    const error = await new AzurePron().assess(AUDIO, { text: "sheep" }).catch((err) => err);
    expect(error.code).toBe("BAD_REPORT");
    expect(error.message).toContain("PronunciationAssessment");
    expect(error.message).not.toContain("must be an integer 0-100");
  });

  it("derives the Content-Type header from the upload's actual MIME type instead of asserting WAV", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    await new AzurePron().assess(AUDIO, { text: "sheep", mimeType: "audio/webm;codecs=opus" });
    const [, init] = fetch.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("audio/webm;codecs=opus");
  });

  it("falls back to the documented WAV content type when the caller supplies no mimeType", async () => {
    fetch.mockResolvedValue(response(AZURE_BODY));
    await new AzurePron().assess(AUDIO, { text: "sheep" });
    const [, init] = fetch.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("audio/wav; codecs=audio/pcm; samplerate=16000");
  });
});

describe("azure — health", () => {
  it("resolves ok without making any network call once key and region are configured", async () => {
    process.env.AZURE_SPEECH_KEY = "secret-key";
    process.env.AZURE_SPEECH_REGION = "westeurope";
    await expect(new AzurePron().health()).resolves.toEqual({
      status: "ok",
      model: "azure-pronunciation-assessment",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves (never throws) reporting unconfigured when key/region are missing — BudgetCappedPron.health() must never crash", async () => {
    await expect(new AzurePron().health()).resolves.toEqual({
      status: "unconfigured",
      model: "azure-pronunciation-assessment",
    });
  });
});
