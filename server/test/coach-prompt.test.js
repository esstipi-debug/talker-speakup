import { describe, it, expect, afterEach } from "vitest";
import { coachSystemM1, coachSystemM2, selectCoachPrompt } from "../src/prompts/coach-system.js";

afterEach(() => { delete process.env.COACH_PROMPT; });

describe("coach system prompt", () => {
  it("targets C1–C2", () => {
    expect(coachSystemM2).toContain("C1–C2");
  });

  it("no longer forbids correction as a blanket rule", () => {
    expect(coachSystemM2).not.toContain("Do NOT correct grammar yet");
  });

  it("still forbids inline correction in the spoken line", () => {
    // Corrections belong in the panel, not in the coach's voice.
    expect(coachSystemM2.toLowerCase()).toContain("do not correct");
  });

  it("carries an explicit pressure policy", () => {
    for (const cue of ["elaborate", "one-word", "abstract"]) {
      expect(coachSystemM2.toLowerCase()).toContain(cue);
    }
  });
});

describe("selectCoachPrompt", () => {
  it("defaults to M2", () => {
    expect(selectCoachPrompt()).toBe(coachSystemM2);
  });

  it("returns the frozen M1 baseline when asked", () => {
    process.env.COACH_PROMPT = "m1";
    expect(selectCoachPrompt()).toBe(coachSystemM1);
  });

  it("falls back to M2 on an unknown value rather than throwing", () => {
    process.env.COACH_PROMPT = "banana";
    expect(selectCoachPrompt()).toBe(coachSystemM2);
  });

  it("keeps the M1 baseline byte-frozen", () => {
    // The whole point of M1 is being the UNALTERED prompt that shipped before
    // M2, so the two can be A/B'd on real conversation. A substring check
    // would let a reworded middle sentence through and quietly invalidate
    // every comparison made afterwards. If this test fails, either revert the
    // edit to coachSystemM1 or accept that the baseline is gone.
    expect(coachSystemM1).toBe(`You are SpeakUp, a warm and encouraging English conversation coach for a Spanish-speaking adult (level C1–C2).
Keep the conversation flowing naturally. Reply with ONE short, friendly turn — a question or a response — to keep them talking.
Speak only in English. Do NOT correct grammar yet, and do NOT add notes, labels, or translations. Output only your spoken line.`);
  });
});
