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

describe("GET /patterns", () => {
  it("returns a patterns array", async () => {
    const res = await fetch(`${base}/patterns`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.patterns)).toBe(true);
  });

  it("includes a row after a finding is recorded, with the example visible", async () => {
    const p = `grammar:patterns-route-${Math.random().toString(36).slice(2)}`;
    await recordFindings([{ pattern: p, type: "grammar", example: "I have 30 years", explanation: "Age takes 'be'." }]);
    const res = await fetch(`${base}/patterns`);
    const body = await res.json();
    const row = body.patterns.find((r) => r.pattern === p);
    expect(row).toMatchObject({ example: "I have 30 years", status: "active", frequency: 1 });
  });
});
