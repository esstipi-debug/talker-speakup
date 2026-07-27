import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The factory memoizes at module scope and exposes no reset (matching brain/,
// tts/, stt/), so every case reloads the module graph.
async function loadPron(env = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("./index.js");
}

beforeEach(() => {
  delete process.env.PRON_PROVIDER;
  delete process.env.PRON_URL;
  delete process.env.PRON_TIMEOUT_MS;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pron factory — provider resolution", () => {
  it("defaults to mock when PRON_PROVIDER is unset", async () => {
    const { getPron, currentPronProvider } = await loadPron({ PRON_PROVIDER: undefined });
    const { MockPron } = await import("./mock.js");
    expect(getPron()).toBeInstanceOf(MockPron);
    expect(currentPronProvider()).toBe("mock");
  });

  it("selects the sidecar client for PRON_PROVIDER=local", async () => {
    const { getPron, currentPronProvider } = await loadPron({ PRON_PROVIDER: "local" });
    const { LocalPron } = await import("./local.js");
    expect(getPron()).toBeInstanceOf(LocalPron);
    expect(currentPronProvider()).toBe("local");
  });

  it("trims and lowercases the env value", async () => {
    const { currentPronProvider } = await loadPron({ PRON_PROVIDER: "  LOCAL  " });
    expect(currentPronProvider()).toBe("local");
  });

  it("selects azure only when a key is present", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "secret",
    });
    const { AzurePron } = await import("./azure.js");
    expect(getPron()).toBeInstanceOf(AzurePron);
    expect(currentPronProvider()).toBe("azure");
  });

  it("warns and falls back to mock when azure is asked for without a key", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: undefined,
    });
    const { MockPron } = await import("./mock.js");
    expect(getPron()).toBeInstanceOf(MockPron);
    expect(currentPronProvider()).toBe("mock");
    expect(console.warn).toHaveBeenCalledWith(
      "[pron] PRON_PROVIDER=azure but AZURE_SPEECH_KEY is missing → falling back to mock.",
    );
  });

  it("treats a whitespace-only azure key as missing", async () => {
    const { currentPronProvider } = await loadPron({
      PRON_PROVIDER: "azure",
      AZURE_SPEECH_KEY: "   ",
    });
    expect(currentPronProvider()).toBe("mock");
  });

  it("never auto-selects azure from AZURE_SPEECH_KEY presence alone", async () => {
    const { getPron, currentPronProvider } = await loadPron({
      PRON_PROVIDER: undefined,
      AZURE_SPEECH_KEY: "secret",
      AZURE_SPEECH_REGION: "westus",
    });
    const { MockPron } = await import("./mock.js");
    expect(getPron()).toBeInstanceOf(MockPron);
    expect(currentPronProvider()).toBe("mock");
  });

  it("warns and falls back to mock on an unknown provider", async () => {
    const { currentPronProvider } = await loadPron({ PRON_PROVIDER: "elsa" });
    expect(currentPronProvider()).toBe("mock");
    expect(console.warn).toHaveBeenCalledWith(
      '[pron] unknown PRON_PROVIDER="elsa" → falling back to mock.',
    );
  });
});

describe("pron factory — memoization", () => {
  it("constructs the provider once and logs the choice once", async () => {
    const { getPron } = await loadPron({ PRON_PROVIDER: "local" });
    const first = getPron();
    const second = getPron();
    expect(second).toBe(first);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("[pron] provider = local");
  });

  it("currentPronProvider() self-primes without an explicit getPron() call", async () => {
    const { currentPronProvider } = await loadPron({ PRON_PROVIDER: "local" });
    expect(currentPronProvider()).toBe("local");
    expect(console.log).toHaveBeenCalledWith("[pron] provider = local");
  });

  it("ignores a PRON_PROVIDER change after the first resolution", async () => {
    const { getPron, currentPronProvider } = await loadPron({ PRON_PROVIDER: "local" });
    getPron();
    process.env.PRON_PROVIDER = "mock";
    expect(currentPronProvider()).toBe("local");
  });
});
