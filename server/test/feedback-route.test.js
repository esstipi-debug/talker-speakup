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

  it("de-dupes two concurrent requests for the same turnId (TOCTOU guard)", async () => {
    const turnId = await makeTurn("I have 30 years");

    let resolveBuild;
    buildFeedback.mockReset();
    buildFeedback.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        }),
    );

    // supertest/superagent only dispatches a request once `.then`/`.end` is
    // called, so build both promises and hand them to Promise.all in one
    // synchronous step — that fires both HTTP requests back-to-back, before
    // either has a chance to finish, guaranteeing the second arrives while
    // the first is still in flight rather than relying on timing luck.
    const both = Promise.all([
      request(app).post("/feedback").send({ utterance: "I have 30 years", turnId }),
      request(app).post("/feedback").send({ utterance: "I have 30 years", turnId }),
    ]);

    // Wait for buildFeedback to actually be invoked (it is only called once,
    // by whichever request wins the in-flight race) before resolving it —
    // this keeps the test deterministic instead of racing a fixed delay.
    for (let i = 0; i < 50 && !resolveBuild; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(resolveBuild).toBeTypeOf("function");
    resolveBuild(PAYLOAD);

    const [firstRes, secondRes] = await both;

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(firstRes.body).toEqual(secondRes.body);
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

  // The seam the two tests above leave open: the failure case deliberately has
  // no turnId, so the in-flight map is never touched. With one, the map's
  // `.finally()` builds a SECOND promise off `work` — and `.finally()` adopts
  // the original's rejection. Only `work` itself is awaited under try/catch, so
  // without a `.catch` on the derived chain a rejecting build is an unhandled
  // rejection, which under Node's default policy kills the process mid-session.
  it("502s without an unhandled rejection when the build fails for a turn already in flight", async () => {
    const turnId = await makeTurn("I have 30 years");
    buildFeedback.mockRejectedValue(new Error("everything is on fire"));

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
      expect(res.status).toBe(502);
      // Node reports unhandled rejections at the end of a macrotask, not
      // synchronously — give it a couple of turns of the loop to fire.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stores the session fluency on the turn alongside the payload", async () => {
    const turnId = await makeTurn("I have 30 years");
    buildFeedback.mockResolvedValue({ ...PAYLOAD, sessionFluency: 74 });
    const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(res.status).toBe(200);

    const { getPrisma } = await import("../src/db.js");
    const turn = await getPrisma().turn.findUnique({ where: { id: turnId } });
    expect(turn.fluency).toBe(74);
  });

  it("leaves the fluency column null when the session has too little phonation to score", async () => {
    const turnId = await makeTurn("I have 30 years");
    const res = await request(app).post("/feedback").send({ utterance: "I have 30 years", turnId });
    expect(res.status).toBe(200);

    const { getPrisma } = await import("../src/db.js");
    const turn = await getPrisma().turn.findUnique({ where: { id: turnId } });
    expect(turn.fluency).toBeNull();
  });

  it("reports the mechanical pass in /health", async () => {
    const res = await request(app).get("/health");
    expect(["ok", "unavailable"]).toContain(res.body.feedback);
  });
});
