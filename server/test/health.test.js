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
