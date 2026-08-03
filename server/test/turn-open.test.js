import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { getSessionWithTurns } from "../src/repo/session.js";

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

describe("POST /turn/open", () => {
  it("returns an opening line with no utterance in the request", async () => {
    const { status, body } = await open();
    expect(status).toBe(200);
    expect(body.coach_reply.length).toBeGreaterThan(0);
  });

  it("opens a session and persists the opener as a coach turn", async () => {
    const { body } = await open();
    expect(body.sessionId).toBeTruthy();

    const session = await getSessionWithTurns(body.sessionId);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].role).toBe("coach");
    expect(session.turns[0].text).toBe(body.coach_reply);
  });

  it("stamps the session with the provider that supplied the topic", async () => {
    const { body } = await open();
    const session = await getSessionWithTurns(body.sessionId);
    expect(session.seedProvider).toBe("local");
    expect(body.seedProvider).toBe("local");
  });

  it("adopts a session it is given instead of opening a new one", async () => {
    const first = await open();
    const second = await open({ sessionId: first.body.sessionId });
    expect(second.body.sessionId).toBe(first.body.sessionId);
  });

  it("still answers when the session id does not exist — the loop never breaks on a DB miss", async () => {
    const { status, body } = await open({ sessionId: "does-not-exist" });
    expect(status).toBe(200);
    expect(body.coach_reply.length).toBeGreaterThan(0);
    expect(body.sessionId).toBeNull();
  });
});
