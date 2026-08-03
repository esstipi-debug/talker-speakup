import { describe, it, expect } from "vitest";
import { MockBrain } from "../src/brain/mock.js";

const TOPIC = "whether learning a language as an adult is harder than people claim";

describe("MockBrain.openTurn", () => {
  it("returns a coach line and xp, the same shape as evaluateTurn", async () => {
    const out = await new MockBrain().openTurn({ topic: TOPIC });
    expect(typeof out.coach_reply).toBe("string");
    expect(out.coach_reply.length).toBeGreaterThan(0);
    expect(typeof out.xp).toBe("number");
  });

  it("opens on the topic it was given", async () => {
    const out = await new MockBrain().openTurn({ topic: TOPIC });
    expect(out.coach_reply).toContain(TOPIC);
  });

  it("still produces an opening line with no topic at all", async () => {
    const out = await new MockBrain().openTurn({ topic: null });
    expect(out.coach_reply.length).toBeGreaterThan(0);
  });
});
