import { describe, it, expect } from "vitest";
import {
  PRON_MODES,
  DEFAULT_MODE,
  MAX_TEXT_LENGTH,
  MAX_AUDIO_BYTES,
  REPORT_VERSION,
  PRON_ERROR_CODES,
  clampScore,
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
