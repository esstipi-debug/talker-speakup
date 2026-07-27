import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import VoiceStatus from "./VoiceStatus.jsx";
import TranscriptReview from "./TranscriptReview.jsx";
import MicButton from "./MicButton.jsx";
import PauseNote from "./PauseNote.jsx";
import StatHeader from "./StatHeader.jsx";

const vs = {
  status: "idle",
  liveTranscript: "",
  error: null,
  ttsFallbackActive: false,
  sttSupported: true,
  onDismissError: vi.fn(),
};

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

  it("PauseNote has no axe violations", async () => {
    const { container } = render(
      <PauseNote note="You broke mid-phrase 4 times — let the breath land on the comma instead." />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("StatHeader has no axe violations", async () => {
    const { container } = render(
      <StatHeader totalXp={240} turns={5} brain="mistral" tts="kokoro" stt="whisper" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
