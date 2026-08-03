import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Fix 4 + fix 5: persistOpening must mirror persistTurn's sessionUsable
// handling (a session id that already holds the opener turn must never be
// dropped just because the LATER recordSeed write fails), and the response's
// seedProvider must reflect what actually got persisted, not merely what was
// picked in memory. Both require forcing recordSeed to fail after recordTurn
// has already succeeded — real DB failure injection, not a mock of the whole
// module, so recordTurn/startSession still exercise the real repo.
vi.mock("../src/repo/session.js", async () => {
  const actual = await vi.importActual("../src/repo/session.js");
  return {
    ...actual,
    recordSeed: vi.fn(actual.recordSeed),
  };
});

const { recordSeed } = await import("../src/repo/session.js");
const { app } = await import("../src/app.js");
const { getSessionWithTurns } = await import("../src/repo/session.js");
const { getPrisma } = await import("../src/db.js");

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

async function open(body = {}) {
  const res = await fetch(`${base}/turn/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /turn/open persistence when recordSeed fails after the opener turn lands", () => {
  it("still hands back the session id — it already holds a real, persisted opener turn", async () => {
    recordSeed.mockRejectedValueOnce(new Error("simulated recordSeed failure"));

    const { status, body } = await open();
    expect(status).toBe(200);
    expect(body.sessionId).toBeTruthy();

    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].role).toBe("coach");
    expect(session.turns[0].text).toBe(body.coach_reply);
  });

  it("reports seedProvider as null — no stamp exists to back the claim", async () => {
    recordSeed.mockRejectedValueOnce(new Error("simulated recordSeed failure"));

    const { body } = await open();
    expect(body.seedProvider).toBeNull();

    const session = await getSessionWithTurns(body.sessionId);
    expect(session.seedProvider).toBeNull();
  });

  it("still reports the real provider once recordSeed succeeds again", async () => {
    const { body } = await open();
    expect(body.seedProvider).toBe("local");
  });
});
