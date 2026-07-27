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
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
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
});
