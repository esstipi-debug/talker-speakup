import { describe, it, expect, vi, afterEach } from "vitest";
import { postFeedback } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("postFeedback", () => {
  it("returns the payload on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ corrections: [], upgrades: [], passes: { mechanical: "ok", pedagogical: "ok" } }),
    }));
    const out = await postFeedback({ utterance: "hi", turnId: "t1" });
    expect(out.passes.mechanical).toBe("ok");
  });

  it("returns null on a server error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });

  it("returns null when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(postFeedback({ utterance: "hi", turnId: "t1" })).resolves.toBeNull();
  });
});
