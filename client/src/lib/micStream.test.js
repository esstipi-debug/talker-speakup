import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Web Audio stubs live HERE, not in setup.js — the 93 existing tests must not
 * suddenly gain a fake AudioContext. navigator is a getter, so it is patched
 * with defineProperty; replacing it wholesale breaks user-event.
 */
let workletNode;
let addModuleCalls;
let stopCalls;
let stubCurrentTime;

function installWebAudioStubs() {
  addModuleCalls = 0;
  stopCalls = 0;
  stubCurrentTime = 0;
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
    constructor() {
      this.sampleRate = 48000;
      Object.defineProperty(this, "currentTime", { get: () => stubCurrentTime });
      this.audioWorklet = { addModule: async () => { addModuleCalls += 1; } };
    }
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

  it("accumulates frames posted by the worklet during an active measurement window", async () => {
    const { getMicStream, getFrames, resetFrames } = await import("./micStream.js");
    await getMicStream();
    resetFrames(); // opens the collection window
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10, -20]) } });
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-30]) } });
    expect(Array.from(getFrames())).toEqual([-10, -20, -30]);
  });

  it("drops frames posted before any window has been opened", async () => {
    // The mic stays open across turns/idle time by design; without an active
    // window the ring must not grow at all.
    const { getMicStream, getFrames } = await import("./micStream.js");
    await getMicStream();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10, -20]) } });
    expect(getFrames()).toHaveLength(0);
  });

  it("keeps the ring across a reset of nothing — resetFrames only clears frames", async () => {
    const { getMicStream, getFrames, resetFrames } = await import("./micStream.js");
    await getMicStream();
    resetFrames();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10]) } });
    resetFrames();
    expect(getFrames()).toHaveLength(0);
  });

  it("stops collecting once stopFrames() is called, so a further worklet message is dropped", async () => {
    const { getMicStream, getFrames, resetFrames, stopFrames } = await import("./micStream.js");
    await getMicStream();
    resetFrames();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-10]) } });
    stopFrames();
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-20]) } });
    expect(Array.from(getFrames())).toEqual([-10]); // the post-stop batch never lands
  });

  it("resumes collecting on the next resetFrames() after stopFrames() closed the window", async () => {
    const { getMicStream, getFrames, resetFrames, stopFrames } = await import("./micStream.js");
    await getMicStream();
    resetFrames();
    stopFrames();
    resetFrames(); // a new turn opens a new window
    workletNode.port.onmessage({ data: { type: "frames", rmsDb: Float32Array.from([-15]) } });
    expect(Array.from(getFrames())).toEqual([-15]);
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

  it("opens capture once when two callers race before the first resolves", async () => {
    const { getMicStream } = await import("./micStream.js");
    await Promise.all([getMicStream(), getMicStream()]);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("ignores worklet messages that are not frames", async () => {
    const { getMicStream, getFrames } = await import("./micStream.js");
    await getMicStream();
    workletNode.port.onmessage({ data: { type: "ring", pcm: new Float32Array(4) } });
    expect(getFrames()).toHaveLength(0);
  });

  it("reports elapsed worklet time while the mic is open", async () => {
    const { getMicStream, micNowMs } = await import("./micStream.js");
    await getMicStream();
    expect(micNowMs()).toBe(0); // the stub's currentTime starts at 0
  });

  it("falls back to a default hop duration before the mic is opened", async () => {
    const { getHopMs, getCaptureSettings } = await import("./micStream.js");
    expect(getHopMs()).toBeCloseTo((128 / 48000) * 1000, 5);
    expect(getCaptureSettings()).toBeNull();
  });

  it("still releases when disconnecting the node throws", async () => {
    const { getMicStream, releaseMicStream, isMicOpen } = await import("./micStream.js");
    await getMicStream();
    workletNode.disconnect = () => { throw new Error("already torn down"); };
    expect(() => releaseMicStream()).not.toThrow();
    expect(stopCalls).toBe(1);
    expect(isMicOpen()).toBe(false);
  });

  it("stops the track when the worklet module fails to load", async () => {
    const { getMicStream, isMicOpen } = await import("./micStream.js");
    // Break addModule AFTER getUserMedia has already handed us a live track.
    const BrokenCtx = class {
      constructor() {
        this.sampleRate = 48000;
        Object.defineProperty(this, "currentTime", { get: () => stubCurrentTime });
        this.audioWorklet = { addModule: async () => { throw new Error("worklet 404"); } };
      }
      createMediaStreamSource() { return { connect: () => {} }; }
      close() { return Promise.resolve(); }
    };
    vi.stubGlobal("AudioContext", BrokenCtx);

    await expect(getMicStream()).rejects.toThrow("worklet 404");
    expect(stopCalls).toBe(1); // the live track was stopped, not abandoned
    expect(isMicOpen()).toBe(false);
  });

  it("honours a release requested while acquisition is still in flight", async () => {
    const { getMicStream, releaseMicStream, isMicOpen } = await import("./micStream.js");
    const acquiring = getMicStream();
    releaseMicStream(); // tab hidden mid-acquisition
    await acquiring;
    expect(isMicOpen()).toBe(false);
    expect(stopCalls).toBe(1); // and the mic is genuinely off, not just forgotten
  });

  it("re-bases its clock on resetFrames, so frame indices and timestamps share an origin", async () => {
    const { getMicStream, micNowMs, resetFrames } = await import("./micStream.js");
    await getMicStream();

    stubCurrentTime = 300; // five minutes into the session
    expect(micNowMs()).toBe(300_000);

    resetFrames(); // a new turn: the frame buffer restarts at index 0...
    expect(micNowMs()).toBe(0); // ...and so does the clock the caller sees

    stubCurrentTime = 302;
    expect(micNowMs()).toBe(2000); // two seconds into THIS turn, not the session
  });

  it("starts the epoch at zero when the buffer is reset before the mic is open", async () => {
    // startListening() calls resetFrames() before getMicStream() — this is the
    // ordering every session's first turn takes.
    const { getMicStream, micNowMs, resetFrames } = await import("./micStream.js");
    resetFrames();
    expect(micNowMs()).toBe(0);

    await getMicStream();
    stubCurrentTime = 4;
    expect(micNowMs()).toBe(4000); // a fresh context starts at 0, so no offset is lost
  });
});
