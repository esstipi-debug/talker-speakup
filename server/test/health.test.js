import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";

/**
 * Port 0 gets an ephemeral port from the OS, so tests never collide with a
 * running dev server. Node's global fetch means no supertest dependency.
 */
let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("GET /health", () => {
  it("reports every provider slot", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("brain");
    expect(body).toHaveProperty("tts");
    expect(body).toHaveProperty("stt");
    expect(body).toHaveProperty("pron");
  });

  it("reports the seed source configuration, not reachability", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.sources).toMatchObject({ provider: "local", feeds: 0 });
    expect(typeof body.sources.cached).toBe("number");
    expect(typeof body.sources.unused).toBe("number");
  });
});

describe("POST /turn", () => {
  it("rejects a missing utterance with 400", async () => {
    const res = await fetch(`${base}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /health — the mode block does not disturb the slots", () => {
  it("still reports brain and tts as plain strings", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(typeof body.brain).toBe("string");
    expect(typeof body.tts).toBe("string");
    expect(["web", "cloud", "hybrid", "custom"]).toContain(body.mode.effective);
  });
});
