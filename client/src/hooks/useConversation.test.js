import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

let recHandlers = null;
let nextRecognizerNull = false; // flip true to force createRecognizer -> null once
let nextStartThrows = false; // flip true to force the next recognizer.start() -> throw once

vi.mock("../lib/api.js", () => ({
  postTurn: vi.fn(),
  getHealth: vi.fn(),
}));
vi.mock("../lib/speech.js", async () => {
  const actual = await vi.importActual("../lib/speech.js");
  return {
    ...actual,
    warmUpVoices: vi.fn(),
    isSTTSupported: vi.fn(() => true),
    speak: vi.fn((_t, o) => o?.onEnd?.()),
    stopSpeaking: vi.fn(),
    playAudio: vi.fn(() => ({ pause: vi.fn() })),
    createRecognizer: (handlers) => {
      if (nextRecognizerNull) {
        nextRecognizerNull = false;
        return null;
      }
      recHandlers = handlers;
      return {
        start: () => {
          if (nextStartThrows) {
            nextStartThrows = false;
            throw new Error("InvalidStateError");
          }
          handlers.onStart?.();
        },
        stop: () => handlers.onEnd?.(),
        abort: () => {},
      };
    },
  };
});

import { postTurn, getHealth } from "../lib/api.js";
import { playAudio, speak, stopSpeaking } from "../lib/speech.js";
import { useConversation } from "./useConversation.js";

beforeEach(() => {
  getHealth.mockResolvedValue({ brain: "mock", tts: "kokoro", stt: "none" });
  postTurn.mockReset();
  playAudio.mockClear();
  speak.mockClear();
  stopSpeaking.mockClear();
  nextRecognizerNull = false;
  nextStartThrows = false;
});

describe("useConversation — text path", () => {
  it("pushes the user bubble immediately, then the coach reply, and adds XP", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Nice!", xp: 10, audio: "AAAA", audioFormat: "mp3" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("I went hiking"));
    // user bubble optimistic
    expect(result.current.messages.at(-1)).toMatchObject({ role: "user", text: "I went hiking" });
    expect(result.current.status).toBe("thinking");
    expect(postTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: "I went hiking",
        history: expect.arrayContaining([{ role: "user", text: "I went hiking" }]),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("speaking"));
    expect(result.current.messages.at(-1)).toMatchObject({ role: "coach", text: "Nice!" });
    expect(result.current.totalXp).toBe(10);
    expect(playAudio).toHaveBeenCalled();
  });

  it("plays browser voice and flags fallback when audio is null for a kokoro provider", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Ok", xp: 5, audio: null });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("hello"));
    // The browser-voice mock fires onEnd synchronously, so "speaking" collapses to
    // "idle" in one React batch and is never an observable commit — assert the
    // fallback was invoked and flagged instead of the transient state.
    await waitFor(() => expect(speak).toHaveBeenCalled());
    expect(result.current.ttsFallbackActive).toBe(true);
  });

  it("rolls back the optimistic bubble and repopulates the draft on brain failure", async () => {
    postTurn.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("hello"));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.messages).toHaveLength(1); // optimistic bubble rolled back (greeting only)
    expect(result.current.draft).toBe("hello"); // repopulated for retry
  });

  it("ignores submitText when not idle or empty", async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));
    act(() => result.current.submitText("   "));
    expect(result.current.messages).toHaveLength(1); // greeting only
  });
});

