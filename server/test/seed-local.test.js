import { describe, it, expect } from "vitest";
import { pickOpener, OPENERS } from "../src/seed/local.js";
import { nextSeed } from "../src/seed/index.js";

describe("seed/local", () => {
  it("is deterministic for a given n", () => {
    expect(pickOpener(7)).toEqual(pickOpener(7));
  });

  it("walks the whole rotation rather than favouring one entry", () => {
    const seen = new Set();
    for (let n = 0; n < OPENERS.length; n += 1) seen.add(pickOpener(n).topic);
    expect(seen.size).toBe(OPENERS.length);
  });

  it("handles a negative or huge n without falling off the array", () => {
    for (const n of [-1, -999, 0, Number.MAX_SAFE_INTEGER]) {
      expect(typeof pickOpener(n).topic).toBe("string");
      expect(pickOpener(n).topic.length).toBeGreaterThan(0);
    }
  });

  it("reports itself as the local provider with no source or item", () => {
    const seed = pickOpener(0);
    expect(seed.provider).toBe("local");
    expect(seed.sourceLabel).toBeNull();
    expect(seed.sourceUrl).toBeNull();
    expect(seed.topicId).toBeNull();
  });
});

describe("seed/index", () => {
  it("always returns a seed — local is the terminal provider", async () => {
    const seed = await nextSeed();
    expect(seed).not.toBeNull();
    expect(seed.provider).toBe("local");
    expect(typeof seed.topic).toBe("string");
  });
});
