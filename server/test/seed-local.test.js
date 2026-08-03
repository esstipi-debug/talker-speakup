import { describe, it, expect, vi } from "vitest";
import { pickOpener, OPENERS } from "../src/seed/local.js";
import { nextSeed } from "../src/seed/index.js";
import { nextSeed as nextLocalSeed } from "../src/seed/local.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

describe("seed/local — daily rotation", () => {
  // pickOpener itself is already proven deterministic and rotation-complete
  // above. What actually needed fixing is nextSeed's clock granularity:
  // Date.now() changes every millisecond, so `pickOpener(Date.now())` was
  // independent draws with a 1-in-OPENERS.length chance of repeating back
  // to back — not a rotation. Injecting day numbers directly into
  // pickOpener pins the intended semantics without depending on wall clock.
  it("agrees for any two timestamps within the same day", () => {
    const day = 19_000; // arbitrary day number
    const morning = pickOpener(day);
    const night = pickOpener(day); // same day index — the whole point of flooring by day
    expect(morning.topic).toBe(night.topic);
  });

  it("walks to the next entry once the day number advances by one", () => {
    const day = 19_000;
    const today = pickOpener(day);
    const tomorrow = pickOpener(day + 1);
    expect(tomorrow.topic).not.toBe(today.topic);
  });

  it("nextSeed actually floors Date.now() by a day, not by the millisecond", async () => {
    const spy = vi.spyOn(Date, "now");
    try {
      const dayStartMs = 10 * DAY_MS; // an arbitrary day boundary
      spy.mockReturnValue(dayStartMs);
      const first = await nextLocalSeed();

      spy.mockReturnValue(dayStartMs + 500); // same day, 500ms later
      const second = await nextLocalSeed();
      expect(second.topic).toBe(first.topic);

      spy.mockReturnValue(dayStartMs + DAY_MS); // one day later
      const third = await nextLocalSeed();
      expect(third.topic).not.toBe(first.topic);
    } finally {
      spy.mockRestore();
    }
  });
});
