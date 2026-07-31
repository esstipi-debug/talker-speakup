import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetCappedPron } from "./budgetCappedPron.js";
import { BudgetGuard } from "./budgetGuard.js";

function stubProvider(reportOverrides = {}) {
  return {
    assess: vi.fn().mockResolvedValue({ pronProvider: "azure", durationSec: 4.2, ...reportOverrides }),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubGuard(isOverCap = false) {
  return { isOverCap: vi.fn().mockReturnValue(isOverCap), recordUsage: vi.fn() };
}

describe("BudgetCappedPron", () => {
  it("delegates to the metered provider while under cap", async () => {
    const metered = stubProvider();
    const fallback = stubProvider({ pronProvider: "mock" });
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(false));
    const report = await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(metered.assess).toHaveBeenCalledWith(Buffer.from("x"), { text: "hi" });
    expect(fallback.assess).not.toHaveBeenCalled();
    expect(report.pronProvider).toBe("azure");
  });

  it("delegates to the fallback provider once over cap", async () => {
    const metered = stubProvider();
    const fallback = stubProvider({ pronProvider: "mock" });
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(true));
    const report = await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(fallback.assess).toHaveBeenCalledWith(Buffer.from("x"), { text: "hi" });
    expect(metered.assess).not.toHaveBeenCalled();
    expect(report.pronProvider).toBe("mock");
  });

  it("records the metered call's actual reported duration on success", async () => {
    const metered = stubProvider({ durationSec: 7.5 });
    const guard = stubGuard(false);
    const wrapped = new BudgetCappedPron(metered, stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).toHaveBeenCalledWith(7.5);
  });

  it("does not record usage when the metered report carries no durationSec", async () => {
    const metered = { assess: vi.fn().mockResolvedValue({ pronProvider: "azure" }), health: vi.fn() };
    const guard = stubGuard(false);
    const wrapped = new BudgetCappedPron(metered, stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).not.toHaveBeenCalled();
  });

  it("does not record usage on the fallback path — fallback calls are not metered", async () => {
    const guard = stubGuard(true);
    const wrapped = new BudgetCappedPron(stubProvider(), stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).not.toHaveBeenCalled();
  });

  it("propagates a metered provider's own failure rather than silently falling back", async () => {
    const metered = {
      assess: vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: "PRON_UNAVAILABLE" })),
      health: vi.fn(),
    };
    const fallback = stubProvider();
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(false));
    await expect(wrapped.assess(Buffer.from("x"), { text: "hi" })).rejects.toMatchObject({
      code: "PRON_UNAVAILABLE",
    });
    expect(fallback.assess).not.toHaveBeenCalled();
  });

  it("reports health from the metered provider, not the fallback", async () => {
    const metered = stubProvider();
    metered.health.mockResolvedValue({ ok: true, note: "azure" });
    const fallback = stubProvider();
    const wrapped = new BudgetCappedPron(metered, fallback, stubGuard(false));
    const health = await wrapped.health();
    expect(health).toEqual({ ok: true, note: "azure" });
    expect(fallback.health).not.toHaveBeenCalled();
  });

  describe("integration with a real BudgetGuard", () => {
    let statePath;
    beforeEach(() => {
      statePath = path.join(
        os.tmpdir(),
        `pron-budget-cap-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
    });
    afterEach(() => {
      fs.rmSync(statePath, { force: true });
    });

    it("switches from metered to fallback once real recorded usage crosses the cap", async () => {
      // ratePerHourUsd chosen so that $1 of cap equals exactly 1 second of usage.
      const guard = new BudgetGuard({ statePath, capUsd: 1, ratePerHourUsd: 3600 });
      const metered = stubProvider({ durationSec: 2 }); // one call already exceeds the $1 cap
      const fallback = stubProvider({ pronProvider: "mock" });
      const wrapped = new BudgetCappedPron(metered, fallback, guard);

      const first = await wrapped.assess(Buffer.from("x"), { text: "hi" });
      expect(first.pronProvider).toBe("azure");

      const second = await wrapped.assess(Buffer.from("x"), { text: "hi" });
      expect(second.pronProvider).toBe("mock");
      expect(metered.assess).toHaveBeenCalledTimes(1);
    });
  });
});
