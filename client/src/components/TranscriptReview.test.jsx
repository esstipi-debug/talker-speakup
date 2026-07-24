import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TranscriptReview from "./TranscriptReview.jsx";

function setup(props = {}) {
  const handlers = { onEdit: vi.fn(), onSend: vi.fn(), onReRecord: vi.fn(), onCancel: vi.fn() };
  render(<TranscriptReview draft="hello world" {...handlers} {...props} />);
  return handlers;
}

describe("TranscriptReview", () => {
  it("renders the draft in an autofocused textarea", () => {
    setup();
    const ta = screen.getByRole("textbox");
    expect(ta).toHaveValue("hello world");
    expect(ta).toHaveFocus();
  });

  it("calls onEdit as the user types", async () => {
    const { onEdit } = setup({ draft: "" });
    await userEvent.type(screen.getByRole("textbox"), "hi");
    expect(onEdit).toHaveBeenCalled();
  });

  it("Enter sends, Shift+Enter does not, Esc cancels", async () => {
    const { onSend, onCancel } = setup();
    const ta = screen.getByRole("textbox");
    ta.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("Send button is disabled for an empty draft", () => {
    setup({ draft: "   " });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});
