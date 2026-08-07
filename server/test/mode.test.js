import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveMode, slotDefault, noteTTSOutcome, modeStatus, __resetForTests } from "../src/config/mode.js";

/**
 * resolveMode reads process.argv and process.env, both of which are global.
 * Snapshot and restore them around every test so ordering never matters.
 */
let argv;
let env;

beforeEach(() => {
  argv = process.argv;
  env = { ...process.env };
  process.argv = ["node", "src/index.js"];
  delete process.env.SPEAKUP_MODE;
  __resetForTests();
});

afterEach(() => {
  process.argv = argv;
  process.env = env;
  __resetForTests();
});

describe("resolveMode", () => {
  it("defaults to auto when nothing is set", () => {
    expect(resolveMode()).toBe("auto");
  });

  it("reads --mode= from argv", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(resolveMode()).toBe("hybrid");
  });

  it("reads SPEAKUP_MODE when there is no flag", () => {
    process.env.SPEAKUP_MODE = "cloud";
    expect(resolveMode()).toBe("cloud");
  });

  it("lets the flag win over the env var", () => {
    process.env.SPEAKUP_MODE = "cloud";
    process.argv = ["node", "src/index.js", "--mode=web"];
    expect(resolveMode()).toBe("web");
  });

  it("ignores the bare --mode form rather than consuming the next argument", () => {
    process.argv = ["node", "src/index.js", "--mode", "hybrid"];
    expect(resolveMode()).toBe("auto");
  });

  it("falls back to auto on an unknown mode without throwing", () => {
    process.argv = ["node", "src/index.js", "--mode=banana"];
    expect(() => resolveMode()).not.toThrow();
    expect(resolveMode()).toBe("auto");
  });

  it("is case- and whitespace-insensitive", () => {
    process.argv = ["node", "src/index.js", "--mode=  HYBRID  "];
    expect(resolveMode()).toBe("hybrid");
  });

  it("lets a later --mode= flag win over an earlier one on the same argv", () => {
    // `npm run dev:hybrid -- --mode=web` appends its own flag after the
    // script's `--mode=hybrid`; CLI convention is last-wins.
    process.argv = ["node", "src/index.js", "--mode=hybrid", "--mode=web"];
    expect(resolveMode()).toBe("web");
  });
});

describe("slotDefault", () => {
  it("returns null for both slots under auto, so the legacy chain decides", () => {
    expect(slotDefault("brain")).toBeNull();
    expect(slotDefault("tts")).toBeNull();
  });

  it("maps web to mock + browser", () => {
    process.argv = ["node", "src/index.js", "--mode=web"];
    expect(slotDefault("brain")).toBe("mock");
    expect(slotDefault("tts")).toBe("browser");
  });

  it("maps cloud to mistral + browser", () => {
    process.argv = ["node", "src/index.js", "--mode=cloud"];
    expect(slotDefault("brain")).toBe("mistral");
    expect(slotDefault("tts")).toBe("browser");
  });

  it("maps hybrid to mistral + kokoro", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(slotDefault("brain")).toBe("mistral");
    expect(slotDefault("tts")).toBe("kokoro");
  });

  it("returns null for a slot no mode controls", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(slotDefault("stt")).toBeNull();
  });
});

describe("modeStatus — effective name", () => {
  it("names the pair when it matches a preset", () => {
    expect(modeStatus({ brain: "mistral", tts: "kokoro" }).effective).toBe("hybrid");
    expect(modeStatus({ brain: "mistral", tts: "browser" }).effective).toBe("cloud");
    expect(modeStatus({ brain: "mock", tts: "browser" }).effective).toBe("web");
  });

  it("says custom when the pair matches no preset", () => {
    expect(modeStatus({ brain: "mock", tts: "kokoro" }).effective).toBe("custom");
  });

  it("never names the pair auto", () => {
    expect(modeStatus({ brain: "mistral", tts: "kokoro" }).effective).not.toBe("auto");
  });

  it("treats an unrecognised tts value as browser for the effective name", () => {
    // getTTS() returns null (and the browser speaks) for anything that isn't
    // kokoro/voicebox — a typo like "kokoru" must read as the mode that's
    // actually speaking, not "custom".
    expect(modeStatus({ brain: "mock", tts: "kokoru" }).effective).toBe("web");
  });
});

describe("modeStatus — degradation", () => {
  it("is not degraded when the requested mode got what it asked for", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s).toMatchObject({ requested: "hybrid", effective: "hybrid", degraded: false, reasons: [] });
  });

  it("reports a missing key when a mistral mode resolved to mock", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    const s = modeStatus({ brain: "mock", tts: "kokoro" });
    expect(s.reasons).toEqual(["missing-mistral-key"]);
    expect(s.degraded).toBe(true);
    // The real pair is mock+kokoro, which is no preset — see the plan's
    // "Spec corrections" section.
    expect(s.effective).toBe("custom");
  });

  it("does not call a deliberate override degraded", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    const s = modeStatus({ brain: "mistral", tts: "browser" });
    expect(s).toMatchObject({ effective: "cloud", degraded: false, reasons: [] });
  });

  it("treats an unattempted TTS as fine, not as broken", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    expect(modeStatus({ brain: "mistral", tts: "kokoro" }).degraded).toBe(false);
  });

  it("reports an unreachable TTS after a failed turn, and reads as cloud", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s.reasons).toEqual(["tts-unreachable"]);
    expect(s.degraded).toBe(true);
    expect(s.effective).toBe("cloud");
  });

  it("clears the reason on the next successful synthesis", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    noteTTSOutcome(true);
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s.degraded).toBe(false);
    expect(s.effective).toBe("hybrid");
  });

  it("ignores reachability when the configured voice is the browser", () => {
    process.argv = ["node", "src/index.js", "--mode=cloud"];
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mistral", tts: "browser" });
    expect(s.degraded).toBe(false);
    expect(s.effective).toBe("cloud");
  });

  it("applies reachability to voicebox too, not only kokoro", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    expect(modeStatus({ brain: "mistral", tts: "voicebox" }).reasons).toEqual(["tts-unreachable"]);
  });

  it("carries both reasons at once, and reads as web", () => {
    process.argv = ["node", "src/index.js", "--mode=hybrid"];
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mock", tts: "kokoro" });
    expect(s.reasons).toEqual(["missing-mistral-key", "tts-unreachable"]);
    expect(s.effective).toBe("web");
  });

  it("never degrades under auto, which asked for nothing", () => {
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mock", tts: "kokoro" });
    expect(s.requested).toBe("auto");
    expect(s.degraded).toBe(false);
    expect(s.reasons).toEqual([]);
  });

  it("still reports the truth under auto: a dead server voice reads as cloud", () => {
    noteTTSOutcome(false);
    const s = modeStatus({ brain: "mistral", tts: "kokoro" });
    expect(s.requested).toBe("auto");
    expect(s.effective).toBe("cloud");
    expect(s.degraded).toBe(false);
    expect(s.reasons).toEqual([]);
  });
});
