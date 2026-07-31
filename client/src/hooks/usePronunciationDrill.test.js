import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// --- steering flags, mutated per test (mirrors useConversation.test.js) ---
let micSupported = true;
let nextHandleNull = false; // force the next startRecording() -> null once
let takeResult = null; // what the next handle.stop() resolves
let lastHandle = null;
let lastStartOpts = null;

function makeHandle() {
  let state = "recording";
  lastHandle = {
    mimeType: "audio/webm",
    state: () => state,
    stop: vi.fn(async () => {
      state = "stopped";
      return takeResult;
    }),
    cancel: vi.fn(() => {
      state = "cancelled";
    }),
  };
  return lastHandle;
}

vi.mock("../lib/api.js", () => ({
  getPronPrompts: vi.fn(),
  postPronAssess: vi.fn(),
}));

vi.mock("../lib/recorder.js", async () => {
  const actual = await vi.importActual("../lib/recorder.js");
  return {
    ...actual,
    isRecordingSupported: () => micSupported,
    startRecording: async (opts) => {
      lastStartOpts = opts;
      if (nextHandleNull) {
        nextHandleNull = false;
        return null;
      }
      return makeHandle();
    },
  };
});

import { getPronPrompts, postPronAssess } from "../lib/api.js";
import { usePronunciationDrill } from "./usePronunciationDrill.js";

const PROMPTS = {
  version: 1,
  updated: "2026-07-27",
  focuses: ["ih-iy", "v-b"],
  prompts: [
    {
      id: "ih-iy-01",
      focus: "ih-iy",
      text: "The ship is full of sheep.",
      ipaTargets: ["ɪ", "iː"],
      keyWords: ["ship", "sheep"],
      contrast: "vowel length + quality",
      level: "B2",
    },
    {
      id: "v-b-01",
      focus: "v-b",
      text: "Vote for the boat.",
      ipaTargets: ["v", "b"],
      keyWords: ["vote", "boat"],
      contrast: "phonemic in English, allophonic in Spanish",
      level: "B1",
    },
  ],
};

const REPORT = {
  version: 1,
  mode: "scripted",
  pronProvider: "mock",
  model: "mock",
  overall: { accuracy: 62, fluency: 71, completeness: 100 },
  prosody: {
    speechRateWpm: 120,
    articulationRateSyllPerSec: 4,
    pauseCount: 0,
    pauseTotalSec: 0,
    f0MinHz: null,
    f0MaxHz: null,
    f0RangeSemitones: null,
  },
  words: [
    { word: "the", start: 0, end: 0.2, accuracy: 90, phones: [{ ipa: "ð", score: 90, start: 0, end: 0.2 }] },
    {
      word: "sheep",
      start: 0.2,
      end: 0.8,
      accuracy: 48,
      phones: [
        { ipa: "ʃ", score: 88, start: 0.2, end: 0.35 },
        { ipa: "iː", score: 31, start: 0.35, end: 0.6, substituted: "ɪ" },
        { ipa: "p", score: 25, start: 0.6, end: 0.8 },
      ],
    },
  ],
};

beforeEach(() => {
  micSupported = true;
  nextHandleNull = false;
  lastHandle = null;
  lastStartOpts = null;
  takeResult = { blob: new Blob(["take"]), durationMs: 1200 };
  getPronPrompts.mockReset();
  getPronPrompts.mockResolvedValue(PROMPTS);
  postPronAssess.mockReset();
  postPronAssess.mockResolvedValue(REPORT);
});

/** Mount and wait out the prompt fetch, so every test starts settled. */
async function mounted(opts) {
  const utils = renderHook(() => usePronunciationDrill(opts));
  await waitFor(() => expect(utils.result.current.status).toBe("prompt"));
  return utils;
}

describe("usePronunciationDrill — mount", () => {
  it("loads the prompt set and lands on the first prompt", async () => {
    const { result } = await mounted();
    expect(getPronPrompts).toHaveBeenCalledWith({ focus: null });
    expect(result.current.prompts).toHaveLength(2);
    expect(result.current.promptIndex).toBe(0);
    expect(result.current.prompt.text).toBe("The ship is full of sheep.");
    expect(result.current.report).toBeNull();
    expect(result.current.errors).toEqual([]);
    expect(result.current.attempts).toBe(0);
    expect(result.current.micSupported).toBe(true);
  });

  it("passes the focus filter through to the server", async () => {
    await mounted({ focus: "v-b" });
    expect(getPronPrompts).toHaveBeenCalledWith({ focus: "v-b" });
  });

  it("disables the drill with an explicit reason when there is no microphone", async () => {
    micSupported = false;
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBe(
      "No microphone available — the drill needs audio it can score.",
    );
    expect(result.current.micSupported).toBe(false);
    // It cannot fall back to typing — there is no audio to score, so it must not
    // even ask the server for prompts.
    expect(getPronPrompts).not.toHaveBeenCalled();
  });

  it("degrades to unavailable when the prompt fetch fails", async () => {
    getPronPrompts.mockRejectedValueOnce(new Error("Server error 500"));
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBe("Server error 500");
    expect(result.current.prompt).toBeNull();
  });

  it("degrades to unavailable when the server returns an empty prompt set", async () => {
    getPronPrompts.mockResolvedValueOnce({ ...PROMPTS, prompts: [] });
    const { result } = renderHook(() => usePronunciationDrill());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBe("No drill prompts are available right now.");
    expect(result.current.promptIndex).toBe(-1);
  });
});

