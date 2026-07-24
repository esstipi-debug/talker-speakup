import { describe, it, expect, vi } from "vitest";
import {
  createRecognizer,
  playAudio,
  isSTTSupported,
  speak,
  pickEnglishVoiceForTest,
  warmUpVoices,
  stopSpeaking,
} from "./speech.js";
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

describe("voice helpers coverage", () => {
  it("warmUpVoices and stopSpeaking are safe to call", () => {
    warmUpVoices();
    stopSpeaking();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  it("playAudio builds an ogg data URI for opus", () => {
    const el = playAudio("AAAA", { format: "opus" });
    expect(el.src.startsWith("data:audio/ogg;base64,")).toBe(true);
  });

  it("falls back through webkitSpeechRecognition, then to unsupported", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    expect(isSTTSupported()).toBe(true); // webkitSpeechRecognition stub still present
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    expect(isSTTSupported()).toBe(false);
    expect(createRecognizer({})).toBeNull();
  });

  it("treats a missing transcript as an empty string", () => {
    const interims = [];
    createRecognizer({ onInterim: (t) => interims.push(t) });
    const rec = lastRecognizer();
    rec.emitResult(makeResults([{ isFinal: false }]), 0); // no transcript provided
    expect(interims.at(-1)).toBe("");
  });

  it("defaults to a generic error code when the event has none", () => {
    const onError = vi.fn();
    createRecognizer({ onError });
    const rec = lastRecognizer();
    rec.emitError(undefined);
    expect(onError).toHaveBeenCalledWith("speech-error");
  });

  it("warmUpVoices and stopSpeaking no-op when TTS isn't supported", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(() => warmUpVoices()).not.toThrow();
    expect(() => stopSpeaking()).not.toThrow();
  });

  it("speak proceeds without setting a voice when none matches", () => {
    window.speechSynthesis.getVoices = () => [{ lang: "de-DE" }];
    speak("hallo");
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
  });

  it("invokes the utterance onstart/onend/onerror handlers", () => {
    let captured;
    window.speechSynthesis.speak = vi.fn((u) => {
      captured = u;
    });
    const onStart = vi.fn();
    const onEnd = vi.fn();
    speak("hello", { onStart, onEnd });
    captured.onstart();
    captured.onend();
    captured.onerror();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(2); // once via onend, once via the onerror fallback
  });

  it("invokes the audio onplay/onended handlers", () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const el = playAudio("AAAA", { onStart, onEnd });
    el.onplay();
    el.onended();
    expect(onStart).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
  });

  it("audio onerror calls onError when provided, else falls back to onEnd", () => {
    const onError = vi.fn();
    const el1 = playAudio("AAAA", { onError });
    el1.onerror();
    expect(onError).toHaveBeenCalled();

    const onEnd = vi.fn();
    const el2 = playAudio("AAAA", { onEnd });
    el2.onerror();
    expect(onEnd).toHaveBeenCalled();
  });

  it("a play() rejection calls onError when provided, else falls back to onEnd", async () => {
    const originalPlay = window.HTMLMediaElement.prototype.play;
    window.HTMLMediaElement.prototype.play = vi.fn().mockRejectedValue(new Error("blocked"));

    const onError = vi.fn();
    playAudio("AAAA", { onError });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();

    const onEnd = vi.fn();
    playAudio("AAAA", { onEnd });
    await Promise.resolve();
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalled();

    window.HTMLMediaElement.prototype.play = originalPlay;
  });
});
