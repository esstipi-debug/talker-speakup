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
