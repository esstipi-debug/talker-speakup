import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /pron/prompts — the curated set", () => {
  it("returns the full set when focus is omitted", async () => {
    const res = await request(createApp()).get("/pron/prompts");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.focuses).toEqual([
      "ih-iy",
      "ae",
      "schwa",
      "v-b",
      "dzh",
      "s-cluster",
      "ed-ending",
    ]);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(21);
    expect(res.body.prompts[0]).toMatchObject({ id: "ih-iy-01", focus: "ih-iy" });
  });

  it("filters by focus and keeps the focus list complete", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=schwa");
    expect(res.status).toBe(200);
    expect(res.body.prompts.every((p) => p.focus === "schwa")).toBe(true);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(3);
    expect(res.body.focuses).toHaveLength(7);
  });

  it("treats an empty focus as no filter", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=");
    expect(res.status).toBe(200);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(21);
  });

  it("rejects whitespace-only focus with UNKNOWN_FOCUS", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=%20");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
      code: "UNKNOWN_FOCUS",
    });
  });

  it("400s an unknown focus with a typed code and the valid values", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=nasal");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
      code: "UNKNOWN_FOCUS",
    });
  });
});
