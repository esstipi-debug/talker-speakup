import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./hooks/useConversation.js", () => ({ useConversation: vi.fn() }));
import { useConversation } from "./hooks/useConversation.js";
import App from "./App.jsx";

function hookState(over = {}) {
  return {
    messages: [{ role: "coach", text: "hi" }],
    status: "review",
    draft: "x",
    interim: "",
    liveTranscript: "",
    totalXp: 0,
    error: null,
    providers: { brain: "mock", tts: "kokoro", stt: "none" },
    ttsFallbackActive: false,
    sttSupported: true,
    turns: 0,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    editDraft: vi.fn(),
    send: vi.fn(),
    reRecord: vi.fn(),
    cancel: vi.fn(),
    interrupt: vi.fn(),
    submitText: vi.fn(),
    replay: vi.fn(),
    clearError: vi.fn(),
    ...over,
  };
}

describe("App focus management", () => {
  it("returns focus to the mic button when leaving review", () => {
    useConversation.mockReturnValue(hookState({ status: "review" }));
    const { rerender } = render(<App />);
    useConversation.mockReturnValue(hookState({ status: "idle" }));
    rerender(<App />);
    expect(screen.getByRole("button", { name: "Tap to speak" })).toHaveFocus();
  });
});

describe("App handleMicClick routing", () => {
  it("calls startListening when idle", async () => {
    const state = hookState({ status: "idle" });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Tap to speak" }));
    expect(state.startListening).toHaveBeenCalledTimes(1);
    expect(state.stopListening).not.toHaveBeenCalled();
    expect(state.interrupt).not.toHaveBeenCalled();
  });

  it("calls stopListening when listening", async () => {
    const state = hookState({ status: "listening" });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(state.stopListening).toHaveBeenCalledTimes(1);
    expect(state.startListening).not.toHaveBeenCalled();
  });

  it("calls interrupt when speaking", async () => {
    const state = hookState({ status: "speaking" });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Interrupt coach and speak" }));
    expect(state.interrupt).toHaveBeenCalledTimes(1);
  });
});

describe("App text submit", () => {
  it("calls submitText with the trimmed text when idle", async () => {
    const state = hookState({ status: "idle" });
    useConversation.mockReturnValue(state);
    render(<App />);
    const textbox = screen.getByRole("textbox");
    await userEvent.type(textbox, "hello coach");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.submitText).toHaveBeenCalledWith("hello coach");
  });

  it("does not call submitText when the input is blank", async () => {
    const state = hookState({ status: "idle" });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.submitText).not.toHaveBeenCalled();
  });

  it("does not call submitText when status is not idle", () => {
    const state = hookState({ status: "thinking" });
    useConversation.mockReturnValue(state);
    const { container } = render(<App />);
    fireEvent.submit(container.querySelector("form"));
    expect(state.submitText).not.toHaveBeenCalled();
  });
});

describe("App replay gating", () => {
  it("renders a replay button for a coach message when idle", () => {
    useConversation.mockReturnValue(
      hookState({ status: "idle", messages: [{ role: "coach", text: "hi there" }] }),
    );
    render(<App />);
    expect(screen.getByTitle(/play again/i)).toBeInTheDocument();
  });

  it("hides the replay button for a coach message when speaking", () => {
    useConversation.mockReturnValue(
      hookState({ status: "speaking", messages: [{ role: "coach", text: "hi there" }] }),
    );
    render(<App />);
    expect(screen.queryByTitle(/play again/i)).toBeNull();
  });
});
