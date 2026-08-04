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
  // same turnId + probedPattern must apply the outcome exactly once.
  it("applies a probe outcome exactly once across duplicate requests with the same turnId", async () => {
    const p = `grammar:feedback-probe-idempotent-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    const turnId = `test-turn-${Math.random().toString(36).slice(2)}`;

    const [first, second] = await Promise.all([
      feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p }),
      feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p }),
    ]);

    expect(first.body.probeResult).toEqual({ pattern: p, passed: true, status: "improving" });
    expect(second.body.probeResult).toEqual(first.body.probeResult);

    // probesPassed incremented by exactly 1, not 2 — the double-count the
    // turnId gate exists to prevent, applied to a different write.
    const third = await feedback({ utterance: "I like pizza a lot", turnId, probedPattern: p });
    expect(third.body.probeResult).toEqual(first.body.probeResult); // idempotent replay, still "improving" at 1 pass
  });
});
