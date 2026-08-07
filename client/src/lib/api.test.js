import { describe, it, expect, vi, afterEach } from "vitest";
import { postFeedback, postTurnOpen, getPatterns } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("postFeedback", () => {
  it("returns the payload on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ corrections: [], upgrades: [], passes: { mechanical: "ok", pedagogical: "ok" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await postFeedback({ utterance: "hi", turnId: "t1", probedPattern: "grammar:x" });
    expect(out.passes.mechanical).toBe("ok");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.probedPattern).toBe("grammar:x");
  });

  it("returns null on a server error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });

  it("returns null when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });

  // A promise returned bare from inside a try block is not adopted by that
  // try — a truncated/non-JSON body on an otherwise-ok response must still
  // resolve null, not reject with an unhandled rejection.
  it("returns null instead of rejecting when a 200 response's body fails to parse", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    }));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });
});

describe("postTurnOpen", () => {
  it("posts the session id and returns the payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ coach_reply: "So — where do you land on it?", sessionId: "s1", seedProvider: "local" }),
    });

    const out = await postTurnOpen({ sessionId: "s1" });
    expect(out.coach_reply).toBe("So — where do you land on it?");
    expect(global.fetch).toHaveBeenCalledWith("/turn/open", expect.objectContaining({ method: "POST" }));
  });

  it("resolves to null on a server error rather than throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    expect(await postTurnOpen({})).toBeNull();
  });

  it("resolves to null when the network is down", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await postTurnOpen({})).toBeNull();
  });
});

describe("getPatterns", () => {
  it("returns the patterns payload on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ patterns: [{ pattern: "grammar:x", example: "x", frequency: 1, status: "active" }] }),
    }));
    const out = await getPatterns();
    expect(out.patterns).toHaveLength(1);
  });

  it("returns null on a server error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(getPatterns()).resolves.toBeNull();
  });

  it("returns null when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(getPatterns()).resolves.toBeNull();
  });
});
