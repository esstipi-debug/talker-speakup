import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { recordFindings } from "../src/repo/ledger.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await getPrisma().$disconnect();
});

async function feedback(body) {
  const res = await fetch(`${base}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A real, persisted Turn row — a fabricated turnId with no backing row
 * makes saveTurnFeedback's update fail (swallowed) and getTurnFeedback
 * always return null, so the idempotency gate never actually engages. */
async function makeTurn(utterance) {
  const res = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance }),
  });
  const body = await res.json();
  return body.turnId;
}

describe("POST /feedback — probe outcome", () => {
  it("returns null probeResult when no probedPattern is sent", async () => {
    const { body } = await feedback({ utterance: "I like pizza a lot" });
    expect(body.probeResult).toBeNull();
  });

  it("a probedPattern that does not reappear in this turn's findings is a pass", async () => {
    const p = `grammar:feedback-probe-pass-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    const { body } = await feedback({ utterance: "I like pizza a lot", probedPattern: p });
    expect(body.probeResult).toEqual({ pattern: p, passed: true, status: "improving" });
  });

  it("an unknown probedPattern resolves to a null probeResult, not an error", async () => {
    const { status, body } = await feedback({
      utterance: "I like pizza a lot",
      probedPattern: "grammar:never-existed-anywhere",
    });
    expect(status).toBe(200);
    expect(body.probeResult).toBeNull();
  });

  it("does not attach recurrence when there are no corrections", async () => {
    const { body } = await feedback({ utterance: "I like pizza a lot" });
    expect(body.corrections).toEqual([]);
  });

  it("never leaks internal recordedPatterns/frequenciesBeforeWrite fields onto the response", async () => {
    const { body } = await feedback({ utterance: "hello there" });
    expect(body).not.toHaveProperty("recordedPatterns");
    expect(body).not.toHaveProperty("frequenciesBeforeWrite");
  });

  // The most important test in M4 (spec §9.1): a retried request with the
  // same turnId + probedPattern must apply the outcome exactly once. Uses a
  // REAL turnId (via makeTurn) so the stored-payload gate can actually
  // engage on the third, sequential request — a fabricated id would make
  // saveTurnFeedback silently fail every time, masking a real double-apply.
  it("applies a probe outcome exactly once across duplicate requests with the same turnId", async () => {
    const p = `grammar:feedback-probe-idempotent-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    const turnId = await makeTurn("I like pizza a lot");

    const [first, second] = await Promise.all([
      feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p }),
      feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p }),
    ]);

    expect(first.body.probeResult).toEqual({ pattern: p, passed: true, status: "improving" });
    expect(second.body.probeResult).toEqual(first.body.probeResult);

    // Ground truth: read the ledger row directly. A second HTTP response
    // that merely *looks* the same as the first proves nothing — "improving"
    // is the status at both 1 and 2 passes when PROBE_PASSES_TO_RESOLVE > 2,
    // so only the row's actual probesPassed count can distinguish "applied
    // once" from "applied twice."
    const row = await getPrisma().errorLedger.findUnique({ where: { pattern: p } });
    expect(row.probesPassed).toBe(1);

    // A later, separate request for the same turnId must replay the stored
    // payload rather than recomputing — the row must still read 1.
    const third = await feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p });
    expect(third.body.probeResult).toEqual(first.body.probeResult);
    const rowAfterThird = await getPrisma().errorLedger.findUnique({ where: { pattern: p } });
    expect(rowAfterThird.probesPassed).toBe(1);
  });
});
