import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MicButton from "./MicButton.jsx";

describe("MicButton aria-label", () => {
  it("is action-oriented per state", () => {
    const { rerender } = render(<MicButton status="idle" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Tap to speak");

    rerender(<MicButton status="listening" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Stop recording");

    rerender(<MicButton status="speaking" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Interrupt coach and speak");
  });

  it("is clickable during speaking (barge-in), not disabled", () => {
    render(<MicButton status="speaking" onClick={() => {}} />);
    expect(screen.getByRole("button")).not.toBeDisabled();
  });
});
