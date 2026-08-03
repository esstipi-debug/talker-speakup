import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";

let recHandlers = null;
let nextRecognizerNull = false; // flip true to force createRecognizer -> null once
let nextStartThrows = false; // flip true to force the next recognizer.start() -> throw once

vi.mock("../lib/api.js", () => ({
  postTurn: vi.fn(),
  postFeedback: vi.fn(),
  getHealth: vi.fn(),
  postTurnOpen: vi.fn(),
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
vi.mock("../lib/micStream.js", () => ({
  getMicStream: vi.fn(async () => {}),
  releaseMicStream: vi.fn(),
  micNowMs: vi.fn(() => 0),
  resetFrames: vi.fn(),
  stopFrames: vi.fn(),
  getFrames: vi.fn(() => new Float32Array(0)),
  getHopMs: vi.fn(() => 10),
  getCaptureSettings: vi.fn(() => null),
  isMicOpen: vi.fn(() => true),
}));

import { postTurn, postFeedback, getHealth, postTurnOpen } from "../lib/api.js";
import { playAudio, speak, stopSpeaking } from "../lib/speech.js";
import { useConversation } from "./useConversation.js";

beforeEach(() => {
  getHealth.mockResolvedValue({ brain: "mock", tts: "kokoro", stt: "none" });
  postTurn.mockReset();
  postFeedback.mockReset();
  postFeedback.mockResolvedValue(null);
  postTurnOpen.mockReset();
  postTurnOpen.mockResolvedValue(null);
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

describe("useConversation — deferred feedback", () => {
  it("attaches feedback to the message that produced it, not the newest one", async () => {
    let resolveFirst;
    postFeedback
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      // Never resolves within the test: with real (non-fake) timers, a second
      // resolved mock would settle before the assertions run regardless of
      // attachment order, which would prove nothing about the race. Leaving
      // it pending isolates the one thing under test — that turn 1's late
      // payload lands on message 1, not on whichever message is newest.
      .mockImplementationOnce(() => new Promise(() => {}));
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });

    const { result } = renderHook(() => useConversation());

    await act(async () => { await result.current.submitText("first utterance"); });
    await act(async () => { await result.current.submitText("second utterance"); });

    // The first turn's feedback arrives only now, after a second turn exists.
    await act(async () => {
      resolveFirst({
        corrections: [{ span: [0, 5], original: "first", suggestion: "1st", message: "m", kind: "grammar", pattern: "p", source: "harper" }],
        upgrades: [],
        passes: { mechanical: "ok", pedagogical: "ok" },
      });
    });

    const userMessages = result.current.messages.filter((m) => m.role === "user");
    expect(userMessages[0].feedback.corrections).toHaveLength(1);
    expect(userMessages[1].feedback).toBeNull();
  });

  // Spec §5.2: correction spans are offsets into this exact string.
  it("sends /feedback the byte-identical utterance it sent /turn", async () => {
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const messy = "  I have 30 years, y'know...  ";
    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText(messy); });

    const sentToTurn = postTurn.mock.calls[0][0].utterance;
    const sentToFeedback = postFeedback.mock.calls[0][0].utterance;
    expect(sentToFeedback).toBe(sentToTurn);
  });

  it("leaves the conversation intact when feedback fails", async () => {
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText("hello there"); });

    expect(result.current.error).toBeNull();
    expect(result.current.messages.filter((m) => m.role === "user")[0].feedback).toBeNull();
  });

  // Coordinator fix round 1, finding 2: a snapshot rollback captured before
  // this turn started would also wipe out feedback that already landed on an
  // EARLIER message while this turn was in flight — the server has already
  // de-duplicated by turnId, so that feedback never comes back.
  it("preserves feedback that already landed on an earlier message when a later turn's postTurn fails", async () => {
    postFeedback.mockResolvedValueOnce({
      corrections: [{ span: [0, 5], original: "first", suggestion: "1st", message: "m", kind: "grammar", pattern: "p", source: "harper" }],
      upgrades: [],
      passes: { mechanical: "ok", pedagogical: "ok" },
    });
    postTurn.mockResolvedValueOnce({ coach_reply: "ok", xp: 5, sessionId: "s1", turnId: "t1" });
    postTurn.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText("first utterance"); });
    await waitFor(() => {
      expect(result.current.messages.filter((m) => m.role === "user")[0].feedback).not.toBeNull();
    });

    await act(async () => { await result.current.submitText("second utterance"); });
    await waitFor(() => expect(result.current.error).toBe("boom"));

    const userMessages = result.current.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1); // turn 2's optimistic bubble rolled back
    expect(userMessages[0].feedback.corrections).toHaveLength(1); // turn 1's feedback survived
  });

  // Coordinator fix round 1, finding 4: from turn 3 onward a bare `messages`
  // array would re-upload every prior message's `feedback` (to /turn) and
  // every prior coach message's base64 `audio` (to /feedback) on every
  // subsequent request — unbounded growth, potentially megabytes.
  it("never re-uploads a message's feedback or audio in the history sent to either endpoint", async () => {
    postFeedback.mockResolvedValue({
      corrections: [{ span: [0, 3], original: "foo", suggestion: "bar", message: "m", kind: "grammar", pattern: "p", source: "harper" }],
      upgrades: [],
      passes: { mechanical: "ok", pedagogical: "ok" },
    });
    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1", turnId: "t1", audio: "AAAA", audioFormat: "mp3" });
    // Coach message 1 carries real audio; make sure playback still resolves
    // to idle so a second turn can be submitted in this test.
    playAudio.mockImplementationOnce((_audio, opts) => {
      opts?.onEnd?.();
      return { pause: vi.fn() };
    });

    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.submitText("first"); });
    await waitFor(() => {
      expect(result.current.messages.filter((m) => m.role === "user")[0].feedback).not.toBeNull();
    });
    await act(async () => { await result.current.submitText("second"); });

    const turnHistory = postTurn.mock.calls.at(-1)[0].history;
    const feedbackHistory = postFeedback.mock.calls.at(-1)[0].history;
    for (const entry of [...turnHistory, ...feedbackHistory]) {
      expect(entry).not.toHaveProperty("feedback");
      expect(entry).not.toHaveProperty("audio");
      expect(Object.keys(entry).sort()).toEqual(["role", "text"]);
    }
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
    // Why not assert on firing (advance timers, check status)? toIdle is
    // self-guarded (`s === "speaking" ? "idle" : s`), so a stale timer firing
    // while status is "listening" is already a harmless no-op — that's exactly
    // why the old version of this test passed even with the clearTimeout call
    // deleted. And a *second* speaking turn can't expose it either: playCoach()
    // itself unconditionally does `clearTimeout(speakTimerRef.current)` before
    // arming its own timer, so turn 2 would silently cancel turn 1's stale timer
    // regardless of whether stopPlayback() ever cleared it — any two-turn
    // "does turn 1 wrongly idle turn 2" scenario is masked by that redundant
    // clear and can never fail even with the fix reverted. The only assertion
    // that actually pins the regression is a direct one: barge-in must cancel
    // the exact timer id armed for the interrupted turn.
    postTurn.mockResolvedValue({ coach_reply: "Great", xp: 8, audio: "AAAA", audioFormat: "mp3" });
    const { result } = await mounted();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      act(() => result.current.submitText("hello"));
      await waitFor(() => expect(result.current.status).toBe("speaking"));

      // Identify playCoach()'s own setTimeout call by its exact fallback delay
      // (max(4000, wordCount*450+2500) for the 1-word reply "Great" == 4000ms)
      // rather than by position, so unrelated setTimeout calls (e.g. from
      // testing-library's own waitFor polling) can't shift the wrong id in.
      const fallbackMs = Math.max(4000, "Great".split(/\s+/).length * 450 + 2500);
      const armedCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === fallbackMs);
      expect(armedCallIndex).toBeGreaterThan(-1);
      const armedTimerId = setTimeoutSpy.mock.results[armedCallIndex].value;

      act(() => result.current.interrupt());
      expect(result.current.status).toBe("listening");

      // This fails if `clearTimeout(speakTimerRef.current)` is removed from
      // stopPlayback(): barge-in must cancel the stale timer itself, not rely
      // on the status guard or a later turn to clean up after it.
      expect(clearTimeoutSpy).toHaveBeenCalledWith(armedTimerId);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
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