describe("usePronunciationDrill — scoring round trip", () => {
  it("walks prompt -> recording -> scoring -> result", async () => {
    const { result } = await mounted();

    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));

    act(() => { result.current.stopRecording(); });
    await waitFor(() => expect(result.current.status).toBe("result"));

    expect(lastHandle.stop).toHaveBeenCalledTimes(1);
    expect(result.current.report.overall.accuracy).toBe(62);
    expect(result.current.pronProvider).toBe("mock");
    expect(result.current.attempts).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("sends the reference sentence of the active prompt in scripted mode", async () => {
    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => { result.current.stopRecording(); });
    await waitFor(() => expect(result.current.status).toBe("result"));

    expect(postPronAssess).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      text: "The ship is full of sheep.",
      mode: "scripted",
    });
  });

  it("exposes at most 3 errors, meaning-changing first", async () => {
    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => { result.current.stopRecording(); });
    await waitFor(() => expect(result.current.status).toBe("result"));

    expect(result.current.errors).toHaveLength(2);
    expect(result.current.errors[0]).toMatchObject({ ipa: "iː", substituted: "ɪ", impact: 2 });
    expect(result.current.errors[1]).toMatchObject({ ipa: "p", substituted: null, impact: 0 });
  });

  it("counts a second successful attempt", async () => {
    const { result } = await mounted();
    for (const _ of [0, 1]) {
      act(() => { result.current.startRecording(); });
      await waitFor(() => expect(result.current.status).toBe("recording"));
      act(() => { result.current.stopRecording(); });
      await waitFor(() => expect(result.current.status).toBe("result"));
      act(() => { result.current.retry(); });
      await waitFor(() => expect(result.current.status).toBe("prompt"));
    }
    expect(result.current.attempts).toBe(2);
    expect(result.current.report).toBeNull(); // retry clears the previous score
  });
});

/** Drive one full take and stop awaiting at `until`. */
async function take(result, until) {
  act(() => { result.current.startRecording(); });
  await waitFor(() => expect(result.current.status).toBe("recording"));
  act(() => { result.current.stopRecording(); });
  await waitFor(() => expect(result.current.status).toBe(until));
}

describe("usePronunciationDrill — degradation", () => {
  it("falls back to listen-and-repeat when the scorer is offline", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("Pronunciation scoring is offline."), { code: "PRON_UNAVAILABLE" }),
    );

    await take(result, "unavailable");

    expect(result.current.scoringUnavailable).toBe(true);
    expect(result.current.error).toBe(
      "Scoring is offline. Listen and repeat — no score this round.",
    );
    expect(result.current.report).toBeNull();
    expect(result.current.errors).toEqual([]);
    expect(result.current.attempts).toBe(0); // an unscored take is not an attempt
  });

  it("lets the learner retry straight back into the same prompt after going offline", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("offline"), { code: "PRON_UNAVAILABLE" }),
    );
    await take(result, "unavailable");

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("prompt"));
    expect(result.current.prompt.id).toBe("ih-iy-01");
    // The offline flag is sticky for the session so the UI keeps the notice.
    expect(result.current.scoringUnavailable).toBe(true);
  });

  it("recovers to a real score once the sidecar answers again", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("offline"), { code: "PRON_UNAVAILABLE" }),
    );
    await take(result, "unavailable");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("prompt"));

    await take(result, "result");
    expect(result.current.report.overall.accuracy).toBe(62);
    expect(result.current.attempts).toBe(1);
  });

  it("keeps a non-fatal scoring error on the prompt screen", async () => {
    const { result } = await mounted();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("Couldn't make out any speech in that recording."), {
        code: "NO_SPEECH",
      }),
    );

    await take(result, "prompt");

    expect(result.current.error).toBe("Couldn't make out any speech in that recording.");
    expect(result.current.scoringUnavailable).toBe(false);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("treats a hung scorer as offline once the client guard fires", async () => {
    const { result } = await mounted();
    postPronAssess.mockImplementationOnce(() => new Promise(() => {})); // never settles

    // Timer *spy*, not fake timers: mounted() already used a real-timer waitFor,
    // and this is the repo's idiom for firing a deferred callback by hand.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      act(() => { result.current.startRecording(); });
      await waitFor(() => expect(result.current.status).toBe("recording"));
      act(() => { result.current.stopRecording(); });
      await waitFor(() => expect(result.current.status).toBe("scoring"));

      const armed = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 35000);
      expect(armed).toBeDefined();
      act(() => armed[0]());

      await waitFor(() => expect(result.current.status).toBe("unavailable"));
      expect(result.current.scoringUnavailable).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("reports a refused microphone and returns to the prompt", async () => {
    const { result } = await mounted();
    nextHandleNull = true;
    act(() => { result.current.startRecording(); });
    // startRecording resolved null -> the machine bounces back without recording.
    await waitFor(() => expect(result.current.status).toBe("prompt"));
    act(() => lastStartOpts.onError("NotAllowedError"));
    expect(result.current.error).toBe("Microphone access was refused. Allow it, then try again.");
  });

  it("surfaces any other recorder error verbatim", async () => {
    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => lastStartOpts.onError("empty-recording"));
    expect(result.current.error).toBe("Recording failed (empty-recording).");
  });

  it("returns to the prompt when the recorder hands back no take", async () => {
    const { result } = await mounted();
    takeResult = null;
    await take(result, "prompt");
    expect(postPronAssess).not.toHaveBeenCalled();
  });

  it("rejects a mis-tap shorter than the minimum take", async () => {
    const { result } = await mounted();
    takeResult = { blob: new Blob(["t"]), durationMs: 120 };
    await take(result, "prompt");
    expect(result.current.error).toBe(
      "That take was too short — read the whole sentence out loud.",
    );
    expect(postPronAssess).not.toHaveBeenCalled();
  });
});

