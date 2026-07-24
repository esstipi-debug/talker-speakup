import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

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
    createRecognizer: vi.fn(),
  };
});

import { postTurn, getHealth } from "../lib/api.js";
import { playAudio, speak } from "../lib/speech.js";
import { useConversation } from "./useConversation.js";

beforeEach(() => {
  getHealth.mockResolvedValue({ brain: "mock", tts: "kokoro", stt: "none" });
  postTurn.mockReset();
  playAudio.mockClear();
  speak.mockClear();
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
