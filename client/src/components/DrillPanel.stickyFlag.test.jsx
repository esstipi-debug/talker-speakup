import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Integration-level regression test for the sticky `scoringUnavailable` bug:
// DrillPanel/DrillResult must key off the live `status`, not the sticky flag,
// once scoring has recovered. Unlike DrillPanel.test.jsx (which mocks the hook
// entirely), this exercises the REAL usePronunciationDrill hook with a mocked
// api/recorder layer, following the mocking pattern from
// usePronunciationDrill.test.js.

let lastHandle = null;
let takeResult = null;

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
    isRecordingSupported: () => true,
    startRecording: async () => makeHandle(),
  };
});

import { getPronPrompts, postPronAssess } from "../lib/api.js";
import DrillPanel from "./DrillPanel.jsx";

const PROMPTS = {
  version: 1,
  updated: "2026-07-27",
  focuses: ["ih-iy"],
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
    {
      word: "sheep",
      start: 0.2,
      end: 0.8,
      accuracy: 48,
      phones: [{ ipa: "iː", score: 31, start: 0.35, end: 0.6, substituted: "ɪ" }],
    },
  ],
};

beforeEach(() => {
  lastHandle = null;
  takeResult = { blob: new Blob(["take"]), durationMs: 1200 };
  getPronPrompts.mockReset();
  getPronPrompts.mockResolvedValue(PROMPTS);
  postPronAssess.mockReset();
});

async function recordAndStop(user) {
  await user.click(screen.getByRole("button", { name: "Record your take" }));
  await waitFor(() => expect(lastHandle).not.toBeNull());
  await user.click(screen.getByRole("button", { name: "Stop and score" }));
}

describe("DrillPanel — sticky scoringUnavailable does not permanently hide the drill", () => {
  it("recovers to the record button, then to a real score, after an offline round", async () => {
    const user = userEvent.setup();
    postPronAssess.mockRejectedValueOnce(
      Object.assign(new Error("offline"), { code: "PRON_UNAVAILABLE" }),
    );

    render(<DrillPanel />);

    await screen.findByTestId("drill-reference");

    // 1. First take: the sidecar is down -> offline banner, no record button.
    await recordAndStop(user);
    await screen.findByRole("status");
    expect(screen.getByRole("status")).toHaveTextContent(/listen-and-repeat/i);
    expect(screen.queryByRole("button", { name: "Record your take" })).toBeNull();

    // 2. Retry must bring the drill card back, even though scoringUnavailable
    // is still sticky-true on the hook.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Record your take" });
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("The ship is full of sheep.");

    // 3. Second take: the sidecar answers for real this time.
    postPronAssess.mockResolvedValueOnce(REPORT);
    await recordAndStop(user);

    // The real scores must render, not the stale offline banner.
    await screen.findByText("Accuracy");
    expect(screen.queryByText(/listen-and-repeat/i)).toBeNull();
    expect(screen.getByText("Accuracy").closest("dl")).toHaveTextContent("62");
  });
});
