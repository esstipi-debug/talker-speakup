import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard } from "./budgetGuard.js";

let statePath;

beforeEach(() => {
  statePath = path.join(
    os.tmpdir(),
    `pron-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
});

afterEach(() => {
  fs.rmSync(statePath, { force: true });
});

function guard(overrides = {}) {
  return new BudgetGuard({
    statePath,
    capUsd: 12,
    ratePerHourUsd: 0.66,
    now: () => new Date("2026-07-15T12:00:00Z"),
    ...overrides,
  });
}

describe("BudgetGuard", () => {
  it("starts at zero spend when no state file exists", () => {
    const g = guard();
    expect(g.spentUsd()).toBe(0);
    expect(g.isOverCap()).toBe(false);
  });

  it("computes spend from recorded audio seconds at the configured rate", () => {
    const g = guard();
    g.recordUsage(3600); // 1 hour
    expect(g.spentUsd()).toBeCloseTo(0.66, 5);
  });

  it("accumulates usage across multiple recordUsage calls", () => {
    const g = guard();
    g.recordUsage(1800);
    g.recordUsage(1800);
    expect(g.spentUsd()).toBeCloseTo(0.66, 5);
  });

  it("reports over cap once accumulated spend meets the cap", () => {
    const g = guard({ capUsd: 1 });
    g.recordUsage((1 / 0.66) * 3600); // exactly $1 at $0.66/hr
    expect(g.isOverCap()).toBe(true);
  });

  it("reports under cap while spend remains below the cap", () => {
    const g = guard({ capUsd: 1 });
    g.recordUsage(1000);
    expect(g.isOverCap()).toBe(false);
  });

  it("persists usage across separate instances pointed at the same file", () => {
    guard().recordUsage(3600);
    const fresh = guard();
    expect(fresh.spentUsd()).toBeCloseTo(0.66, 5);
  });

  it("resets to zero when the persisted state belongs to a prior month", () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ month: "2020-01", audioSecondsUsed: 99999 }),
      "utf8",
    );
    const g = guard(); // now() is fixed at 2026-07
    expect(g.spentUsd()).toBe(0);
  });

  it("treats a corrupt state file as a fresh start rather than throwing", () => {
    fs.writeFileSync(statePath, "{not json", "utf8");
    expect(() => guard().spentUsd()).not.toThrow();
    expect(guard().spentUsd()).toBe(0);
  });

  it("clamps a negative or non-numeric usage value to zero rather than reducing the total", () => {
    const g = guard();
    g.recordUsage(3600);
    g.recordUsage(-500);
    g.recordUsage(NaN);
    expect(g.spentUsd()).toBeCloseTo(0.66, 5);
  });
});
