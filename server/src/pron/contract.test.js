import { describe, it, expect } from "vitest";
import {
  PRON_MODES,
  DEFAULT_MODE,
  MAX_TEXT_LENGTH,
  MAX_AUDIO_BYTES,
  REPORT_VERSION,
  PRON_ERROR_CODES,
  clampScore,
  validateAssessInput,
  validateReport,
  stripPhones,
} from "./contract.js";

describe("contract — constants", () => {
  it("freezes the mode enum so a caller cannot widen it at runtime", () => {
    expect(PRON_MODES).toEqual(["scripted", "unscripted"]);
    expect(Object.isFrozen(PRON_MODES)).toBe(true);
    expect(() => PRON_MODES.push("freestyle")).toThrow();
  });

  it("defaults to scripted and caps text at 300 chars / audio at 15 MB", () => {
    expect(DEFAULT_MODE).toBe("scripted");
    expect(PRON_MODES).toContain(DEFAULT_MODE);
    expect(MAX_TEXT_LENGTH).toBe(300);
    expect(MAX_AUDIO_BYTES).toBe(15728640);
    expect(REPORT_VERSION).toBe(1);
  });

  it("exposes every error code the routes and providers throw, keyed by itself", () => {
    for (const [key, value] of Object.entries(PRON_ERROR_CODES)) {
      expect(value).toBe(key);
    }
    expect(Object.keys(PRON_ERROR_CODES)).toEqual([
      "MISSING_AUDIO",
      "MISSING_TEXT",
      "TEXT_TOO_LONG",
      "INVALID_MODE",
      "AUDIO_TOO_LARGE",
      "UNKNOWN_FOCUS",
      "NO_SPEECH",
      "DECODE_FAILED",
      "UNPRONOUNCEABLE_TEXT",
      "PRON_UNAVAILABLE",
      "BAD_REPORT",
    ]);
  });
});

describe("contract — clampScore", () => {
  it("rounds to an integer inside 0-100", () => {
    expect(clampScore(41.4)).toBe(41);
    expect(clampScore(41.5)).toBe(42);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(100)).toBe(100);
  });

  it("clamps out-of-range values instead of propagating them into the report", () => {
    expect(clampScore(-12)).toBe(0);
    expect(clampScore(1000)).toBe(100);
  });

  it("maps non-finite input to 0 rather than emitting NaN into JSON", () => {
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(0);
    expect(clampScore(-Infinity)).toBe(0);
    expect(clampScore(undefined)).toBe(0);
  });
});

