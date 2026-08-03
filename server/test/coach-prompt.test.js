import { describe, it, expect, afterEach } from "vitest";
import { coachSystemM1, coachSystemM2, selectCoachPrompt, buildOpeningPrompt } from "../src/prompts/coach-system.js";

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

describe("buildOpeningPrompt", () => {
  const TOPIC = "whether a city is better judged by its public transport or its food";

  it("carries the active coach prompt, so pressure and register still apply", () => {
    const built = buildOpeningPrompt(TOPIC);
    expect(built).toContain("YOUR ENGLISH IS THE LESSON");
  });

  it("includes the topic", () => {
    expect(buildOpeningPrompt(TOPIC)).toContain(TOPIC);
  });

  it("forbids assuming the learner has seen or read anything", () => {
    expect(buildOpeningPrompt(TOPIC).toLowerCase()).toContain("never assume");
  });

  it("delimits the topic as data rather than splicing it into instructions", () => {
    // The topic is untrusted text in phase 2 — it comes from a feed. Even now,
    // it must sit inside a marked block so a topic containing instruction-like
    // wording cannot read as an instruction.
    const built = buildOpeningPrompt(TOPIC);
    const block = built.slice(built.indexOf("<topic>"), built.indexOf("</topic>") + 8);
    expect(block).toContain(TOPIC);
  });

  it("still opens on a topic when COACH_PROMPT is the frozen m1 baseline", () => {
    process.env.COACH_PROMPT = "m1";
    try {
      expect(buildOpeningPrompt(TOPIC)).toContain(TOPIC);
    } finally {
      delete process.env.COACH_PROMPT;
    }
  });
});
