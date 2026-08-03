import { describe, it, expect } from "vitest";
import { computeDelivery } from "../src/metrics/delivery.js";

const clean = "I went to the market and bought some vegetables for dinner tonight";

describe("computeDelivery — hesitation", () => {
  it("is steady on clean text with only boundary pauses", () => {
    const out = computeDelivery({
      text: clean,
      prosody: { total: 2, internal: 0, boundary: 2, unknown: 0 },
    });
    expect(out.hesitation.band).toBe("steady");
    expect(out.hesitation.basis).toBe("audio");
    expect(out.hesitation.midPhrasePauses).toBe(0);
  });

  it("counts fillers and self-repairs from the text", () => {
    const out = computeDelivery({
      text: "I um went to the uh market, I mean the shop, you know",
      prosody: null,
    });
    expect(out.hesitation.fillers).toBe(3); // um, uh, you know
    expect(out.hesitation.selfRepairs).toBe(1); // I mean
  });

  it("reports text-only basis when there is no prosody", () => {
    expect(computeDelivery({ text: clean, prosody: null }).hesitation.basis).toBe("text-only");
  });

  it("stays steady with a 0-denominator per10w when the text has no words", () => {
    const out = computeDelivery({ text: "", prosody: null });
    expect(out.hesitation.band).toBe("steady");
    expect(out.hesitation.fillers).toBe(0);
  });

  it("escalates to effortful when mid-phrase pauses dominate", () => {
    const out = computeDelivery({
      text: "I wanted to go but",
      prosody: { total: 6, internal: 5, boundary: 1, unknown: 0 },
    });
    expect(out.hesitation.band).toBe("effortful");
  });
});

describe("computeDelivery — sessionFluency", () => {
  it("is null below the phonation floor", () => {
    const out = computeDelivery({ text: clean, prosody: null, sessionPhonationMs: 4999, sessionSyllables: 20 });
    expect(out.sessionFluency).toBeNull();
  });

  it("is null with zero syllables even when phonation is above the floor", () => {
    const out = computeDelivery({ text: clean, prosody: null, sessionPhonationMs: 6000, sessionSyllables: 0 });
    expect(out.sessionFluency).toBeNull();
  });

  it("is a number at or above the floor", () => {
    const out = computeDelivery({ text: clean, prosody: null, sessionPhonationMs: 6000, sessionSyllables: 27 });
    expect(typeof out.sessionFluency).toBe("number");
    expect(out.sessionFluency).toBeGreaterThanOrEqual(0);
    expect(out.sessionFluency).toBeLessThanOrEqual(100);
  });

  it("penalises both directions — the target band scores higher than fast or slow", () => {
    const score = (syll, ms) => computeDelivery({ text: clean, prosody: null, sessionPhonationMs: ms, sessionSyllables: syll }).sessionFluency;
    const onTarget = score(40, 10000); // 4.0 syll/s
    const tooFast = score(85, 10000);  // 8.5 syll/s
    const tooSlow = score(15, 10000);  // 1.5 syll/s
    expect(onTarget).toBeGreaterThan(tooFast);
    expect(onTarget).toBeGreaterThan(tooSlow);
  });
});
