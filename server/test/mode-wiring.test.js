import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/app.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("GET /health — mode", () => {
  it("publishes the mode block alongside the existing slots", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode).toMatchObject({
      requested: expect.any(String),
      effective: expect.any(String),
      degraded: expect.any(Boolean),
    });
    expect(Array.isArray(body.mode.reasons)).toBe(true);
  });

  it("reports auto under the test run, which sets no mode", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.requested).toBe("auto");
  });

  it("is not degraded under auto, whatever the providers resolved to", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.degraded).toBe(false);
    expect(body.mode.reasons).toEqual([]);
  });

  it("leaves every pre-existing health field intact", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    for (const key of ["status", "brain", "tts", "stt", "pron", "feedback", "sources", "ts"]) {
      expect(body).toHaveProperty(key);
    }
  });
});
