import { describe, it, expect } from "vitest";
import { classifyPauses, summarise } from "./placement.js";

const pause = (startMs, endMs) => ({ startMs, endMs, durationMs: endMs - startMs });

describe("classifyPauses", () => {
  it("marks a pause as boundary when a finalization lands inside it", () => {
    const result = classifyPauses([pause(1000, 1400)], [{ tMs: 1200, text: "I went home" }]);
    expect(result[0].placement).toBe("boundary");
  });

  it("marks a pause as boundary when the preceding chunk ends in punctuation", () => {
    const result = classifyPauses(
      [pause(2000, 2400)],
      [{ tMs: 900, text: "I went home," }, { tMs: 3000, text: "then I slept" }],
    );
    expect(result[0].placement).toBe("boundary");
  });

  it("marks a pause as internal when it sits inside one chunk with no punctuation", () => {
    const result = classifyPauses(
      [pause(2000, 2400)],
      [{ tMs: 900, text: "I think" }, { tMs: 3000, text: "that we should go" }],
    );
    expect(result[0].placement).toBe("internal");
  });

  it("marks a trailing pause as unknown — nothing finalized after it", () => {
    const result = classifyPauses([pause(2000, 2400)], [{ tMs: 900, text: "I think" }]);
    expect(result[0].placement).toBe("unknown");
  });

  it("treats a recognizer restart as a finalization, so the hole reads as boundary", () => {
    // A restart pushes a finalization at the moment of the gap.
    const result = classifyPauses([pause(1000, 1900)], [{ tMs: 1500, text: "" }]);
    expect(result[0].placement).toBe("boundary");
  });
});

describe("summarise", () => {
  it("counts each placement and excludes unknown from the total", () => {
    const classified = [
      { placement: "internal" }, { placement: "internal" },
      { placement: "boundary" }, { placement: "unknown" },
    ];
    expect(summarise(classified)).toEqual({ total: 3, internal: 2, boundary: 1, unknown: 1 });
  });
});