describe("useConversation — speech machine", () => {
  async function mounted() {
    const utils = renderHook(() => useConversation());
    await waitFor(() => expect(utils.result.current.providers.tts).toBe("kokoro"));
    return utils;
  }

  it("startListening enters listening and streams interim + final into the draft", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    expect(result.current.status).toBe("listening");

    act(() => recHandlers.onResult("Yesterday I"));
    act(() => recHandlers.onInterim("went to the"));
    expect(result.current.liveTranscript).toBe("Yesterday I went to the");

    act(() => recHandlers.onResult("went to the park")); // new finalized chunk appended
    expect(result.current.draft).toBe("Yesterday I went to the park");
  });

  it("user stop with a non-empty draft goes to review", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("Hello there"));
    act(() => result.current.stopListening()); // fake stop() -> onEnd
    expect(result.current.status).toBe("review");
    expect(result.current.draft).toBe("Hello there");
  });

  it("user stop with an empty draft returns to idle with a message", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => result.current.stopListening());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/didn't catch that/i);
  });

  it("auto onend without a user stop keeps listening (restart)", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    // simulate Chrome self-terminating on silence: onEnd fires, userStopped=false
    act(() => recHandlers.onEnd());
    expect(result.current.status).toBe("listening");
  });

  it("finalizes with the no-speech message after MAX_EMPTY_RESTARTS consecutive empty auto-restarts", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    for (let i = 0; i < 6; i++) act(() => recHandlers.onEnd()); // counter 0->6, guard not yet tripped
    expect(result.current.status).toBe("listening");
    act(() => recHandlers.onEnd()); // 7th empty auto-onEnd trips the guard -> finalize
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/didn't catch that/i);
  });

  it("onResult resets the empty-restart counter so speech mid-session doesn't trip the guard", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    for (let i = 0; i < 5; i++) act(() => recHandlers.onEnd()); // counter -> 5
    act(() => recHandlers.onResult("hello")); // resets counter to 0
    for (let i = 0; i < 6; i++) act(() => recHandlers.onEnd()); // counter -> 6, under threshold
    expect(result.current.status).toBe("listening");
  });

  it("finalizes instead of looping when the continuity restart's start() throws", async () => {
    // mounted() awaits testing-library's real-timer waitFor for the health-check
    // effect, which vitest fake timers don't drive without shouldAdvanceTime — so
    // mount first, then switch to fake timers only for the deferred-restart tick.
    const { result } = await mounted();
    vi.useFakeTimers();
    try {
      act(() => result.current.startListening()); // first start() succeeds (onStart -> listening)
      nextStartThrows = true;
      act(() => recHandlers.onEnd());          // empty draft, userStopped=false -> schedules deferred restart
      act(() => vi.advanceTimersByTime(1));     // run the setTimeout(0) -> start() throws -> catch -> finishListening(false)
      expect(result.current.status).toBe("idle");
      expect(result.current.error).toBeNull();  // finishListening(false): no announceEmpty
    } finally {
      vi.useRealTimers();
    }
  });

  it("send posts the edited draft and clears it", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("i like it"));
    act(() => result.current.stopListening());
    act(() => result.current.editDraft("I like it a lot"));
    act(() => result.current.send());
    expect(result.current.messages.at(-1)).toMatchObject({ role: "user", text: "I like it a lot" });
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    expect(result.current.draft).toBe("");
    expect(postTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: "I like it a lot",
        history: expect.arrayContaining([{ role: "user", text: "I like it a lot" }]),
      }),
    );
  });

  it("barge-in during speaking stops playback and re-enters listening", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    act(() => result.current.submitText("hello"));
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    const before = stopSpeaking.mock.calls.length;
    act(() => result.current.interrupt());
    expect(stopSpeaking.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.status).toBe("listening");
  });

  it("barge-in clears the stale speak-timeout so a late toIdle cannot fire after re-entering listening", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
      const { result } = await mounted();
      act(() => result.current.submitText("hello"));
      await vi.waitFor(() => expect(result.current.status).toBe("speaking"));
      act(() => result.current.interrupt());
      expect(result.current.status).toBe("listening");
      act(() => vi.advanceTimersByTime(10000)); // well past the >=4s fallback
      expect(result.current.status).toBe("listening"); // stale toIdle must not fire
    } finally {
      vi.useRealTimers();
    }
  });

  it("replay is only allowed from idle and does not change state", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening()); // now listening
    act(() => result.current.replay({ text: "hi", audio: "AAAA", audioFormat: "mp3" }));
    expect(result.current.status).toBe("listening"); // ignored while listening
    expect(playAudio).not.toHaveBeenCalled();
  });

  it("fatal mic error surfaces the permission message and stops listening", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onError("not-allowed"));
    act(() => recHandlers.onEnd());
    expect(result.current.error).toMatch(/permission/i);
    expect(result.current.status).toBe("idle");
  });

  it("reRecord clears the draft and restarts listening; cancel returns to idle", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("hello"));
    act(() => result.current.stopListening()); // -> review
    act(() => result.current.reRecord());
    expect(result.current.status).toBe("listening");
    expect(result.current.draft).toBe("");
    act(() => recHandlers.onResult("again"));
    act(() => result.current.stopListening()); // -> review
    act(() => result.current.cancel());
    expect(result.current.status).toBe("idle");
    expect(result.current.draft).toBe("");
  });

  it("network and no-speech errors set the right messages", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onError("network"));
    act(() => recHandlers.onEnd());
    expect(result.current.error).toMatch(/speech service unavailable/i);
    act(() => result.current.startListening());
    act(() => recHandlers.onError("no-speech")); // non-fatal
    act(() => result.current.stopListening());   // user stop, empty -> idle + message
    expect(result.current.error).toMatch(/didn't catch that/i);
  });

  it("replay from idle plays the coach audio", async () => {
    const { result } = await mounted();
    act(() => result.current.replay({ text: "hi", audio: "AAAA", audioFormat: "mp3" }));
    expect(playAudio).toHaveBeenCalled();
  });

  it("finalizes to review once past the max session cap", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("something"));
    nowSpy.mockReturnValue(200000); // past MAX_LISTEN_MS
    act(() => recHandlers.onEnd());  // auto onend past the cap -> finalize
    expect(result.current.status).toBe("review");
    nowSpy.mockRestore();
  });

  it("returns to idle with a message when the recognizer is unsupported", async () => {
    const { result } = await mounted();
    nextRecognizerNull = true;
    act(() => result.current.startListening());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/isn't supported/i);
  });

  it("error then successful resend yields exactly one user bubble", async () => {
    postTurn.mockRejectedValueOnce(new Error("boom"));
    postTurn.mockResolvedValueOnce({ coach_reply: "ok", xp: 1, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    act(() => result.current.submitText("my answer"));
    await waitFor(() => expect(result.current.status).toBe("review")); // rolled back
    expect(result.current.draft).toBe("my answer");
    act(() => result.current.send());
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  // --- extra branch coverage: guards, fallbacks, and edge cases ---

  it("skips the provider update when getHealth resolves falsy", async () => {
    getHealth.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(getHealth).toHaveBeenCalled());
    expect(result.current.providers.tts).toBeNull();
  });

  it("toIdle no-ops once status has already left speaking", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
    let capturedOnEnd;
    playAudio.mockImplementationOnce((_audio, opts) => {
      capturedOnEnd = opts.onEnd;
      return { pause: vi.fn() };
    });
    const { result } = await mounted();
    act(() => result.current.submitText("hello"));
    await waitFor(() => expect(result.current.status).toBe("speaking"));
    act(() => capturedOnEnd());
    expect(result.current.status).toBe("idle");
    act(() => capturedOnEnd()); // stray second call after already idle — no-ops
    expect(result.current.status).toBe("idle");
  });

  it("does not flag TTS fallback when no server voice is expected and xp is omitted", async () => {
    getHealth.mockResolvedValueOnce({ brain: "mock", tts: "browser", stt: "none" });
    postTurn.mockResolvedValue({ coach_reply: "Ok", audio: null });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("browser"));
    act(() => result.current.submitText("hi"));
    await waitFor(() => expect(result.current.messages.at(-1)).toMatchObject({ role: "coach", text: "Ok" }));
    expect(result.current.ttsFallbackActive).toBe(false);
    expect(result.current.totalXp).toBe(0);
  });

  it("falls back to a generic error message when the rejection has none", async () => {
    postTurn.mockRejectedValueOnce(new Error());
    const { result } = await mounted();
    act(() => result.current.submitText("hi"));
    await waitFor(() => expect(result.current.status).toBe("review"));
    expect(result.current.error).toBe("The coach brain failed to respond.");
  });

  it("falls back to browser speech when server audio playback errors", async () => {
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 1, audio: "AAAA", audioFormat: "mp3" });
    playAudio.mockImplementationOnce((_audio, opts) => {
      opts.onError();
      return { pause: vi.fn() };
    });
    const { result } = await mounted();
    act(() => result.current.submitText("hi"));
    await waitFor(() => expect(speak).toHaveBeenCalled());
  });

  it("times out silently to idle when nothing was captured", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const { result } = await mounted();
    act(() => result.current.startListening());
    nowSpy.mockReturnValue(200000); // past MAX_LISTEN_MS, draft still empty
    act(() => recHandlers.onEnd());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    nowSpy.mockRestore();
  });

  it("aborted recognizer errors are non-fatal", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onError("aborted"));
    act(() => result.current.stopListening());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/didn't catch that/i);
  });

  it("unknown recognizer error codes surface a generic message", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onError("weird-code"));
    expect(result.current.error).toBe("Speech error: weird-code");
  });

  it("ignores a stray recognizer onEnd event outside listening", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => result.current.stopListening()); // empty draft -> idle
    const statusAfterStop = result.current.status;
    act(() => recHandlers.onEnd()); // stray late event; must be a no-op
    expect(result.current.status).toBe(statusAfterStop);
  });

  it("startListening is a no-op while already listening", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    const firstHandlers = recHandlers;
    act(() => result.current.startListening()); // already listening — guarded no-op
    expect(recHandlers).toBe(firstHandlers); // createRecognizer not called again
    expect(result.current.status).toBe("listening");
  });

  it("stopListening is a no-op when not listening", async () => {
    const { result } = await mounted();
    act(() => result.current.stopListening()); // idle -> no-op
    expect(result.current.status).toBe("idle");
  });

  it("send is a no-op outside review", async () => {
    const { result } = await mounted();
    act(() => result.current.send()); // idle -> no-op
    expect(result.current.messages).toHaveLength(1);
    expect(postTurn).not.toHaveBeenCalled();
  });

  it("send with a whitespace-only draft returns to idle without posting", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => recHandlers.onResult("x"));
    act(() => result.current.stopListening()); // -> review
    act(() => result.current.editDraft("   "));
    act(() => result.current.send());
    expect(result.current.status).toBe("idle");
    expect(postTurn).not.toHaveBeenCalled();
  });

  it("reRecord is a no-op outside review", async () => {
    const { result } = await mounted();
    act(() => result.current.reRecord()); // idle -> no-op
    expect(result.current.status).toBe("idle");
  });

  it("cancel is a no-op outside review", async () => {
    const { result } = await mounted();
    act(() => result.current.cancel()); // idle -> no-op
    expect(result.current.status).toBe("idle");
  });

  it("interrupt is a no-op outside speaking", async () => {
    const { result } = await mounted();
    const callsBefore = stopSpeaking.mock.calls.length;
    act(() => result.current.interrupt()); // idle -> no-op
    expect(result.current.status).toBe("idle");
    expect(stopSpeaking.mock.calls.length).toBe(callsBefore);
  });

  it("replay without audio falls back to browser speech", async () => {
    const { result } = await mounted();
    act(() => result.current.replay({ text: "hi there" }));
    expect(speak).toHaveBeenCalledWith("hi there");
  });

  it("clearError resets the error to null", async () => {
    const { result } = await mounted();
    act(() => result.current.startListening());
    act(() => result.current.stopListening()); // empty draft -> idle + error
    expect(result.current.error).toMatch(/didn't catch that/i);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
