import { describe, it, expect, vi } from "vitest";
import { createRecognizer, playAudio, isSTTSupported, speak, pickEnglishVoiceForTest } from "./speech.js";
import { lastRecognizer, makeResults } from "../test/setup.js";

describe("createRecognizer", () => {
  it("configures a continuous, interim recognizer", () => {
    createRecognizer({});
    const rec = lastRecognizer();
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe("en-US");
  });

  it("emits only the newly finalized chunk via onResult", () => {
    const finals = [];
    createRecognizer({ onResult: (c) => finals.push(c) });
    const rec = lastRecognizer();
    // first event: one final "hello"
    rec.emitResult(makeResults([{ transcript: "hello", isFinal: true }]), 0);
    // second event: results advanced; new final "world" at index 1
    rec.emitResult(
      makeResults([
        { transcript: "hello", isFinal: true },
        { transcript: "world", isFinal: true },
      ]),
      1,
    );
    expect(finals).toEqual(["hello", "world"]);
  });

  it("emits the non-final tail via onInterim", () => {
    const interims = [];
    createRecognizer({ onInterim: (t) => interims.push(t) });
    const rec = lastRecognizer();
    rec.emitResult(makeResults([{ transcript: "how are", isFinal: false }]), 0);
    expect(interims.at(-1)).toBe("how are");
  });

  it("calls onStart/onEnd/onError passthroughs", () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    createRecognizer({ onStart, onEnd, onError });
    const rec = lastRecognizer();
    rec.start();
    rec.emitEnd();
    rec.emitError("no-speech");
    expect(onStart).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("no-speech");
  });
});

describe("playAudio", () => {
  it("returns null and calls onEnd when base64 is empty", () => {
    const onEnd = vi.fn();
    expect(playAudio("", { onEnd })).toBeNull();
    expect(onEnd).toHaveBeenCalled();
  });

  it("builds a wav data URI for format=wav", () => {
    const el = playAudio("AAAA", { format: "wav" });
    expect(el).toBeInstanceOf(HTMLAudioElement);
    expect(el.src.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  it("defaults to audio/mpeg for mp3", () => {
    const el = playAudio("AAAA", { format: "mp3" });
    expect(el.src.startsWith("data:audio/mpeg;base64,")).toBe(true);
  });
});

describe("speak", () => {
  it("no-ops and calls onEnd when text is empty", () => {
    const onEnd = vi.fn();
    speak("", { onEnd });
    expect(onEnd).toHaveBeenCalled();
  });

  it("speaks via speechSynthesis for non-empty text", () => {
    speak("hello");
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
  });
});

describe("pickEnglishVoiceForTest", () => {
  it("prefers en-US, then any en, then null", () => {
    window.speechSynthesis.getVoices = () => [{ lang: "fr-FR" }, { lang: "en-GB" }];
    expect(pickEnglishVoiceForTest().lang).toBe("en-GB");
    window.speechSynthesis.getVoices = () => [{ lang: "en-US" }, { lang: "en-GB" }];
    expect(pickEnglishVoiceForTest().lang).toBe("en-US");
    window.speechSynthesis.getVoices = () => [{ lang: "de-DE" }];
    expect(pickEnglishVoiceForTest()).toBeNull();
  });
});
