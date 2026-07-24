import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
