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

describe("recorder — failure paths", () => {
  it("resolves null and reports 'unsupported' when MediaRecorder is missing", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const onError = vi.fn();
    await expect(startRecording({ onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("unsupported");
  });

  it("resolves null with the DOMException name when the user refuses the mic", async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const onError = vi.fn();
    await expect(startRecording({ onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("NotAllowedError");
  });

  it("falls back to 'mic-error' when the rejection carries no name", async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce({});
    const onError = vi.fn();
    await expect(startRecording({ onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("mic-error");
  });

  it("forwards recorder errors, defaulting to 'recorder-error'", async () => {
    const onError = vi.fn();
    await startRecording({ onError });
    lastRecorder().emitError("SecurityError");
    lastRecorder().emitError(undefined);
    expect(onError).toHaveBeenNthCalledWith(1, "SecurityError");
    expect(onError).toHaveBeenNthCalledWith(2, "recorder-error");
  });

  it("resolves null and reports 'empty-recording' when nothing was captured", async () => {
    const onError = vi.fn();
    const handle = await startRecording({ onError });
    await expect(handle.stop()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith("empty-recording");
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
  });
});

describe("recorder — races", () => {
  it("stop() is idempotent: the second call resolves null and does not re-stop", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    const first = await handle.stop();
    expect(first.blob.size).toBe(3);
    await expect(handle.stop()).resolves.toBeNull();
    expect(lastRecorder().stopped).toBe(1);
  });

  it("cancel() discards the take, releases the mic, and makes a later stop() resolve null", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    handle.cancel();
    expect(handle.state()).toBe("cancelled");
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
    await expect(handle.stop()).resolves.toBeNull();
  });

  it("cancel() is idempotent", async () => {
    const handle = await startRecording();
    handle.cancel();
    handle.cancel();
    expect(lastMicTrack().stop).toHaveBeenCalledTimes(1);
    expect(lastRecorder().stopped).toBe(1);
  });

  it("cancel() racing an in-flight stop() resolves that stop() with null", async () => {
    const handle = await startRecording();
    lastRecorder().emitData(new Blob(["abc"]));
    const pending = handle.stop(); // recorder.stop() queued its onstop microtask
    handle.cancel(); // lands synchronously, before onstop runs
    await expect(pending).resolves.toBeNull();
  });

  it("auto-stops at maxMs, notifies, and still hands the take to a later stop()", async () => {
    // Fake timers must be installed before startRecording, because the cap timer
    // is armed inside it. No waitFor runs under them, so this is safe.
    vi.useFakeTimers();
    try {
      const onAutoStop = vi.fn();
      const handle = await startRecording({ maxMs: 500, onAutoStop });
      lastRecorder().emitData(new Blob(["abcd"]));
      vi.advanceTimersByTime(500);
      expect(onAutoStop).toHaveBeenCalledTimes(1);
      expect(handle.state()).toBe("stopped");
      const take = await handle.stop();
      expect(take.blob.size).toBe(4);
      expect(lastRecorder().stopped).toBe(1); // the cap stopped it, stop() did not re-stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the cap after a manual stop", async () => {
    vi.useFakeTimers();
    try {
      const onAutoStop = vi.fn();
      const handle = await startRecording({ maxMs: 500, onAutoStop });
      lastRecorder().emitData(new Blob(["abcd"]));
      await handle.stop();
      vi.advanceTimersByTime(5000);
      expect(onAutoStop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
