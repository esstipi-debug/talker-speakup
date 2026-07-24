import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import VoiceStatus from "./VoiceStatus.jsx";
import TranscriptReview from "./TranscriptReview.jsx";

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
});
