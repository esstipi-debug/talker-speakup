import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { getSessionWithTurns, saveTurnFeedback, getTurnFeedback } from "../src/repo/session.js";
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

  it("stores the capture settings on the user turn only", async () => {
    const settings = { sampleRate: 48000, echoCancellation: false, autoGainControl: false, channelCount: 1 };
    const { body } = await turn({ utterance: "hmm well", captureSettings: settings });
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns[0].captureSettings).toEqual(settings);
    expect(session.turns[1].captureSettings).toBeNull();
  });

  it("still answers when the session id does not exist — the loop never breaks on a DB miss", async () => {
    const { status, body } = await turn({ utterance: "hello", sessionId: "does-not-exist" });
    expect(status).toBe(200);
    expect(body.coach_reply).toBeTruthy();
  });

  it("does not echo back a session id it could not write to", async () => {
    // A stale id the client is still holding: every write to it fails, so
    // handing it back would make every later turn fail the same way.
    const { body } = await turn({ utterance: "hello", sessionId: "does-not-exist" });
    expect(body.sessionId).toBeNull();
  });

  it("keeps the session id once a write to it has succeeded", async () => {
    const first = await turn({ utterance: "one" });
    const second = await turn({ utterance: "two", sessionId: first.body.sessionId });
    expect(second.body.sessionId).toBe(first.body.sessionId);
  });
});

describe("turn id + feedback column", () => {
  it("returns a turnId for the user turn", async () => {
    const res = await request(app).post("/turn").send({ utterance: "hello there" });
    expect(res.status).toBe(200);
    expect(typeof res.body.turnId).toBe("string");
    expect(res.body.turnId.length).toBeGreaterThan(0);
  });

  it("round-trips a feedback payload on that turn", async () => {
    const res = await request(app).post("/turn").send({ utterance: "hello again" });
    await saveTurnFeedback(res.body.turnId, { corrections: [], upgrades: [] });
    expect(await getTurnFeedback(res.body.turnId)).toEqual({ corrections: [], upgrades: [] });
  });

  it("returns null for a turn with no feedback yet", async () => {
    const res = await request(app).post("/turn").send({ utterance: "nothing stored" });
    expect(await getTurnFeedback(res.body.turnId)).toBeNull();
  });
});
