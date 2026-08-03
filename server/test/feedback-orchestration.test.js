import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/feedback/harper.js", () => ({
  lintUtterance: vi.fn(),
  harperStatus: vi.fn(() => "ok"),
  setupHarper: vi.fn(),
}));
vi.mock("../src/feedback/upgrades.js", () => ({ requestUpgrades: vi.fn() }));
vi.mock("../src/repo/ledger.js", () => ({ getFrequencies: vi.fn(), recordFindings: vi.fn() }));

const { lintUtterance, harperStatus } = await import("../src/feedback/harper.js");
const { requestUpgrades } = await import("../src/feedback/upgrades.js");
const { getFrequencies, recordFindings } = await import("../src/repo/ledger.js");
const { buildFeedback } = await import("../src/feedback/index.js");

const UTTERANCE = "I have 30 years and the people is nice and I make a party";

const finding = (original, lintKind = "Agreement") => ({
  span: [UTTERANCE.indexOf(original), UTTERANCE.indexOf(original) + original.length],
  original, suggestion: "x", message: "m", lintKind, source: "harper",
});

beforeEach(() => {
  vi.clearAllMocks();
  getFrequencies.mockResolvedValue(new Map());
  recordFindings.mockResolvedValue(undefined);
  requestUpgrades.mockResolvedValue({ status: "ok", upgrades: [], extraCorrections: [] });
  harperStatus.mockReturnValue("ok");
});

describe("buildFeedback", () => {
  it("caps corrections at 2 and upgrades at 1", async () => {
    lintUtterance.mockResolvedValue([finding("I have 30 years"), finding("the people is"), finding("I make a party")]);
    requestUpgrades.mockResolvedValue({
      status: "ok",
      upgrades: [
        { original: "I have 30 years", upgraded: "I'm 30", why: "a" },
        { original: "the people is nice", upgraded: "everyone's lovely", why: "b" },
      ],
      extraCorrections: [],
    });
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections).toHaveLength(2);
    expect(out.upgrades).toHaveLength(1);
  });

  it("still writes the overflow to the ledger", async () => {
    lintUtterance.mockResolvedValue([finding("I have 30 years"), finding("the people is"), finding("I make a party")]);
    await buildFeedback({ utterance: UTTERANCE });
    expect(recordFindings).toHaveBeenCalledTimes(1);
    expect(recordFindings.mock.calls[0][0]).toHaveLength(3); // all three, not the capped two
  });

  it("orders by the learner's historical frequency, not by discovery order", async () => {
    lintUtterance.mockResolvedValue([finding("the people is"), finding("I have 30 years")]);
    const { toPattern } = await import("../src/feedback/pattern.js");
    getFrequencies.mockResolvedValue(new Map([[toPattern("grammar", "I have 30 years"), 9]]));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections[0].original).toBe("I have 30 years");
  });

  it("reports pass status honestly", async () => {
    lintUtterance.mockResolvedValue([]);
    requestUpgrades.mockResolvedValue({ status: "skipped", upgrades: [], extraCorrections: [] });
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.passes).toEqual({ mechanical: "ok", pedagogical: "skipped" });
  });

  it("marks the mechanical pass failed when Harper throws, and still returns", async () => {
    lintUtterance.mockRejectedValue(new Error("wasm exploded"));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.passes.mechanical).toBe("failed");
    expect(out.corrections).toEqual([]);
  });

  it("marks it unavailable when Harper never loaded", async () => {
    harperStatus.mockReturnValue("unavailable");
    lintUtterance.mockResolvedValue([]);
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.passes.mechanical).toBe("unavailable");
  });

  it("survives a ledger write failure", async () => {
    lintUtterance.mockResolvedValue([finding("I have 30 years")]);
    recordFindings.mockRejectedValue(new Error("db down"));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections).toHaveLength(1);
  });

  it("falls back to discovery order when the ledger read rejects", async () => {
    lintUtterance.mockResolvedValue([finding("the people is"), finding("I have 30 years")]);
    getFrequencies.mockRejectedValue(new Error("db down"));
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections).toHaveLength(2);
    expect(out.corrections[0].original).toBe("the people is");
  });

  it("surfaces LLM extraCorrections with source llm and a recovered span", async () => {
    lintUtterance.mockResolvedValue([]);
    requestUpgrades.mockResolvedValue({
      status: "ok",
      upgrades: [],
      extraCorrections: [{ original: "I make a party", suggestion: "throw a party", message: "collocation" }],
    });
    const out = await buildFeedback({ utterance: UTTERANCE });
    expect(out.corrections).toHaveLength(1);
    expect(out.corrections[0]).toMatchObject({
      original: "I make a party",
      suggestion: "throw a party",
      message: "collocation",
      source: "llm",
      span: [UTTERANCE.indexOf("I make a party"), UTTERANCE.indexOf("I make a party") + "I make a party".length],
    });
  });

  it("carries the hesitation block and a null sessionFluency below the floor", async () => {
    lintUtterance.mockResolvedValue([]);
    const out = await buildFeedback({ utterance: UTTERANCE, sessionPhonationMs: 1000, sessionSyllables: 5 });
    expect(out.hesitation.band).toBeDefined();
    expect(out.sessionFluency).toBeNull();
  });
});
