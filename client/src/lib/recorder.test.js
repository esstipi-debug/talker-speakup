import { describe, it, expect, vi } from "vitest";
import { isRecordingSupported, MAX_DRILL_MS, MIN_DRILL_MS } from "./recorder.js";

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