describe("useConversation — pause profile", () => {
  async function mountedProsody() {
    const utils = renderHook(() => useConversation());
    await waitFor(() => expect(utils.result.current.providers.tts).toBe("kokoro"));
    return utils;
  }

  /** [durationMs, dB] segments at the 10ms hop getHopMs is mocked to report. */
  function buildFrames(segments) {
    const out = [];
    for (const [ms, db] of segments) for (let i = 0; i < ms / 10; i += 1) out.push(db);
    return Float32Array.from(out);
  }

  let mic;

  beforeEach(async () => {
    mic = await import("../lib/micStream.js");
    // The module mock persists across tests; the top-level beforeEach doesn't know about it.
    mic.getMicStream.mockClear();
    mic.resetFrames.mockClear();
    mic.stopFrames.mockClear();
    mic.getFrames.mockReturnValue(new Float32Array(0));
    mic.getHopMs.mockReturnValue(10);
    mic.micNowMs.mockReturnValue(0);
  });

  it("opens capture and clears the frame buffer when listening starts", async () => {
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    expect(mic.getMicStream).toHaveBeenCalled();
    expect(mic.resetFrames).toHaveBeenCalled();
  });

  it("stays silent when the turn had fewer than three mid-phrase breaks", async () => {
    // 1s speech / 400ms silence / 1s speech -> one pause, and with the only
    // finalization at t=0 it classifies as trailing-unknown, not internal.
    mic.getFrames.mockReturnValue(buildFrames([[1000, -20], [400, -70], [1000, -20]]));
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("hello there"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toBeNull();
  });

  it("surfaces one sentence once three mid-phrase breaks are detected", async () => {
    mic.getFrames.mockReturnValue(
      buildFrames([[500, -20], [300, -70], [500, -20], [300, -70], [500, -20], [300, -70], [500, -20]]),
    );
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 5000)); // finalizations land after every pause
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that we should go"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toMatch(/broke mid-phrase 3/);
  });

  it("does not clear the frame buffer when the recognizer auto-restarts mid-turn", async () => {
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    mic.resetFrames.mockClear();
    await act(async () => { recHandlers.onEnd(); }); // silence self-termination -> restart
    expect(mic.resetFrames).not.toHaveBeenCalled();
  });

  it("stops the frame collector once the pause profile has been read, so idle time can't grow the buffer", async () => {
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("hello"));
    await act(async () => { result.current.stopListening(); });
    expect(mic.stopFrames).toHaveBeenCalled();
  });

  it("throttles the pause note to at most once per PAUSE_NOTE_TURN_INTERVAL turns", async () => {
    mic.getFrames.mockReturnValue(
      buildFrames([[500, -20], [300, -70], [500, -20], [300, -70], [500, -20], [300, -70], [500, -20]]),
    );
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 5000)); // finalizations land after every pause -> internal
    const { result } = await mountedProsody();

    // First qualifying turn: the note is shown.
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that we should go"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toMatch(/broke mid-phrase 3/);

    // A second, equally-qualifying turn immediately after: throttled to null.
    // The nagging the spec rejects is exactly this — a note on every turn.
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that we should go"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toBeNull();
  });

  it("does not surface a note when finalizations land inside the pause windows instead of after them", async () => {
    // Same contour as "surfaces one sentence..." above (three 300ms mid-phrase
    // breaks), but the finalizations land INSIDE each pause window rather than
    // after all of them — the correct behaviour reclassifies every pause as a
    // clause boundary. If micNowMs's epoch were ever wrong by a whole turn
    // (making every mark look like it landed after the contour instead), this
    // is the test that would catch it: every pause would wrongly read as
    // internal and the note would wrongly fire.
    mic.getFrames.mockReturnValue(
      buildFrames([[500, -20], [300, -70], [500, -20], [300, -70], [500, -20], [300, -70], [500, -20]]),
    );
    const insideEachPauseWindow = [650, 1450, 2250]; // midpoints of [500,800], [1300,1600], [2100,2400]
    let i = 0;
    mic.micNowMs.mockImplementation(() => insideEachPauseWindow[i++]);
    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that"));
    act(() => recHandlers.onResult("we should go"));
    await act(async () => { result.current.stopListening(); });
    expect(result.current.pauseNote).toBeNull();
  });

  it("counts only the take that was actually sent — not a re-recorded and discarded one", async () => {
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 5000)); // finalizations always land after the contour -> internal

    const { result } = await mountedProsody();

    // First take: 3 internal breaks. Never sent — the learner re-records instead.
    mic.getFrames.mockReturnValue(
      buildFrames([[500, -20], [300, -70], [500, -20], [300, -70], [500, -20], [300, -70], [500, -20]]),
    );
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that we should go"));
    await act(async () => { result.current.stopListening(); }); // -> review
    act(() => result.current.reRecord()); // discard take 1, back to listening

    // Second take: 1 internal break. This is the one actually sent.
    mic.getFrames.mockReturnValue(buildFrames([[500, -20], [300, -70], [500, -20]]));
    act(() => recHandlers.onResult("hello"));
    await act(async () => { result.current.stopListening(); }); // -> review

    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1" });
    act(() => result.current.send());
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sessionPauseCounts.internal).toBe(1));
    expect(result.current.sessionPauseCounts.total).toBe(1);
  });

  it("never counts a cancelled take, even against a later turn that was only typed", async () => {
    mic.getFrames.mockReturnValue(
      buildFrames([[500, -20], [300, -70], [500, -20], [300, -70], [500, -20], [300, -70], [500, -20]]),
    );
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 5000));

    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("I think"));
    act(() => recHandlers.onResult("that we should go"));
    await act(async () => { result.current.stopListening(); }); // -> review, 3 internal breaks pending
    act(() => result.current.cancel()); // discarded forever, never sent

    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1" });
    act(() => result.current.submitText("typed instead"));
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    expect(postTurn.mock.calls[0][0].prosody).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.sessionPauseCounts).toEqual({ total: 0, internal: 0, boundary: 0, unknown: 0 });
  });

  it("does not credit phonation for a cancelled take, only for what was actually sent", async () => {
    // Long, uniformly loud contour: a big potential phonation credit if this
    // cancelled take were wrongly counted (the bug: computePauseProfile runs
    // on every recording end, including ones the learner then discards).
    mic.getFrames.mockReturnValue(buildFrames([[5000, -20]]));
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 5000));

    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const { result } = await mountedProsody();
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("long take"));
    await act(async () => { result.current.stopListening(); }); // -> review
    act(() => result.current.cancel()); // discarded forever — must not contribute phonation

    await act(async () => { await result.current.submitText("typed instead"); });

    await waitFor(() => expect(postFeedback).toHaveBeenCalledTimes(1));
    expect(postFeedback.mock.calls[0][0].sessionPhonationMs).toBe(0);
  });

  // Numerator and denominator of the session articulation rate must come from
  // exactly the same turns. Phonation only accumulates on spoken turns, so
  // counting syllables from every turn would make one typed message inflate the
  // rate without inflating the time — the pace meter clamps to 0 and stays
  // contaminated for the rest of the session. The text path is first-class
  // here, so that is a normal session, not an edge case.
  it("counts syllables from spoken turns only, so a typed turn cannot poison the pace meter", async () => {
    mic.getFrames.mockReturnValue(buildFrames([[3000, -20]]));
    let t = 0;
    mic.micNowMs.mockImplementation(() => (t += 3000));

    postTurn.mockResolvedValue({ coach_reply: "ok", xp: 1, sessionId: "s1", turnId: "t1" });
    postFeedback.mockResolvedValue(null);

    const { result } = await mountedProsody();

    // Turn 1: spoken.
    await act(async () => { result.current.startListening(); });
    act(() => recHandlers.onResult("banana")); // 3 vowel groups: a-a-a
    await act(async () => { result.current.stopListening(); }); // -> review
    await act(async () => { result.current.send(); });
    await waitFor(() => expect(postFeedback).toHaveBeenCalledTimes(1));
    const spokenSyllables = postFeedback.mock.calls[0][0].sessionSyllables;
    expect(spokenSyllables).toBe(3);

    // Turn 2: typed. It carries no phonation, so it must contribute no
    // syllables either — the count sent is unchanged from turn 1.
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(async () => { await result.current.submitText("elephantine oratorio umbrella academia"); });
    await waitFor(() => expect(postFeedback).toHaveBeenCalledTimes(2));
    expect(postFeedback.mock.calls[1][0].sessionSyllables).toBe(spokenSyllables);
  });
});

