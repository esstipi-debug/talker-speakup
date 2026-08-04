import { describe, it, expect } from "vitest";
import {
  recordFindings,
  getFrequencies,
  getProbeCandidates,
  markProbed,
  applyProbeOutcome,
  listPatterns,
} from "../src/repo/ledger.js";

const entry = (pattern) => ({ pattern, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." });

describe("ledger repo", () => {
  it("creates a row at frequency 1 and increments on the second sighting", async () => {
    const p = `grammar:test-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toEqual({ frequency: 1, status: "active" });
    await recordFindings([entry(p)]);
    expect((await getFrequencies([p])).get(p)).toEqual({ frequency: 2, status: "active" });
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

describe("ledger repo — relapse resets status", () => {
  it("a fresh sighting on a resolved pattern returns it to active with the counter zeroed", async () => {
    const p = `grammar:relapse-${Math.random().toString(36).slice(2)}`;
    // Drive it to resolved via the real transition path this repo now uses.
    await recordFindings([entry(p)]);
    await applyProbeOutcome(p, true);
    await applyProbeOutcome(p, true);
    await applyProbeOutcome(p, true);
    const resolved = (await getFrequencies([p])).get(p);
    expect(resolved.status).toBe("resolved");

    await recordFindings([entry(p)]); // the mistake happened again, unprompted
    const relapsed = (await getFrequencies([p])).get(p);
    expect(relapsed.status).toBe("active");

    const candidates = await getProbeCandidates();
    const row = candidates.find((c) => c.pattern === p);
    expect(row.status).toBe("active");
  });
});

describe("ledger repo — getProbeCandidates", () => {
  it("returns rows with the shape coach/probe.js expects, unfiltered by status", async () => {
    const p = `grammar:candidate-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    const candidates = await getProbeCandidates();
    const row = candidates.find((c) => c.pattern === p);
    expect(row).toMatchObject({ pattern: p, frequency: 1, status: "active" });
    expect(row).toHaveProperty("example");
    expect(row).toHaveProperty("explanation");
    expect(row).toHaveProperty("lastProbedAt");
  });
});

describe("ledger repo — markProbed", () => {
  it("stamps lastProbedAt on the given pattern", async () => {
    const p = `grammar:probed-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    await markProbed(p);
    const candidates = await getProbeCandidates();
    const row = candidates.find((c) => c.pattern === p);
    expect(row.lastProbedAt).not.toBeNull();
  });
});

describe("ledger repo — applyProbeOutcome", () => {
  it("passing a probe moves the pattern toward improving", async () => {
    const p = `grammar:outcome-pass-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    const result = await applyProbeOutcome(p, true);
    expect(result).toEqual({ pattern: p, passed: true, status: "improving" });
  });

  it("failing a probe keeps the pattern active with the counter zeroed", async () => {
    const p = `grammar:outcome-fail-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    await applyProbeOutcome(p, true); // improving, probesPassed 1
    const result = await applyProbeOutcome(p, false);
    expect(result).toEqual({ pattern: p, passed: false, status: "active" });
  });

  it("an unknown pattern is a no-op that returns null, never creating a row", async () => {
    const p = `grammar:never-existed-${Math.random().toString(36).slice(2)}`;
    const result = await applyProbeOutcome(p, true);
    expect(result).toBeNull();
    expect((await getFrequencies([p])).has(p)).toBe(false);
  });
});

describe("ledger repo — listPatterns", () => {
  it("orders by status then frequency, and includes resolved rows", async () => {
    const suffix = Math.random().toString(36).slice(2);
    const low = `grammar:list-low-${suffix}`;
    const high = `grammar:list-high-${suffix}`;
    await recordFindings([entry(low)]);
    await recordFindings([entry(high)]);
    await recordFindings([entry(high)]); // frequency 2, higher than low's 1

    const rows = await listPatterns();
    const lowIndex = rows.findIndex((r) => r.pattern === low);
    const highIndex = rows.findIndex((r) => r.pattern === high);
    expect(lowIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeLessThan(lowIndex); // same status ("active"), higher frequency sorts first
  });

  it("carries the fields the patterns view needs, never a bare frequency-only shape", async () => {
    const p = `grammar:list-shape-${Math.random().toString(36).slice(2)}`;
    await recordFindings([entry(p)]);
    const row = (await listPatterns()).find((r) => r.pattern === p);
    expect(row).toMatchObject({ pattern: p, frequency: 1, status: "active", probesPassed: 0 });
    expect(row).toHaveProperty("example");
    expect(row).toHaveProperty("lastSeenAt");
    expect(row).toHaveProperty("lastProbedAt");
  });
});
