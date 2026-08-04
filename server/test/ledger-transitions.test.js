import { describe, it, expect } from "vitest";
import { nextLedgerState, PROBE_PASSES_TO_RESOLVE } from "../src/ledger/transitions.js";

describe("ledger/transitions — nextLedgerState", () => {
  it("a passed probe increments probesPassed and moves to improving before the threshold", () => {
    const next = nextLedgerState({ probesPassed: 0 }, "passed");
    expect(next).toEqual({ status: "improving", probesPassed: 1 });
  });

  it("resolves exactly at PROBE_PASSES_TO_RESOLVE consecutive passes", () => {
    let state = { probesPassed: 0 };
    for (let i = 0; i < PROBE_PASSES_TO_RESOLVE - 1; i += 1) {
      state = nextLedgerState(state, "passed");
      expect(state.status).toBe("improving");
    }
    state = nextLedgerState(state, "passed");
    expect(state).toEqual({ status: "resolved", probesPassed: PROBE_PASSES_TO_RESOLVE });
  });

  it("does not grow probesPassed past the threshold on a defensive extra pass", () => {
    const state = nextLedgerState({ probesPassed: PROBE_PASSES_TO_RESOLVE }, "passed");
    expect(state.probesPassed).toBe(PROBE_PASSES_TO_RESOLVE);
    expect(state.status).toBe("resolved");
  });

  it("a failed probe resets to active with the counter zeroed, even mid-streak", () => {
    const next = nextLedgerState({ probesPassed: 2 }, "failed");
    expect(next).toEqual({ status: "active", probesPassed: 0 });
  });

  it("an ordinary sighting in free conversation resets to active with the counter zeroed", () => {
    const next = nextLedgerState({ probesPassed: 1 }, "sighted");
    expect(next).toEqual({ status: "active", probesPassed: 0 });
  });

  it("relapse path: resolved, then an ordinary sighting returns it to active at zero", () => {
    let state = { probesPassed: PROBE_PASSES_TO_RESOLVE };
    state = nextLedgerState(state, "passed"); // still resolved, capped
    expect(state.status).toBe("resolved");
    state = nextLedgerState(state, "sighted"); // the learner made the mistake again
    expect(state).toEqual({ status: "active", probesPassed: 0 });
  });

  it("current may be null for events that don't read it (failed/sighted)", () => {
    expect(nextLedgerState(null, "failed")).toEqual({ status: "active", probesPassed: 0 });
    expect(nextLedgerState(null, "sighted")).toEqual({ status: "active", probesPassed: 0 });
  });
});