describe("useConversation — session id handling", () => {
  it("stops re-sending a session id once the server signals it could not write to it", async () => {
    // The server deliberately echoes sessionId: null when a write failed, so the
    // client opens a fresh session next turn instead of retrying a dead one
    // forever. `null` is falsy, so `if (sessionId) ...` would silently keep the
    // old id — this pins the fix: `sessionIdRef.current = sessionId ?? null`.
    postTurn.mockResolvedValueOnce({ coach_reply: "one", xp: 1, sessionId: "s1" });
    postTurn.mockResolvedValueOnce({ coach_reply: "two", xp: 1, sessionId: null });
    postTurn.mockResolvedValueOnce({ coach_reply: "three", xp: 1, sessionId: "s3" });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.providers.tts).toBe("kokoro"));

    act(() => result.current.submitText("first"));
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(1));
    expect(postTurn.mock.calls[0][0].sessionId).toBeNull(); // nothing adopted yet
    await waitFor(() => expect(result.current.status).toBe("idle"));

    act(() => result.current.submitText("second"));
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(2));
    expect(postTurn.mock.calls[1][0].sessionId).toBe("s1"); // adopted from turn 1
    await waitFor(() => expect(result.current.status).toBe("idle"));

    act(() => result.current.submitText("third"));
    await waitFor(() => expect(postTurn).toHaveBeenCalledTimes(3));
    // Turn 2 came back with sessionId: null — the dead id must NOT still be "s1".
    expect(postTurn.mock.calls[2][0].sessionId).toBeNull();
  });
});

