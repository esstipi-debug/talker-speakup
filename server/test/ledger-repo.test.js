import { describe, it, expect } from "vitest";
import { recordFindings, getFrequencies } from "../src/repo/ledger.js";

const entry = (pattern) => ({ pattern, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." });

describe("ledger repo", () => {
  it("creates a row at frequency 1 and increments on the second sighting", async () => {
    const p = `grammar:test-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toBe(1);
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toBe(2);
  });

  it("omits unseen patterns from the map rather than returning zero", async () => {
    const freqs = await getFrequencies(["grammar:never-seen-at-all"]);
    expect(freqs.has("grammar:never-seen-at-all")).toBe(false);
  });

  it("accepts an empty batch without touching the database", async () => {
    await expect(recordFindings([])).resolves.toBeUndefined();
    expect((await getFrequencies([])).size).toBe(0);
  });
});
