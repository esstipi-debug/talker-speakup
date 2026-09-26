import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

vi.mock("./hooks/useConversation.js", () => ({ useConversation: vi.fn() }));
import { useConversation } from "./hooks/useConversation.js";
import App from "./App.jsx";

function hookState(over = {}) {
  return {
    messages: [{ role: "coach", text: "hi" }],
    status: "review",
    live: false,
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
    pause: vi.fn(),
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

  it("calls stopListening (send now) when listening", async () => {
    const state = hookState({ status: "listening", live: true });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
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

describe("App hands-free conversation", () => {
  it("offers Pause while the conversation is live, and pauses it", async () => {
    const state = hookState({ status: "listening", live: true });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pause conversation" }));
    expect(state.pause).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the mic after pausing, since the Pause button itself goes away", async () => {
    const state = hookState({ status: "listening", live: true });
    useConversation.mockReturnValue(state);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pause conversation" }));
    expect(screen.getByRole("button", { name: "Send now" })).toHaveFocus();
  });

  it("hides Pause once the conversation is not live", () => {
    useConversation.mockReturnValue(hookState({ status: "idle", live: false }));
    render(<App />);
    expect(screen.queryByRole("button", { name: "Pause conversation" })).toBeNull();
  });

  // Typing is only accepted from idle; while the loop runs it is almost never
  // idle, so an enabled box would swallow what the learner typed.
  it("disables typing while the conversation is live, and says why", () => {
    useConversation.mockReturnValue(hookState({ status: "speaking", live: true }));
    render(<App />);
    const textbox = screen.getByRole("textbox");
    expect(textbox).toBeDisabled();
    expect(textbox).toHaveAttribute("placeholder", expect.stringMatching(/pause the conversation to type/i));
  });

  it("has no axe violations while the conversation is live", async () => {
    useConversation.mockReturnValue(hookState({ status: "listening", live: true, liveTranscript: "hello" }));
    const { container } = render(<App />);
    expect(await axe(container)).toHaveNoViolations();
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
