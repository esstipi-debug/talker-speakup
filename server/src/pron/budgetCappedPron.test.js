import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetCappedPron } from "./budgetCappedPron.js";
import { BudgetGuard } from "./budgetGuard.js";
import { AzurePron } from "./azure.js";
import { MockPron } from "./mock.js";

function stubProvider(reportOverrides = {}) {
  return {
    assess: vi.fn().mockResolvedValue({ pronProvider: "azure", durationSec: 4.2, ...reportOverrides }),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubGuard(isOverCap = false) {
  return { isOverCap: vi.fn().mockReturnValue(isOverCap), recordUsage: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("does not record usage when the metered report carries no durationSec, and warns loudly since the cap goes inert (finding 1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const metered = { assess: vi.fn().mockResolvedValue({ pronProvider: "azure" }), health: vi.fn() };
    const guard = stubGuard(false);
    const wrapped = new BudgetCappedPron(metered, stubProvider(), guard);
    await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(guard.recordUsage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no numeric durationSec"));
  });

  it("still resolves with the already-successful report even when the bookkeeping write throws (finding 4)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const metered = stubProvider({ durationSec: 3 });
    const guard = {
      isOverCap: vi.fn().mockReturnValue(false),
      recordUsage: vi.fn(() => {
        throw new Error("ENOSPC: no space left on device");
      }),
    };
    const wrapped = new BudgetCappedPron(metered, stubProvider(), guard);
    const report = await wrapped.assess(Buffer.from("x"), { text: "hi" });
    expect(report.pronProvider).toBe("azure");
    expect(guard.recordUsage).toHaveBeenCalledWith(3);
    expect(error).toHaveBeenCalled();
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

  describe("integration with real collaborators — BudgetGuard, AzurePron, MockPron (findings 1 + 2)", () => {
    // Real Azure short-audio response fixture (not a hand-rolled stand-in):
    // NBest[0].PronunciationAssessment present, one word ending at 3 s. This
    // is the exact shape azure.js's _toReport() maps into durationSec — a
    // stub that just fabricates `durationSec: 4.2` (as this file used to)
    // would never notice if AzurePron itself stopped emitting the field.
    const AZURE_BODY = {
      RecognitionStatus: "Success",
      NBest: [
        {
          PronunciationAssessment: { AccuracyScore: 80, FluencyScore: 85, CompletenessScore: 100 },
          Words: [
            {
              Word: "sheep",
              Offset: 0,
              Duration: 30000000, // 100 ns ticks -> 3.0 s
              PronunciationAssessment: { AccuracyScore: 80 },
            },
          ],
        },
      ],
    };

    function azureResponse(body) {
      const text = JSON.stringify(body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => JSON.parse(text),
        text: async () => text,
      };
    }

    let statePath;
    beforeEach(() => {
      statePath = path.join(
        os.tmpdir(),
        `pron-budget-cap-real-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      process.env.AZURE_SPEECH_KEY = "secret-key";
      process.env.AZURE_SPEECH_REGION = "westeurope";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(azureResponse(AZURE_BODY)));
    });
    afterEach(() => {
      fs.rmSync(statePath, { force: true });
      delete process.env.AZURE_SPEECH_KEY;
      delete process.env.AZURE_SPEECH_REGION;
      vi.unstubAllGlobals();
    });

    it("stops calling real Azure and honestly reports mock once real recorded usage crosses the cap", async () => {
      // ratePerHourUsd chosen so that $1 of cap equals exactly 1 second of
      // usage. The fixture's word ends at 3 s, so a single real AzurePron
      // call only trips the cap if durationSec genuinely made it from
      // AzurePron._toReport() onto the report and into the guard (finding 1).
      const guard = new BudgetGuard({ statePath, capUsd: 1, ratePerHourUsd: 3600 });
      const wrapped = new BudgetCappedPron(new AzurePron(), new MockPron(), guard);

      const first = await wrapped.assess(Buffer.from("audio-bytes"), { text: "sheep" });
      expect(first.pronProvider).toBe("azure");
      expect(first.durationSec).toBe(3);
      expect(guard.isOverCap()).toBe(true);

      const second = await wrapped.assess(Buffer.from("audio-bytes"), { text: "sheep" });
      // Only true if the real MockPron stamps its own pronProvider (finding 2)
      // — a fabricated fallback stub would pass this even if MockPron didn't.
      expect(second.pronProvider).toBe("mock");
      // The second call must never reach Azure at all — proves the fallback
      // path, not just the returned label, actually changed.
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
