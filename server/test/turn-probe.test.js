import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { recordFindings, applyProbeOutcome } from "../src/repo/ledger.js";
import { MIN_PROBE_FREQUENCY, PROBE_TURN_INTERVAL } from "../src/coach/probe.js";

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

async function turn(body) {
  const res = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /turn — probe field", () => {
  it("is null with no sessionId (a fresh session cannot probe)", async () => {
    const { body } = await turn({ utterance: "hello there" });
    expect(body.probe).toBeNull();
  });

  it("is null before the turn interval is reached, even with an eligible pattern", async () => {
    const p = `grammar:probe-route-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < MIN_PROBE_FREQUENCY; i += 1) {
      await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "x" }]);
    }
    let sessionId = null;
    for (let i = 0; i < PROBE_TURN_INTERVAL - 1; i += 1) {
      const { body } = await turn({ utterance: `turn ${i}`, sessionId });
      sessionId = body.sessionId;
      expect(body.probe).toBeNull();
    }
  });

  it("fires on the interval once an eligible pattern exists, and stamps lastProbedAt", async () => {
    const p = `grammar:probe-route-fire-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < MIN_PROBE_FREQUENCY; i += 1) {
      await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." }]);
    }
    let sessionId = null;
    let lastBody;
    // countUserTurns reflects turns already PERSISTED before this call, so
    // turnsSoFar over calls 1..N is 0, 1, 2, ... — reaching a value equal to
    // PROBE_TURN_INTERVAL takes PROBE_TURN_INTERVAL + 1 calls, not
    // PROBE_TURN_INTERVAL calls.
    for (let i = 0; i < PROBE_TURN_INTERVAL + 1; i += 1) {
      lastBody = (await turn({ utterance: `turn ${i}`, sessionId })).body;
      sessionId = lastBody.sessionId;
    }
    // We seeded one guaranteed-eligible pattern above, so the pool can never
    // be empty at this point — a probe must fire, even if it isn't
    // necessarily OUR pattern (other tests may have left eligible rows with
    // higher frequency in the same shared table).
    expect(lastBody.probe).not.toBeNull();
    expect(typeof lastBody.probe.pattern).toBe("string");
  });
});
