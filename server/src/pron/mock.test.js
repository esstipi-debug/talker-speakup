import { describe, it, expect } from "vitest";
import { MockPron, hashText } from "./mock.js";
import { validateReport } from "./contract.js";

const AUDIO = Buffer.alloc(16000 * 2 * 3); // 3 s of 16 kHz 16-bit PCM
const TEXT = "The ship is full of sheep.";

describe("mock — hashText", () => {
  it("is a stable FNV-1a 32-bit hash", () => {
    expect(hashText("")).toBe(2166136261);
    expect(hashText("a")).toBe(0xe40c292c);
    expect(hashText("foobar")).toBe(0xbf9cf968);
  });

  it("returns an unsigned 32-bit integer for any input", () => {
    for (const sample of ["", "a", "sheep", "The ship is full of sheep."]) {
      const value = hashText(sample);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("mock — MockPron.assess", () => {
  it("returns a report that passes the contract validator", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(validateReport(report)).toEqual({ ok: true });
    expect(report.version).toBe(1);
    expect(report.model).toBe("mock");
    expect(report.mode).toBe("scripted");
  });

  it("is deterministic — same text and audio, byte-identical report", async () => {
    const a = await new MockPron().assess(AUDIO, { text: TEXT });
    const b = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces different scores for different text", async () => {
    const a = await new MockPron().assess(AUDIO, { text: "The ship is full of sheep." });
    const b = await new MockPron().assess(AUDIO, { text: "She sells sea shells." });
    expect(a.overall.accuracy).not.toBe(b.overall.accuracy);
  });

  it("emits one word per whitespace token with punctuation stripped", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "Hello, world!" });
    expect(report.words.map((w) => w.word)).toEqual(["Hello", "world"]);
  });

  it("falls back to the raw tokens when punctuation stripping would empty the sentence", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "..." });
    expect(report.words.map((w) => w.word)).toEqual(["..."]);
    expect(validateReport(report)).toEqual({ ok: true });
  });

  it("gives every word between 1 and 6 phones, sized from the word length", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "a sheep internationalization" });
    const counts = report.words.map((w) => w.phones.length);
    expect(counts).toEqual([1, 2, 6]);
  });

  it("lays phones out contiguously across the clip duration", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    const phones = report.words.flatMap((w) => w.phones);
    expect(phones[0].start).toBe(0);
    for (let i = 1; i < phones.length; i += 1) {
      expect(phones[i].start).toBe(phones[i - 1].end);
    }
    expect(phones.at(-1).end).toBeCloseTo(3, 2);
    for (const word of report.words) {
      expect(word.start).toBe(word.phones[0].start);
      expect(word.end).toBe(word.phones.at(-1).end);
    }
  });

  it("omits substituted rather than emitting null, and only substitutes below 50", async () => {
    const report = await new MockPron().assess(AUDIO, {
      text: "the ship is full of sheep and the sailor watched them jump",
    });
    const phones = report.words.flatMap((w) => w.phones);
    const substituted = phones.filter((p) => "substituted" in p);
    expect(substituted.length).toBeGreaterThan(0);
    for (const phone of phones) {
      if ("substituted" in phone) {
        expect(phone.score).toBeLessThan(50);
        expect(phone.substituted).not.toBe(phone.ipa);
        expect(typeof phone.substituted).toBe("string");
      }
    }
    expect(JSON.stringify(report)).not.toContain('"substituted":null');
  });

  it("keeps every score inside 0-100 and reports completeness 100", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(report.overall.completeness).toBe(100);
    expect(report.overall.fluency).toBeGreaterThanOrEqual(60);
    expect(report.overall.fluency).toBeLessThanOrEqual(100);
    for (const phone of report.words.flatMap((w) => w.phones)) {
      expect(phone.score).toBeGreaterThanOrEqual(20);
      expect(phone.score).toBeLessThanOrEqual(100);
    }
  });

  it("ignores mode — stripping is the route's job for every provider", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT, mode: "unscripted" });
    expect(report.mode).toBe("unscripted");
    expect(report.words[0].phones.length).toBeGreaterThan(0);
  });

  it("emits null F0 fields in stage 1", async () => {
    const { prosody } = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(prosody.f0MinHz).toBeNull();
    expect(prosody.f0MaxHz).toBeNull();
    expect(prosody.f0RangeSemitones).toBeNull();
    expect(prosody.pauseCount).toBeGreaterThanOrEqual(0);
  });

  it("handles empty string input and returns a valid report", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "" });
    expect(validateReport(report)).toEqual({ ok: true });
    expect(report.words.length).toBeGreaterThan(0);
  });

  it("handles whitespace-only input and returns a valid report", async () => {
    const report = await new MockPron().assess(AUDIO, { text: "   " });
    expect(validateReport(report)).toEqual({ ok: true });
    expect(report.words.length).toBeGreaterThan(0);
  });

  it("is deterministic for empty string input and emits the blank placeholder", async () => {
    const a = await new MockPron().assess(AUDIO, { text: "" });
    const b = await new MockPron().assess(AUDIO, { text: "" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(validateReport(a)).toEqual({ ok: true });
    expect(a.words[0].word).toBe("(blank)");
    expect(a.words[0].word.trim()).not.toBe("");
  });

  it("is deterministic for whitespace-only input and emits the blank placeholder", async () => {
    const a = await new MockPron().assess(AUDIO, { text: "   " });
    const b = await new MockPron().assess(AUDIO, { text: "   " });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(validateReport(a)).toEqual({ ok: true });
    expect(a.words[0].word).toBe("(blank)");
    expect(a.words[0].word.trim()).not.toBe("");
  });

  it("stamps its own pronProvider so a wrapping BudgetCappedPron fallback reports honestly, not whatever the configured provider was (finding 2)", async () => {
    const report = await new MockPron().assess(AUDIO, { text: TEXT });
    expect(report.pronProvider).toBe("mock");
  });
});

describe("mock — health", () => {
  it("resolves without throwing, matching the interface BudgetCappedPron.health() expects of whichever provider it holds", async () => {
    await expect(new MockPron().health()).resolves.toEqual({ status: "ok", model: "mock" });
  });
});
