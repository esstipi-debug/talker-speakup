import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { currentPronProvider } from "./pron/index.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createApp — /health", () => {
  it("reports every provider slot including pron, in the frozen key order", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["status", "brain", "tts", "stt", "pron", "ts"]);
    expect(res.body.status).toBe("ok");
    expect(res.body.pron).toBe(currentPronProvider());
    expect(typeof res.body.ts).toBe("number");
  });
});

describe("createApp — wiring", () => {
  it("still mounts the turn router", async () => {
    const res = await request(createApp()).post("/turn").send({ utterance: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing "utterance" (non-empty string).');
  });

  it("returns a fresh app per call so tests never share state", () => {
    expect(createApp()).not.toBe(createApp());
  });

  it("does not start a listener on import", () => {
    const app = createApp();
    expect(typeof app.listen).toBe("function");
    expect(app.listening).toBeUndefined();
  });
});
