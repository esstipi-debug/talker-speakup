import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../src/feedback/index.js", () => ({ buildFeedback: vi.fn() }));

const { buildFeedback } = await import("../src/feedback/index.js");
const { app } = await import("../src/app.js");

const PAYLOAD = {
  corrections: [], upgrades: [],
  hesitation: { band: "steady", basis: "text-only", midPhrasePauses: 0, fillers: 0, selfRepairs: 0 },
  sessionFluency: null,
  passes: { mechanical: "ok", pedagogical: "ok" },
};

beforeEach(() => {
  vi.clearAllMocks();
  buildFeedback.mockResolvedValue(PAYLOAD);
});

async function makeTurn(utterance) {
  const res = await request(app).post("/turn").send({ utterance });
  return res.body.turnId;
}

describe("POST /feedback", () => {
  it("400s without an utterance", async () => {
    const res = await request(app).post("/feedback").send({ turnId: "x" });
    expect(res.status).toBe(400);
  });

  it("returns the payload", async () => {
    const turnId = await makeTurn("I have 30 years");
    const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(res.status).toBe(200);
    expect(res.body.passes).toEqual({ mechanical: "ok", pedagogical: "ok" });
  });

  it("is idempotent: a second call returns the stored payload without recomputing", async () => {
    const turnId = await makeTurn("I have 30 years");
    await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    const second = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(second.status).toBe(200);
    expect(buildFeedback).toHaveBeenCalledTimes(1);
  });

  it("still answers when there is no turnId to persist against", async () => {
    const res = await request(app).post("/feedback").send({ utterance: "no turn id here" });
    expect(res.status).toBe(200);
    expect(res.body.passes.mechanical).toBe("ok");
  });

  it("502s when the whole build fails", async () => {
    buildFeedback.mockRejectedValue(new Error("everything is on fire"));
    const res = await request(app).post("/feedback").send({ utterance: "boom" });
    expect(res.status).toBe(502);
  });

  it("reports the mechanical pass in /health", async () => {
    const res = await request(app).get("/health");
    expect(["ok", "unavailable"]).toContain(res.body.feedback);
  });
});
