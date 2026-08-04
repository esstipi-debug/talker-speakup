import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { getSessionWithTurns } from "../src/repo/session.js";
import { upsertItems } from "../src/repo/topics.js";

let server;
let base;
let originalSourceFeeds;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  originalSourceFeeds = process.env.SOURCE_FEEDS;
  // configuredFeeds() reads process.env on every call (never cached at module
  // load), so setting it here — with no server restart — is enough to move
  // the seed factory onto the feeds→local chain for this file's requests.
  process.env.SOURCE_FEEDS = "https://example.com/feed.xml";
});

afterAll(async () => {
  if (originalSourceFeeds === undefined) delete process.env.SOURCE_FEEDS;
  else process.env.SOURCE_FEEDS = originalSourceFeeds;
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

describe("POST /turn/open — SOURCE_FEEDS configured", () => {
  it("opens on a cached feed topic and stamps the session with seedProvider = feeds", async () => {
    const guid = `test-open-feed-${Math.random().toString(36).slice(2)}`;
    await upsertItems([
      {
        guid,
        feedUrl: "https://example.com/feed.xml",
        sourceLabel: "Test Channel",
        title: "A guaranteed-newest integration test topic",
        description: "Far-future publishedAt guarantees it wins pickTopic over any other cached row.",
        url: "https://example.com/video",
        publishedAt: new Date("2099-06-01"),
      },
    ]);

    const { status, body } = await open();
    expect(status).toBe(200);
    expect(body.seedProvider).toBe("feeds");

    const session = await getSessionWithTurns(body.sessionId);
    expect(session.seedProvider).toBe("feeds");
    expect(session.topicId).toBeTruthy();
  });
});
