import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getSessionWithTurns } from "../src/repo/session.js";
import { getPrisma } from "../src/db.js";

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

describe("POST /turn persistence", () => {
  it("opens a session on the first turn and returns its id", async () => {
    const { status, body } = await turn({ utterance: "hello" });
    expect(status).toBe(200);
    expect(body.sessionId).toBeTruthy();
  });

  it("writes both the user turn and the coach reply", async () => {
    const { body } = await turn({ utterance: "hello" });
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns.map((t) => t.role)).toEqual(["user", "coach"]);
    expect(session.turns[0].text).toBe("hello");
  });

  it("reuses the session id it is given instead of opening a new one", async () => {
    const first = await turn({ utterance: "one" });
    const second = await turn({ utterance: "two", sessionId: first.body.sessionId });
    expect(second.body.sessionId).toBe(first.body.sessionId);
    const session = await getSessionWithTurns(first.body.sessionId);
    expect(session.turns).toHaveLength(4);
  });

  it("stores the prosody counts on the user turn only", async () => {
    const counts = { total: 5, internal: 4, boundary: 1, unknown: 2 };
    const { body } = await turn({ utterance: "hmm well", prosody: counts });
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns[0].prosody).toEqual(counts);
    expect(session.turns[1].prosody).toBeNull();
  });

  it("still answers when the session id does not exist — the loop never breaks on a DB miss", async () => {
    const { status, body } = await turn({ utterance: "hello", sessionId: "does-not-exist" });
    expect(status).toBe(200);
    expect(body.coach_reply).toBeTruthy();
  });
});