describe("contract — validateAssessInput", () => {
  const ok = { text: "The ship is full of sheep.", audioBytes: 2048 };

  it("trims the text and defaults the mode to scripted", () => {
    expect(validateAssessInput({ ...ok, text: "  the ship  " })).toEqual({
      ok: true,
      value: { text: "the ship", mode: "scripted" },
    });
  });

  it("passes an explicit unscripted mode through", () => {
    expect(validateAssessInput({ ...ok, mode: "unscripted" })).toEqual({
      ok: true,
      value: { text: "The ship is full of sheep.", mode: "unscripted" },
    });
  });

  it("rejects a missing or zero-length audio part with 400 MISSING_AUDIO", () => {
    expect(validateAssessInput({ text: "hi" })).toEqual({
      ok: false,
      status: 400,
      code: "MISSING_AUDIO",
      error: 'Missing "audio" file.',
    });
    expect(validateAssessInput({ text: "hi", audioBytes: 0 }).code).toBe("MISSING_AUDIO");
    expect(validateAssessInput({ text: "hi", audioBytes: 1.5 }).code).toBe("MISSING_AUDIO");
  });

  it("checks the audio size before the text so a huge upload is not blamed on the sentence", () => {
    expect(validateAssessInput({ text: "", audioBytes: MAX_AUDIO_BYTES + 1 })).toEqual({
      ok: false,
      status: 413,
      code: "AUDIO_TOO_LARGE",
      error: "That recording is too large. Keep drill takes under 15 MB.",
    });
  });

  it("rejects blank or non-string text with 400 MISSING_TEXT", () => {
    expect(validateAssessInput({ ...ok, text: "   " })).toEqual({
      ok: false,
      status: 400,
      code: "MISSING_TEXT",
      error: 'Missing "text" (the reference sentence, non-empty string).',
    });
    expect(validateAssessInput({ ...ok, text: 42 }).code).toBe("MISSING_TEXT");
    expect(validateAssessInput({ ...ok, text: undefined }).code).toBe("MISSING_TEXT");
  });

  it("measures the text length after trimming", () => {
    const exactly300 = "a".repeat(300);
    expect(validateAssessInput({ ...ok, text: `  ${exactly300}  ` }).ok).toBe(true);
    expect(validateAssessInput({ ...ok, text: "a".repeat(301) })).toEqual({
      ok: false,
      status: 400,
      code: "TEXT_TOO_LONG",
      error: "That reference sentence is too long. Keep it under 300 characters.",
    });
  });

  it("rejects an unknown mode but tolerates an omitted one", () => {
    expect(validateAssessInput({ ...ok, mode: "freestyle" })).toEqual({
      ok: false,
      status: 400,
      code: "INVALID_MODE",
      error: '"mode" must be "scripted" or "unscripted".',
    });
    expect(validateAssessInput({ ...ok, mode: undefined }).value.mode).toBe("scripted");
  });

  it("does not throw when called with no argument at all", () => {
    expect(validateAssessInput().code).toBe("MISSING_AUDIO");
  });

  it("rejects bad text before bad mode", () => {
    const result = validateAssessInput({ text: "", mode: "freestyle", audioBytes: 2048 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PRON_ERROR_CODES.MISSING_TEXT);
  });

  it("accepts audio exactly at the MAX_AUDIO_BYTES boundary", () => {
    const result = validateAssessInput({ ...ok, audioBytes: MAX_AUDIO_BYTES });
    expect(result.ok).toBe(true);
  });

  it("rejects negative audioBytes as missing audio", () => {
    const result = validateAssessInput({ ...ok, audioBytes: -1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PRON_ERROR_CODES.MISSING_AUDIO);
  });
});

function validReport() {
  return {
    version: 1,
    mode: "scripted",
    model: "mock",
    overall: { accuracy: 78, fluency: 84, completeness: 100 },
    prosody: {
      speechRateWpm: 132.5,
      articulationRateSyllPerSec: 4.2,
      pauseCount: 1,
      pauseTotalSec: 0.31,
      f0MinHz: null,
      f0MaxHz: null,
      f0RangeSemitones: null,
    },
    words: [
      {
        word: "sheep",
        start: 0.42,
        end: 0.81,
        accuracy: 41,
        phones: [
          { ipa: "ʃ", score: 88, start: 0.42, end: 0.5 },
          { ipa: "iː", score: 31, start: 0.5, end: 0.72, substituted: "ɪ" },
          { ipa: "p", score: 79, start: 0.72, end: 0.81 },
        ],
      },
    ],
  };
}

describe("contract — validateReport", () => {
  it("accepts the canonical scripted report", () => {
    expect(validateReport(validReport())).toEqual({ ok: true });
  });

  it("accepts a word with no phones (the unscripted shape)", () => {
    const report = validReport();
    delete report.words[0].phones;
    expect(validateReport(report)).toEqual({ ok: true });
  });

  it("rejects a wrong or missing version", () => {
    expect(validateReport({ ...validReport(), version: 2 }).error).toContain("report.version");
    expect(validateReport(null).ok).toBe(false);
    expect(validateReport("nope").ok).toBe(false);
  });

  it("rejects non-integer or out-of-range overall scores, naming the path", () => {
    const report = validReport();
    report.overall.fluency = 84.5;
    expect(validateReport(report).error).toBe("report.overall.fluency must be an integer 0-100.");
    report.overall.fluency = 101;
    expect(validateReport(report).error).toBe("report.overall.fluency must be an integer 0-100.");
  });

  it("requires all seven prosody keys with the declared types", () => {
    const report = validReport();
    delete report.prosody.pauseCount;
    expect(validateReport(report).error).toBe("report.prosody.pauseCount must be an integer >= 0.");

    const report2 = validReport();
    delete report2.prosody.f0MaxHz;
    expect(validateReport(report2).error).toBe("report.prosody.f0MaxHz must be a number >= 0 or null.");

    const report3 = validReport();
    report3.prosody.f0MaxHz = 220;
    expect(validateReport(report3)).toEqual({ ok: true });

    const report4 = validReport();
    report4.prosody.speechRateWpm = -1;
    expect(validateReport(report4).error).toBe(
      "report.prosody.speechRateWpm must be a number >= 0.",
    );

    const report5 = validReport();
    report5.prosody.articulationRateSyllPerSec = "fast";
    expect(validateReport(report5).error).toBe(
      "report.prosody.articulationRateSyllPerSec must be a number >= 0.",
    );

    const report6 = validReport();
    delete report6.prosody.pauseTotalSec;
    expect(validateReport(report6).error).toBe(
      "report.prosody.pauseTotalSec must be a number >= 0.",
    );

    const report7 = validReport();
    report7.prosody.f0MinHz = -5;
    expect(validateReport(report7).error).toBe(
      "report.prosody.f0MinHz must be a number >= 0 or null.",
    );

    const report8 = validReport();
    report8.prosody.f0RangeSemitones = "wide";
    expect(validateReport(report8).error).toBe(
      "report.prosody.f0RangeSemitones must be a number >= 0 or null.",
    );
  });

  it("rejects unknown keys on overall, prosody, words and phones", () => {
    const a = validReport();
    a.overall.pronScore = 80;
    expect(validateReport(a).error).toBe('report.overall has unknown key "pronScore".');

    const b = validReport();
    b.prosody.jitter = 0.1;
    expect(validateReport(b).error).toBe('report.prosody has unknown key "jitter".');

    const c = validReport();
    c.words[0].errorType = "Mispronunciation";
    expect(validateReport(c).error).toBe('report.words[0] has unknown key "errorType".');

    const d = validReport();
    d.words[0].phones[0].confidence = 0.9;
    expect(validateReport(d).error).toBe('report.words[0].phones[0] has unknown key "confidence".');
  });

  it("rejects an empty words array and an empty phones array", () => {
    const a = validReport();
    a.words = [];
    expect(validateReport(a).error).toBe("report.words must be a non-empty array.");

    const b = validReport();
    b.words[0].phones = [];
    expect(validateReport(b).error).toBe("report.words[0].phones must be a non-empty array.");
  });

  it("rejects an end before its start", () => {
    const a = validReport();
    a.words[0].end = 0.1;
    expect(validateReport(a).error).toBe("report.words[0].end must be a number >= start.");

    const b = validReport();
    b.words[0].phones[1].end = 0.4;
    expect(validateReport(b).error).toBe("report.words[0].phones[1].end must be a number >= start.");
  });

  it("rejects substituted: null and substituted: '' — absence is the only way to say 'correct'", () => {
    const a = validReport();
    a.words[0].phones[0].substituted = null;
    expect(validateReport(a).error).toContain("report.words[0].phones[0].substituted");

    const b = validReport();
    b.words[0].phones[0].substituted = "";
    expect(validateReport(b).error).toContain("report.words[0].phones[0].substituted");
  });

  it("rejects a substitution equal to the expected phone", () => {
    const report = validReport();
    report.words[0].phones[1].substituted = "iː";
    expect(validateReport(report).error).toBe(
      "report.words[0].phones[1].substituted must differ from ipa.",
    );
  });

  it("rejects report.overall when missing or not an object", () => {
    const a = validReport();
    delete a.overall;
    expect(validateReport(a).error).toBe("report.overall is missing.");

    const b = validReport();
    b.overall = "nope";
    expect(validateReport(b).error).toBe("report.overall is missing.");
  });

  it("rejects report.prosody when missing or not an object", () => {
    const a = validReport();
    delete a.prosody;
    expect(validateReport(a).error).toBe("report.prosody is missing.");

    const b = validReport();
    b.prosody = 5;
    expect(validateReport(b).error).toBe("report.prosody is missing.");
  });

  it("rejects a word entry that is missing or not an object", () => {
    const a = validReport();
    a.words[0] = null;
    expect(validateReport(a).error).toBe("report.words[0] is not an object.");

    const b = validReport();
    b.words[0] = "sheep";
    expect(validateReport(b).error).toBe("report.words[0] is not an object.");
  });

  it("rejects a word.word that is empty or not a string", () => {
    const a = validReport();
    a.words[0].word = "";
    expect(validateReport(a).error).toBe("report.words[0].word must be a non-empty string.");

    const b = validReport();
    b.words[0].word = 7;
    expect(validateReport(b).error).toBe("report.words[0].word must be a non-empty string.");
  });

  it("rejects a word.start that is negative or not a number", () => {
    const a = validReport();
    a.words[0].start = -0.1;
    expect(validateReport(a).error).toBe("report.words[0].start must be a number >= 0.");

    const b = validReport();
    b.words[0].start = "0";
    expect(validateReport(b).error).toBe("report.words[0].start must be a number >= 0.");
  });

  it("rejects a word.accuracy that is non-integer or out of range", () => {
    const a = validReport();
    a.words[0].accuracy = 100.5;
    expect(validateReport(a).error).toBe("report.words[0].accuracy must be an integer 0-100.");

    const b = validReport();
    b.words[0].accuracy = -1;
    expect(validateReport(b).error).toBe("report.words[0].accuracy must be an integer 0-100.");
  });

  it("rejects a phone entry that is missing or not an object", () => {
    const a = validReport();
    a.words[0].phones[0] = null;
    expect(validateReport(a).error).toBe("report.words[0].phones[0] is not an object.");

    const b = validReport();
    b.words[0].phones[0] = 42;
    expect(validateReport(b).error).toBe("report.words[0].phones[0] is not an object.");
  });

  it("rejects a phone.ipa that is empty or not a string", () => {
    const a = validReport();
    a.words[0].phones[0].ipa = "";
    expect(validateReport(a).error).toBe(
      "report.words[0].phones[0].ipa must be a non-empty string.",
    );

    const b = validReport();
    b.words[0].phones[0].ipa = 5;
    expect(validateReport(b).error).toBe(
      "report.words[0].phones[0].ipa must be a non-empty string.",
    );
  });

  it("rejects a phone.score that is non-integer or out of range", () => {
    const a = validReport();
    a.words[0].phones[0].score = 101;
    expect(validateReport(a).error).toBe(
      "report.words[0].phones[0].score must be an integer 0-100.",
    );

    const b = validReport();
    b.words[0].phones[0].score = 12.3;
    expect(validateReport(b).error).toBe(
      "report.words[0].phones[0].score must be an integer 0-100.",
    );
  });

  it("rejects a phone.start that is negative or not a number", () => {
    const a = validReport();
    a.words[0].phones[0].start = -0.01;
    expect(validateReport(a).error).toBe(
      "report.words[0].phones[0].start must be a number >= 0.",
    );

    const b = validReport();
    b.words[0].phones[0].start = "0";
    expect(validateReport(b).error).toBe(
      "report.words[0].phones[0].start must be a number >= 0.",
    );
  });

  it("accepts a phone whose end equals its start (zero duration)", () => {
    const report = validReport();
    report.words[0].phones[0].end = report.words[0].phones[0].start;
    expect(validateReport(report)).toEqual({ ok: true });
  });

  it("rejects a report with a missing or invalid mode", () => {
    const a = validReport();
    delete a.mode;
    expect(validateReport(a).error).toBe("report.mode must be one of scripted, unscripted.");

    const b = validReport();
    b.mode = "freestyle";
    expect(validateReport(b).error).toBe("report.mode must be one of scripted, unscripted.");
  });

  it("rejects a report with a missing or empty model", () => {
    const a = validReport();
    delete a.model;
    expect(validateReport(a).error).toBe("report.model must be a non-empty string.");

    const b = validReport();
    b.model = "";
    expect(validateReport(b).error).toBe("report.model must be a non-empty string.");

    const c = validReport();
    c.model = 7;
    expect(validateReport(c).error).toBe("report.model must be a non-empty string.");
  });

  it("validates pronProvider only when present, against the documented enum", () => {
    const a = validReport();
    a.pronProvider = "elevenlabs";
    expect(validateReport(a).error).toBe("report.pronProvider must be one of local, mock, azure.");

    const b = validReport();
    b.pronProvider = "azure";
    expect(validateReport(b)).toEqual({ ok: true });

    const c = validReport();
    expect("pronProvider" in c).toBe(false);
    expect(validateReport(c)).toEqual({ ok: true });
  });

  it("validates durationSec only when present, rejecting negatives and non-numbers", () => {
    const a = validReport();
    a.durationSec = -1;
    expect(validateReport(a).error).toBe("report.durationSec must be a number >= 0.");

    const b = validReport();
    b.durationSec = "4.2";
    expect(validateReport(b).error).toBe("report.durationSec must be a number >= 0.");

    const c = validReport();
    c.durationSec = 4.2;
    expect(validateReport(c)).toEqual({ ok: true });

    const d = validReport();
    d.durationSec = 0;
    expect(validateReport(d)).toEqual({ ok: true });
  });

  it("validates sampleRate only when present, rejecting anything but 16000", () => {
    const a = validReport();
    a.sampleRate = 44100;
    expect(validateReport(a).error).toBe("report.sampleRate must be 16000.");

    const b = validReport();
    b.sampleRate = 16000;
    expect(validateReport(b)).toEqual({ ok: true });
  });

  it("rejects an unexpected top-level key even when everything else validates — e.g. a rogue provider smuggling phone-shaped data outside words[].phones", () => {
    const a = validReport();
    a.phoneDetail = [{ gop: 0.9 }];
    expect(validateReport(a).error).toBe('report has unknown key "phoneDetail".');
  });
});

describe("contract — stripPhones", () => {
  it("removes phones from every word", () => {
    const stripped = stripPhones(validReport());
    expect(stripped.words).toHaveLength(1);
    for (const word of stripped.words) {
      expect("phones" in word).toBe(false);
      expect(word.word).toBe("sheep");
      expect(word.accuracy).toBe(41);
    }
  });

  it("never mutates the input report", () => {
    const original = validReport();
    const before = JSON.stringify(original);
    stripPhones(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(original.words[0].phones).toHaveLength(3);
  });

  it("returns new objects, not shared references", () => {
    const original = validReport();
    const stripped = stripPhones(original);
    expect(stripped).not.toBe(original);
    expect(stripped.words).not.toBe(original.words);
    expect(stripped.words[0]).not.toBe(original.words[0]);
  });

  it("produces a report that still validates", () => {
    expect(validateReport(stripPhones(validReport()))).toEqual({ ok: true });
  });

  it("is a no-op on a report whose words already carry no phones", () => {
    const source = stripPhones(validReport());
    expect(stripPhones(source)).toEqual(source);
  });

  it("removes phones from every word in a multi-word report, including words with no phones key", () => {
    const multiWordReport = {
      version: 1,
      mode: "scripted",
      model: "mock",
      overall: { accuracy: 78, fluency: 84, completeness: 100 },
      prosody: {
        speechRateWpm: 132.5,
        articulationRateSyllPerSec: 4.2,
        pauseCount: 1,
        pauseTotalSec: 0.31,
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: [
        {
          word: "sheep",
          start: 0.42,
          end: 0.81,
          accuracy: 41,
          phones: [
            { ipa: "ʃ", score: 88, start: 0.42, end: 0.5 },
            { ipa: "iː", score: 31, start: 0.5, end: 0.72, substituted: "ɪ" },
            { ipa: "p", score: 79, start: 0.72, end: 0.81 },
          ],
        },
        {
          word: "is",
          start: 0.81,
          end: 1.05,
          accuracy: 92,
          phones: [
            { ipa: "ɪ", score: 95, start: 0.81, end: 0.95 },
            { ipa: "z", score: 88, start: 0.95, end: 1.05 },
          ],
        },
        {
          word: "full",
          start: 1.05,
          end: 1.42,
          accuracy: 75,
        },
      ],
    };

    const stripped = stripPhones(multiWordReport);
    expect(stripped.words).toHaveLength(3);
    expect(stripped.words.every((w) => !("phones" in w))).toBe(true);
    expect(stripped.words[0].word).toBe("sheep");
    expect(stripped.words[1].word).toBe("is");
    expect(stripped.words[2].word).toBe("full");
  });
});
