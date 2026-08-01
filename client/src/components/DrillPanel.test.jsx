import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../hooks/usePronunciationDrill.js", () => ({ usePronunciationDrill: vi.fn() }));
import { usePronunciationDrill } from "../hooks/usePronunciationDrill.js";
import DrillPanel from "./DrillPanel.jsx";

const prompt = {
  id: "ih-iy-01",
  focus: "ih-iy",
  text: "The ship is full of sheep.",
  ipaTargets: ["ɪ", "iː"],
  keyWords: ["ship", "sheep"],
  contrast: "vowel length + quality",
  level: "B2",
};

const report = {
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
    { word: "sheep", start: 0, end: 0.8, accuracy: 48, phones: [{ ipa: "iː", score: 31, start: 0, end: 0.4 }] },
  ],
};

function drillState(over = {}) {
  return {
    status: "prompt",
    prompt,
    prompts: [prompt],
    promptIndex: 0,
    report: null,
    errors: [],
    error: null,
    micSupported: true,
    scoringUnavailable: false,
    pronProvider: null,
    attempts: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    retry: vi.fn(),
    nextPrompt: vi.fn(),
    selectPrompt: vi.fn(),
    clearError: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  usePronunciationDrill.mockReset();
});

describe("DrillPanel — state routing", () => {
  it("shows a loading line while the prompt set is in flight", () => {
    usePronunciationDrill.mockReturnValue(drillState({ status: "loading", prompt: null, prompts: [] }));
    render(<DrillPanel />);
    expect(screen.getByText(/loading drills/i)).toBeInTheDocument();
  });

  it("renders the card on the prompt screen and wires the capture callbacks", async () => {
    const state = drillState();
    usePronunciationDrill.mockReturnValue(state);
    render(<DrillPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Record your take" }));
    expect(state.startRecording).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("The ship is full of sheep.");
  });

  it("renders the result once a take has been scored", () => {
    usePronunciationDrill.mockReturnValue(
      drillState({
        status: "result",
        report,
        errors: [
          { word: "sheep", wordIndex: 0, phoneIndex: 0, ipa: "iː", substituted: "ɪ", score: 31, impact: 2 },
        ],
        pronProvider: "mock",
        attempts: 1,
      }),
    );
    render(<DrillPanel />);
    expect(screen.getByText("Accuracy")).toBeInTheDocument();
    expect(screen.getByText("changes the word")).toBeInTheDocument();
    expect(screen.getByText(/attempts this session: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/scorer: mock/i)).toBeInTheDocument();
  });

  it("shows the listen-and-repeat result when scoring went offline", () => {
    usePronunciationDrill.mockReturnValue(
      drillState({ status: "unavailable", scoringUnavailable: true, error: "Scoring is offline." }),
    );
    render(<DrillPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/listen-and-repeat/i);
    expect(screen.getByRole("button", { name: "Next sentence" })).toBeInTheDocument();
  });

  it("shows only the reason when the drill is unavailable and has no prompt", () => {
    usePronunciationDrill.mockReturnValue(
      drillState({
        status: "unavailable",
        prompt: null,
        prompts: [],
        micSupported: false,
        error: "No microphone available — the drill needs audio it can score.",
      }),
    );
    render(<DrillPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/no microphone available/i);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("surfaces a transient error above the card and lets it be dismissed", async () => {
    const state = drillState({ error: "Couldn't make out any speech in that recording." });
    usePronunciationDrill.mockReturnValue(state);
    render(<DrillPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't make out any speech/i);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(state.clearError).toHaveBeenCalledTimes(1);
  });

  it("passes its focus prop straight to the hook", () => {
    usePronunciationDrill.mockReturnValue(drillState());
    render(<DrillPanel focus="v-b" />);
    expect(usePronunciationDrill).toHaveBeenCalledWith({ focus: "v-b" });
  });
});
