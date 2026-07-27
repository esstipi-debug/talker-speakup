import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * jsdom has no Web Audio, so we test the processor directly by stubbing the
 * exact four globals an AudioWorkletGlobalScope provides, then driving
 * process() in 128-sample quanta. (standardized-audio-context-mock is not an
 * option — its AudioWorkletNodeMock is a literal `// @todo` empty stub.)
 */
let registered = null;

class FakePort {
  constructor() { this.messages = []; }
  postMessage(m) { this.messages.push(m); }
}

async function loadProcessor(options) {
  registered = null;
  vi.stubGlobal("AudioWorkletProcessor", class { constructor() { this.port = new FakePort(); } });
  vi.stubGlobal("registerProcessor", (name, ctor) => { registered = { name, ctor }; });
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal("currentTime", 0);
  vi.resetModules();
  await import("./pcm.worklet.js");
  return new registered.ctor({ processorOptions: options });
}

/** Drive N quanta of 128 samples at a constant amplitude. */
function pump(proc, quanta, amplitude) {
  const block = new Float32Array(128).fill(amplitude);
  for (let i = 0; i < quanta; i += 1) proc.process([[block]], [[new Float32Array(128)]], {});
}

beforeEach(() => { registered = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("pcm.worklet", () => {
  it("registers under the name micStream looks up", async () => {
    await loadProcessor({});
    expect(registered.name).toBe("pcm-processor");
  });

  it("batches frames instead of posting every hop", async () => {
    const proc = await loadProcessor({ batchHops: 32 });
    pump(proc, 31, 0.5);
    expect(proc.port.messages).toHaveLength(0);
    pump(proc, 1, 0.5);
    expect(proc.port.messages).toHaveLength(1);
    expect(proc.port.messages[0].rmsDb).toHaveLength(32);
  });

  it("reports a full-scale block near 0 dB and a silent block far below it", async () => {
    const proc = await loadProcessor({ batchHops: 1 });
    pump(proc, 1, 1.0);
    expect(proc.port.messages[0].rmsDb[0]).toBeCloseTo(0, 1);
    pump(proc, 1, 0.0);
    expect(proc.port.messages[1].rmsDb[0]).toBeLessThan(-100);
  });

  it("keeps returning true so the node is never garbage collected mid-turn", async () => {
    const proc = await loadProcessor({});
    expect(proc.process([[new Float32Array(128)]], [[new Float32Array(128)]], {})).toBe(true);
  });

  it("survives a quantum with no input channel (the node is connected but the track is muted)", async () => {
    const proc = await loadProcessor({ batchHops: 1 });
    expect(() => proc.process([[]], [[new Float32Array(128)]], {})).not.toThrow();
  });
});
