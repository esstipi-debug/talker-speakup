import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./hooks/useConversation.js", () => ({ useConversation: vi.fn() }));
// Returning a string avoids JSX inside a hoisted vi.mock factory.
vi.mock("./components/DrillPanel.jsx", () => ({
  default: function DrillPanelStub() {
    return "drill-panel-stub";
  },
}));
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

describe("App mode switch", () => {
  it("starts in conversation mode", () => {
    useConversation.mockReturnValue(hookState({ status: "idle" }));
    render(<App />);
    expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText("drill-panel-stub")).toBeNull();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("swaps the conversation surface for the drill panel", async () => {
    useConversation.mockReturnValue(hookState({ status: "idle" }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pronunciation drill" }));

    expect(screen.getByText("drill-panel-stub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pronunciation drill" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The conversation footer is gone: no mic, no text input.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
  });

  it("returns to the conversation with its messages intact", async () => {
    useConversation.mockReturnValue(
      hookState({ status: "idle", messages: [{ role: "coach", text: "hi there" }] }),
    );
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pronunciation drill" }));
    await userEvent.click(screen.getByRole("button", { name: "Conversation" }));

    expect(screen.getByText("hi there")).toBeInTheDocument();
    expect(screen.queryByText("drill-panel-stub")).toBeNull();
  });

  it("keeps the stat header visible in both modes", async () => {
    useConversation.mockReturnValue(hookState({ status: "idle", totalXp: 40 }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Pronunciation drill" }));
    expect(screen.getByText((_, element) => element?.textContent === "40 / 100 XP")).toBeInTheDocument();
  });
});
