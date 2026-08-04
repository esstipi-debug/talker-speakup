import { describe, it, expect } from "vitest";
import { chooseProbe, PROBE_TURN_INTERVAL, MIN_PROBE_FREQUENCY, PROBE_POOL_SIZE } from "../src/coach/probe.js";

const candidate = (overrides) => ({
  pattern: "grammar:i have # years",
  example: "I have 30 years",
  explanation: "Age takes 'be', not 'have'.",
  frequency: MIN_PROBE_FREQUENCY,
  status: "active",
  lastProbedAt: null,
  ...overrides,
});

describe("coach/probe — chooseProbe", () => {
  it("fires on the configured turn interval", () => {
    const result = chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result).not.toBeNull();
    expect(result.pattern).toBe("grammar:i have # years");
  });

  it("never fires on turnsSoFar === 0, even with eligible candidates", () => {
    expect(chooseProbe({ candidates: [candidate()], turnsSoFar: 0 })).toBeNull();
  });

  it("does not fire off the interval", () => {
    expect(chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL - 1 })).toBeNull();
    expect(chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL + 1 })).toBeNull();
  });

  it("returns null with no candidates", () => {
    expect(chooseProbe({ candidates: [], turnsSoFar: PROBE_TURN_INTERVAL })).toBeNull();
  });

  it("ignores candidates below the minimum frequency", () => {
    const low = candidate({ pattern: "p:low", frequency: MIN_PROBE_FREQUENCY - 1 });
    expect(chooseProbe({ candidates: [low], turnsSoFar: PROBE_TURN_INTERVAL })).toBeNull();
  });

  it("ignores resolved candidates", () => {
    const resolved = candidate({ pattern: "p:resolved", status: "resolved", frequency: 99 });
    expect(chooseProbe({ candidates: [resolved], turnsSoFar: PROBE_TURN_INTERVAL })).toBeNull();
  });

  it("includes improving candidates, not only active ones", () => {
    const improving = candidate({ pattern: "p:improving", status: "improving" });
    const result = chooseProbe({ candidates: [improving], turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result?.pattern).toBe("p:improving");
  });

  it("pools the top PROBE_POOL_SIZE by frequency and rotates to the oldest-probed of that pool", () => {
    const candidates = [
      candidate({ pattern: "p:1", frequency: 10, lastProbedAt: "2026-08-01T00:00:00Z" }),
      candidate({ pattern: "p:2", frequency: 9, lastProbedAt: "2026-07-01T00:00:00Z" }), // oldest in pool
      candidate({ pattern: "p:3", frequency: 8, lastProbedAt: "2026-08-02T00:00:00Z" }),
      // Outside the pool (pool size 3): highest frequency here would win if pooling were broken.
      candidate({ pattern: "p:4", frequency: 100, lastProbedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(candidates.length).toBeGreaterThan(PROBE_POOL_SIZE);
    const result = chooseProbe({ candidates, turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result.pattern).toBe("p:2");
  });

  it("treats a never-probed candidate (null lastProbedAt) as older than any timestamp", () => {
    const candidates = [
      candidate({ pattern: "p:never", lastProbedAt: null }),
      candidate({ pattern: "p:old", lastProbedAt: "2020-01-01T00:00:00Z" }),
    ];
    const result = chooseProbe({ candidates, turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result.pattern).toBe("p:never");
  });

  it("the directive quotes the example and explanation, never the pattern key", () => {
    const result = chooseProbe({
      candidates: [candidate({ example: "I have 30 years", explanation: "Age takes 'be'." })],
      turnsSoFar: PROBE_TURN_INTERVAL,
    });
    expect(result.directive).toContain("I have 30 years");
    expect(result.directive).toContain("Age takes 'be'.");
    expect(result.directive).not.toContain("grammar:i have # years");
  });

  it("the directive never announces itself as a test", () => {
    const result = chooseProbe({ candidates: [candidate()], turnsSoFar: PROBE_TURN_INTERVAL });
    expect(result.directive.toLowerCase()).not.toContain("this is a test");
  });
});