describe("usePronunciationDrill — races", () => {
  it("does not write state after unmounting mid-scoring", async () => {
    let settle;
    postPronAssess.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const errorSpy = vi.spyOn(console, "error");
    try {
      const { result, unmount } = await mounted();
      act(() => { result.current.startRecording(); });
      await waitFor(() => expect(result.current.status).toBe("recording"));
      act(() => { result.current.stopRecording(); });
      await waitFor(() => expect(result.current.status).toBe("scoring"));

      unmount();
      await act(async () => {
        settle(REPORT);
      });

      // No "state update on an unmounted component" warning, and the last
      // rendered snapshot never advanced past `scoring`.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(result.current.status).toBe("scoring");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("cancels the live recorder when the component unmounts mid-take", async () => {
    const { result, unmount } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    const handle = lastHandle;
    unmount();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it("discards a stale response when the take was cancelled and restarted", async () => {
    const slow = { ...REPORT, overall: { ...REPORT.overall, accuracy: 11 } };
    let settleSlow;
    postPronAssess.mockImplementationOnce(() => new Promise((resolve) => { settleSlow = resolve; }));

    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => { result.current.stopRecording(); });
    await waitFor(() => expect(result.current.status).toBe("scoring"));

    // A fresh take starts (attemptSeq moves) before the first response lands.
    // `scoring` blocks startRecording, so the learner reaches it via the guard-free
    // path the UI actually offers: the request is invalidated by the next attempt.
    act(() => result.current.selectPrompt("v-b-01"));
    await waitFor(() => expect(result.current.prompt.id).toBe("v-b-01"));
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));

    await act(async () => {
      settleSlow(slow);
    });

    expect(result.current.report).toBeNull(); // the stale 11 never landed
    expect(result.current.status).toBe("recording");
  });

  it("cancelRecording releases the mic and returns to the prompt", async () => {
    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    const handle = lastHandle;

    act(() => result.current.cancelRecording());

    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("prompt");
    expect(result.current.error).toBeNull();
    expect(handle.stop).not.toHaveBeenCalled();
  });

  it("cancelling while the permission prompt is open releases the late handle", async () => {
    // startRecording sets `recording` before awaiting getUserMedia, so a cancel
    // can land first. The handle must be released, not adopted.
    const { result } = await mounted();
    act(() => {
      result.current.startRecording();
      result.current.cancelRecording();
    });
    await waitFor(() => expect(result.current.status).toBe("prompt"));
    await waitFor(() => expect(lastHandle.cancel).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("prompt");
  });

  it("a second stopRecording tap during scoring is a no-op", async () => {
    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));
    act(() => {
      result.current.stopRecording();
      result.current.stopRecording();
    });
    await waitFor(() => expect(result.current.status).toBe("result"));
    expect(lastHandle.stop).toHaveBeenCalledTimes(1);
    expect(postPronAssess).toHaveBeenCalledTimes(1);
  });

  it("the recorder's own cap drives a stop through the same path", async () => {
    const { result } = await mounted();
    act(() => { result.current.startRecording(); });
    await waitFor(() => expect(result.current.status).toBe("recording"));

    act(() => { lastStartOpts.onAutoStop(); });

    await waitFor(() => expect(result.current.status).toBe("result"));
    expect(lastHandle.stop).toHaveBeenCalledTimes(1);
  });
});
