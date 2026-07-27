import { describe, it, expect } from "vitest";
import { pauseSentence, sessionPauseSentence, MIN_INTERNAL_TO_SURFACE } from "./summary.js";

describe("pauseSentence", () => {
  it("stays silent below the surfacing threshold", () => {
    expect(pauseSentence({ total: 5, internal: 2, boundary: 3, unknown: 0 })).toBeNull();
  });

  it("names the count and gives one instruction when the threshold is met", () => {
    const s = pauseSentence({ total: 6, internal: 4, boundary: 2, unknown: 0 });
    expect(s).toContain("4");
    expect(s).toMatch(/comma|phrase/i);
  });

  it("never emits undefined, NaN or [object Object]", () => {
    const s = pauseSentence({ total: 9, internal: 9, boundary: 0, unknown: 0 });
    expect(s).not.toMatch(/undefined|NaN|\[object/);
  });

  it("stays under 120 characters so it fits one line under a bubble", () => {
    expect(pauseSentence({ total: 40, internal: 40, boundary: 0, unknown: 0 }).length).toBeLessThan(120);
  });

  it("exposes the threshold as a named constant", () => {
    expect(MIN_INTERNAL_TO_SURFACE).toBe(3);
  });
});

describe("sessionPauseSentence", () => {
  it("is silent when nothing accumulated", () => {
    expect(sessionPauseSentence({ total: 0, internal: 0, boundary: 0, unknown: 0 })).toBeNull();
  });

  it("reports the day and names tomorrow's focus", () => {
    const s = sessionPauseSentence({ total: 20, internal: 11, boundary: 9, unknown: 0 });
    expect(s).toBe("You broke mid-phrase 11 times today. Tomorrow starts with chunking.");
  });
});
