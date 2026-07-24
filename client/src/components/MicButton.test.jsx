import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("is disabled during thinking", () => {
    render(<MicButton status="thinking" onClick={() => {}} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("fires onClick when clicked (idle)", async () => {
    const onClick = vi.fn();
    render(<MicButton status="idle" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
