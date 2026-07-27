import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Web Audio stubs live HERE, not in setup.js — the 93 existing tests must not
 * suddenly gain a fake AudioContext. navigator is a getter, so it is patched
 * with defineProperty; replacing it wholesale breaks user-event.
 */
let workletNode;
let addModuleCalls;
let stopCalls;

function installWebAudioStubs() {
  addModuleCalls = 0;
  stopCalls = 0;
  const track = {
    stop: () => { stopCalls += 1; },
    getSettings: () => ({ sampleRate: 48000, echoCancellation: false, autoGainControl: false }),
  };
  const stream = { getAudioTracks: () => [track] };

  vi.stubGlobal("AudioWorkletNode", class {
    constructor() { this.port = { onmessage: null, postMessage: vi.fn() }; workletNode = this; }
    connect() {}
    disconnect() {}
  });
  vi.stubGlobal("AudioContext", class {
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.audioWorklet = { addModule: async () => { addModuleCalls += 1; } }; }
    createMediaStreamSource() { return { connect: () => {} }; }
    close() { return Promise.resolve(); }
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
}

beforeEach(() => { vi.resetModules(); installWebAudioStubs(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("micStream", () => {
  it("requests the mic with every browser processor disabled", async () => {
    const { getMicStream } = await import("./micStream.js");
    await getMicStream();
    const constraints = navigator.mediaDevices.getUserMedia.mock.calls[0][0];
    expect(constraints.audio.echoCancellation).toBe(false);
    expect(constraints.audio.noiseSuppression).toBe(false);
    expect(constraints.audio.autoGainControl).toBe(false);
    expect(constraints.audio.channelCount).toBe(1);
  });

  it("opens capture only once no matter how often it is called", async () => {
    const { getMicStream } = await import("./micStream.js");
    await getMicStream();
    await getMicStream();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(addModuleCalls).toBe(1);
  });

  it("accumulates frames posted by the worklet", async () => {
    const { getMicStream, getFrames } = await import("./micStream.js");
    await getMicStream();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10, -20]) } });
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-30]) } });
    expect(Array.from(getFrames())).toEqual([-10, -20, -30]);
  });

  it("keeps the ring across a reset of nothing — resetFrames only clears frames", async () => {
    const { getMicStream, getFrames, resetFrames } = await import("./micStream.js");
    await getMicStream();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10]) } });
    resetFrames();
    expect(getFrames()).toHaveLength(0);
  });

  it("reports the hop duration derived from the real sample rate", async () => {
    const { getMicStream, getHopMs } = await import("./micStream.js");
    await getMicStream();
    expect(getHopMs()).toBeCloseTo((128 / 48000) * 1000, 5);
  });

  it("records what the browser actually applied, not what we asked for", async () => {
    const { getMicStream, getCaptureSettings } = await import("./micStream.js");
    await getMicStream();
    expect(getCaptureSettings()).toEqual({ sampleRate: 48000, echoCancellation: false, autoGainControl: false });
  });

  it("stops the track on release so the mic indicator goes out", async () => {
    const { getMicStream, releaseMicStream, isMicOpen } = await import("./micStream.js");
    await getMicStream();
    releaseMicStream();
    expect(stopCalls).toBe(1);
    expect(isMicOpen()).toBe(false);
  });

  it("is safe to release when never opened", async () => {
    const { releaseMicStream } = await import("./micStream.js");
    expect(() => releaseMicStream()).not.toThrow();
  });

  it("returns 0 from micNowMs when capture is closed", async () => {
    const { micNowMs } = await import("./micStream.js");
    expect(micNowMs()).toBe(0);
  });
});
