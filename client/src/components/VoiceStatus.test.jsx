import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VoiceStatus from "./VoiceStatus.jsx";

const base = {
  status: "idle",
  liveTranscript: "",
  error: null,
  ttsFallbackActive: false,
  sttSupported: true,
  onDismissError: vi.fn(),
};

describe("VoiceStatus", () => {
  it("has a polite live region", () => {
    const { container } = render(<VoiceStatus {...base} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it("shows the live transcript while listening", () => {
    render(<VoiceStatus {...base} status="listening" liveTranscript="hello wor" />);
    expect(screen.getByText(/hello wor/)).toBeInTheDocument();
  });

  it("renders the error as an alert", () => {
    render(<VoiceStatus {...base} error="Microphone permission denied" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/permission denied/i);
  });

  it("shows the browser-voice fallback notice as an alert", () => {
    render(<VoiceStatus {...base} ttsFallbackActive />);
    expect(screen.getByRole("alert")).toHaveTextContent(/using browser voice/i);
  });

  it("warns when Web Speech is unsupported", () => {
    render(<VoiceStatus {...base} sttSupported={false} />);
    expect(screen.getByText(/chrome/i)).toBeInTheDocument();
  });

  it("does not render a 'synthesizing' state", () => {
    render(<VoiceStatus {...base} status="thinking" />);
    expect(screen.queryByText(/synthesiz/i)).toBeNull();
  });

  it("clicking the dismiss button calls onDismissError", async () => {
    const onDismissError = vi.fn();
    render(<VoiceStatus {...base} error="Microphone permission denied" onDismissError={onDismissError} />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss error/i }));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it("includes the pause note sentence inside the single polite live region", () => {
    const note = "You broke mid-phrase 3 times — let the breath land on the comma instead.";
    const { container } = render(<VoiceStatus {...base} pauseNote={note} />);
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toHaveTextContent(/broke mid-phrase 3 times/);
    // Still exactly one live region — the note must not add a second one.
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("renders nothing extra in the live region when there is no pause note", () => {
    const { container } = render(<VoiceStatus {...base} pauseNote={null} />);
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toHaveTextContent("");
  });
});
