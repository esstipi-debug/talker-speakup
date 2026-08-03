import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestUpgrades } from "../src/feedback/upgrades.js";

const UTTERANCE = "I have a problem with my computer";

function mockLLM(payload, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    text: async () => "error body",
  });
}

describe("requestUpgrades", () => {
  beforeEach(() => { process.env.MISTRAL_API_KEY = "test-key"; });
  afterEach(() => { delete process.env.MISTRAL_API_KEY; vi.unstubAllGlobals(); });

  it("skips without an API key", async () => {
    delete process.env.MISTRAL_API_KEY;
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out).toEqual({ status: "skipped", upgrades: [], extraCorrections: [] });
  });

  it("returns a valid upgrade", async () => {
    vi.stubGlobal("fetch", mockLLM({
      upgrades: [{ original: "I have a problem with my computer", upgraded: "my laptop's been acting up", why: "Phrasal verb is more idiomatic." }],
      corrections: [],
    }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("ok");
    expect(out.upgrades).toHaveLength(1);
    expect(out.upgrades[0].upgraded).toBe("my laptop's been acting up");
  });

  it("DROPS an upgrade quoting text the learner never said", async () => {
    vi.stubGlobal("fetch", mockLLM({
      upgrades: [{ original: "I got a issue with my laptop", upgraded: "my laptop's playing up", why: "..." }],
      corrections: [],
    }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("ok");
    expect(out.upgrades).toEqual([]);
  });

  it("fails closed on invalid JSON, without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails on a 429 without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out).toEqual({ status: "failed", upgrades: [], extraCorrections: [] });
  });

  it("tells the model not to repeat Harper's findings", async () => {
    const fetchMock = mockLLM({ upgrades: [], corrections: [] });
    vi.stubGlobal("fetch", fetchMock);
    await requestUpgrades({
      utterance: UTTERANCE, history: [],
      harperFindings: [{ original: "a problem", message: "Use 'an issue'." }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prompt = body.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("a problem");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("returns a valid correction in extraCorrections", async () => {
    vi.stubGlobal("fetch", mockLLM({
      upgrades: [],
      corrections: [{ original: "I have a problem with my computer", suggestion: "issue", message: "More natural word choice." }],
    }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("ok");
    expect(out.extraCorrections).toEqual([
      { original: "I have a problem with my computer", suggestion: "issue", message: "More natural word choice." },
    ]);
  });

  it("DROPS a correction quoting text the learner never said", async () => {
    vi.stubGlobal("fetch", mockLLM({
      upgrades: [],
      corrections: [{ original: "I got a issue with my laptop", suggestion: "issue", message: "..." }],
    }));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out.status).toBe("ok");
    expect(out.extraCorrections).toEqual([]);
  });

  it("fails closed without throwing when the network request itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const out = await requestUpgrades({ utterance: UTTERANCE, history: [], harperFindings: [] });
    expect(out).toEqual({ status: "failed", upgrades: [], extraCorrections: [] });
  });
});
