import { describe, it, expect, vi } from "vitest";
import { isRecordingSupported, MAX_DRILL_MS, MIN_DRILL_MS } from "./recorder.js";
import { startRecording } from "./recorder.js";
import { lastRecorder, lastMicTrack } from "../test/setup.js";

describe("recorder — capability probe", () => {
  it("reports support when both getUserMedia and MediaRecorder exist", () => {
    expect(isRecordingSupported()).toBe(true);
  });

  it("reports no support when MediaRecorder is missing", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(isRecordingSupported()).toBe(false);
  });

  it("reports no support when getUserMedia is missing", () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    expect(isRecordingSupported()).toBe(false);
  });

  it("caps a drill take at 15s and treats sub-300ms takes as mis-taps", () => {
    expect(MAX_DRILL_MS).toBe(15000);
    expect(MIN_DRILL_MS).toBe(300);
    expect(MIN_DRILL_MS).toBeLessThan(MAX_DRILL_MS);
  });
});

describe("recorder — happy path", () => {
  it("negotiates a supported mime type and reports it on the handle", async () => {
    const handle = await startRecording();
    expect(handle.mimeType).toBe("audio/webm;codecs=opus");
    expect(handle.state()).toBe("recording");
    expect(lastRecorder().started).toBe(1);
  });

  it("resolves the captured blob and the elapsed duration on stop()", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const handle = await startRecording();
      lastRecorder().emitData(new Blob(["abc"]));
      nowSpy.mockReturnValue(2500);
      const take = await handle.stop();
      expect(take.blob.size).toBe(3);
      expect(take.durationMs).toBe(1500);
      expect(handle.state()).toBe("stopped");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("releases every microphone track once the take is stopped", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    await handle.stop();
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
  });
});