describe("the coach opens the session", () => {
  it("replaces the local greeting with the server's opening line", async () => {
    postTurnOpen.mockResolvedValue({
      coach_reply: "So — is a city better judged by its transport or its food?",
      sessionId: "s1",
      seedProvider: "local",
    });

    const { result } = renderHook(() => useConversation());
    await waitFor(() => {
      expect(result.current.messages[0].text).toContain("transport or its food");
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it("keeps the local greeting when the server cannot be reached", async () => {
    postTurnOpen.mockResolvedValue(null);

    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(postTurnOpen).toHaveBeenCalled());
    expect(result.current.messages[0].text).toContain("SpeakUp coach");
    expect(result.current.status).toBe("idle");
  });

  it("does not autoplay the opener", async () => {
    postTurnOpen.mockResolvedValue({
      coach_reply: "So — where do you land on it?",
      audio: "AAAA",
      audioFormat: "mp3",
      sessionId: "s1",
    });

    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.messages[0].text).toContain("where do you land"));
    expect(playAudio).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  // Blocker 1: StrictMode double-invokes the mount effect in dev. Both the
  // request and the server-side commit happen before either response comes
  // back to be discarded — the fix must stop the SECOND request from ever
  // being sent, not just discard its response.
  it("issues postTurnOpen only once even when the mount effect runs twice (StrictMode)", async () => {
    postTurnOpen.mockResolvedValue({
      coach_reply: "So — is a city better judged by its transport or its food?",
      sessionId: "s1",
      seedProvider: "local",
    });

    const { result } = renderHook(() => useConversation(), { wrapper: StrictMode });
    await waitFor(() => {
      expect(result.current.messages[0].text).toContain("transport or its food");
    });
    expect(postTurnOpen).toHaveBeenCalledTimes(1);
  });

  // Blocker 2: a slow opener racing a fast learner reply must not wipe the
  // learner's own turn out of the transcript, nor steal the session id the
  // turn already claimed.
  it("does not let a slow opener overwrite a turn the learner already sent", async () => {
    let resolveOpen;
    postTurnOpen.mockImplementation(() => new Promise((r) => { resolveOpen = r; }));
    postTurn.mockResolvedValue({ coach_reply: "Nice!", xp: 5, sessionId: "s-turn" });

    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(postTurnOpen).toHaveBeenCalled());

    // Learner sends before the opener has resolved.
    await act(async () => { await result.current.submitText("hello"); });
    await waitFor(() => expect(result.current.messages.some((m) => m.text === "hello")).toBe(true));

    // The opener finally resolves — it must not wipe the transcript or steal
    // the session id the learner's own turn already claimed.
    await act(async () => {
      resolveOpen({
        coach_reply: "So — where do you land on it?",
        sessionId: "s-open",
      });
    });

    const texts = result.current.messages.map((m) => m.text);
    expect(texts).toContain("hello");
    expect(texts).toContain("Nice!");
    expect(postTurn.mock.calls[0][0].sessionId).toBeNull(); // opener hadn't resolved yet when the turn was sent

    // The session id the turn adopted ("s-turn") must survive the opener's
    // late resolution — a next turn must still target it, not "s-open".
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(async () => { await result.current.submitText("again"); });
    expect(postTurn.mock.calls[1][0].sessionId).toBe("s-turn");
  });
});
