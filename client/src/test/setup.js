import "@testing-library/jest-dom/vitest";
import { toHaveNoViolations } from "jest-axe";
import { expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

expect.extend(toHaveNoViolations);

// --- Mock SpeechRecognition (jsdom has none) ---
export class MockSpeechRecognition {
  constructor() {
    this.lang = "";
    this.interimResults = false;
    this.continuous = false;
    this.maxAlternatives = 1;
    this.onstart = this.onresult = this.onerror = this.onend = null;
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
    MockSpeechRecognition.instances.push(this);
  }
  start() {
    this.started += 1;
    this.onstart?.();
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  // test helpers
  emitResult(results, resultIndex = 0) {
    this.onresult?.({ results, resultIndex });
  }
  emitError(error) {
    this.onerror?.({ error });
  }
  emitEnd() {
    this.onend?.();
  }
}
MockSpeechRecognition.instances = [];

export function lastRecognizer() {
  const list = MockSpeechRecognition.instances;
  return list[list.length - 1];
}

/** Build a SpeechRecognitionResultList-like array from [{transcript, isFinal}]. */
export function makeResults(list) {
  return list.map((r) => {
    const alt = { transcript: r.transcript };
    return Object.assign([alt], { isFinal: !!r.isFinal });
  });
}

// --- Mock MediaRecorder (jsdom has none) ---
export class MockMediaRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/webm";
    this.state = "inactive";
    this.ondataavailable = this.onstop = this.onerror = null;
    this.started = 0;
    this.stopped = 0;
    MockMediaRecorder.instances.push(this);
  }
  start() {
    this.started += 1;
    this.state = "recording";
  }
  stop() {
    this.stopped += 1;
    // The real API throws InvalidStateError when stopping an inactive recorder.
    if (this.state === "inactive") throw new Error("InvalidStateError");
    this.state = "inactive";
    // The real API fires onstop asynchronously; a microtask keeps that shape
    // without needing fake timers in every recorder test.
    queueMicrotask(() => this.onstop?.());
  }
  // test helpers
  emitData(blob) {
    this.ondataavailable?.({ data: blob });
  }
  emitError(name) {
    this.onerror?.({ error: name === undefined ? undefined : { name } });
  }
}
MockMediaRecorder.instances = [];
MockMediaRecorder.isTypeSupported = (type) => type === "audio/webm;codecs=opus";

export function lastRecorder() {
  const list = MockMediaRecorder.instances;
  return list[list.length - 1];
}

let micTrack = null;
/** The single MediaStreamTrack handed out by the stubbed getUserMedia this test. */
export function lastMicTrack() {
  return micTrack;
}

beforeEach(() => {
  MockSpeechRecognition.instances = [];
  vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
  vi.stubGlobal("webkitSpeechRecognition", MockSpeechRecognition);
  vi.stubGlobal("speechSynthesis", {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [{ lang: "en-US", name: "Test EN" }],
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(text) {
        this.text = text;
        this.lang = "";
        this.voice = null;
        this.rate = 1;
        this.pitch = 1;
        this.onstart = this.onend = this.onerror = null;
      }
    },
  );
  // jsdom's HTMLMediaElement.play() is unimplemented — make it a resolved Promise.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
  // jsdom has no layout engine, so Element.scrollTo is unimplemented.
  window.Element.prototype.scrollTo = vi.fn();
  // --- mic capture stubs (jsdom has neither) ---
  MockMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  micTrack = { kind: "audio", stop: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [micTrack] }) },
  });
  // jsdom's Blob has no arrayBuffer(); FormData upload paths poke at it.
  window.Blob.prototype.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(8));
  // Assigned, not vi.stubGlobal({...URL}) — spreading URL drops its constructor.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
