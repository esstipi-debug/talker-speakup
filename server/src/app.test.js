import http from "node:http";
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

  it("does not start a listener when constructing the app", () => {
    // app.listen() ultimately delegates to http.Server#listen — Express's
    // app.listen() creates an http.Server and calls .listen() on it. Spying
    // on the prototype method catches that call regardless of how deep it's
    // buried, unlike checking `app.listening` (which Node only flips to true
    // asynchronously after the TCP bind completes, so it reads `undefined`
    // right after createApp() returns whether or not .listen() was called).
    const listenSpy = vi.spyOn(http.Server.prototype, "listen");

    createApp();

    expect(listenSpy).not.toHaveBeenCalled();
    // vi.restoreAllMocks() in the afterEach above restores this spy so it
    // cannot leak into other tests in this file.
  });
});
