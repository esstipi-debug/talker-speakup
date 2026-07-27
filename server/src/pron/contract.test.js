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
});
