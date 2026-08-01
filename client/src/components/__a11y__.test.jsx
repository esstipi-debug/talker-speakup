import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import VoiceStatus from "./VoiceStatus.jsx";
import TranscriptReview from "./TranscriptReview.jsx";
import MicButton from "./MicButton.jsx";
import DrillCard from "./DrillCard.jsx";
import DrillResult from "./DrillResult.jsx";
import PhonemeScore from "./PhonemeScore.jsx";

const vs = {
  status: "idle",
  liveTranscript: "",
  error: null,
  ttsFallbackActive: false,
  sttSupported: true,
  onDismissError: vi.fn(),
};

const drillPrompt = {
  id: "ih-iy-01",
  focus: "ih-iy",
  text: "The ship is full of sheep.",
  ipaTargets: ["ɪ", "iː"],
  keyWords: ["ship", "sheep"],
  contrast: "vowel length + quality",
  level: "B2",
};

const drillCard = {
  prompt: drillPrompt,
  status: "prompt",
  micSupported: true,
  onStart: vi.fn(),
  onStop: vi.fn(),
  onCancel: vi.fn(),
};

const drillWords = [
  {
    word: "sheep",
    start: 0,
    end: 0.8,
    accuracy: 48,
    phones: [
      { ipa: "ʃ", score: 88, start: 0, end: 0.3 },
      { ipa: "iː", score: 31, start: 0.3, end: 0.6, substituted: "ɪ" },
    ],
  },
];

const drillReport = {
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
  words: drillWords,
};

const drillErrors = [
  { word: "sheep", wordIndex: 0, phoneIndex: 1, ipa: "iː", substituted: "ɪ", score: 31, impact: 2 },
];

describe("accessibility", () => {
  it("VoiceStatus has no axe violations (idle)", async () => {
    const { container } = render(<VoiceStatus {...vs} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("VoiceStatus has no axe violations (error banner)", async () => {
    const { container } = render(<VoiceStatus {...vs} error="Microphone permission denied" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("TranscriptReview has no axe violations", async () => {
    const { container } = render(
      <TranscriptReview draft="hello" onEdit={vi.fn()} onSend={vi.fn()} onReRecord={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("MicButton has no axe violations (idle)", async () => {
    const { container } = render(<MicButton status="idle" onClick={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("MicButton has no axe violations (listening)", async () => {
    const { container } = render(<MicButton status="listening" onClick={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("MicButton has no axe violations (speaking, barge-in)", async () => {
    const { container } = render(<MicButton status="speaking" onClick={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("VoiceStatus has no axe violations (listening, with live transcript)", async () => {
    const { container } = render(
      <VoiceStatus {...vs} status="listening" liveTranscript="hello there" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("VoiceStatus has no axe violations (ttsFallbackActive)", async () => {
    const { container } = render(<VoiceStatus {...vs} ttsFallbackActive />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillCard has no axe violations (prompt)", async () => {
    const { container } = render(<DrillCard {...drillCard} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillCard has no axe violations (recording)", async () => {
    const { container } = render(<DrillCard {...drillCard} status="recording" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillCard has no axe violations (no microphone)", async () => {
    const { container } = render(<DrillCard {...drillCard} micSupported={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillResult has no axe violations (scored)", async () => {
    const { container } = render(
      <DrillResult
        report={drillReport}
        errors={drillErrors}
        scoringUnavailable={false}
        onRetry={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DrillResult has no axe violations (scoring unavailable)", async () => {
    const { container } = render(
      <DrillResult
        report={null}
        errors={[]}
        scoringUnavailable
        onRetry={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("PhonemeScore has no axe violations (with substitution)", async () => {
    const { container } = render(<PhonemeScore words={drillWords} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
