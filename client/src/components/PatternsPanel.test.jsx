import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", () => ({ getPatterns: vi.fn() }));
import { getPatterns } from "../lib/api.js";
import PatternsPanel from "./PatternsPanel.jsx";

beforeEach(() => {
  getPatterns.mockReset();
});

describe("PatternsPanel", () => {
  it("renders nothing when closed, and does not fetch", () => {
    const { container } = render(<PatternsPanel open={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(getPatterns).not.toHaveBeenCalled();
  });

  it("fetches and renders rows when opened", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "grammar:x", example: "I have 30 years", frequency: 4, status: "active", probesPassed: 0, lastSeenAt: new Date().toISOString(), lastProbedAt: null },
      ],
    });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText("I have 30 years")).toBeInTheDocument());
  });

  it("never renders the raw pattern key", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "grammar:i have # years", example: "I have 30 years", frequency: 4, status: "active", probesPassed: 0, lastSeenAt: new Date().toISOString(), lastProbedAt: null },
      ],
    });
    const { container } = render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText("I have 30 years")).toBeInTheDocument());
    expect(container.textContent).not.toContain("grammar:i have # years");
  });

  it("shows status as visible text, not a title attribute", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "grammar:x", example: "I have 30 years", frequency: 4, status: "resolved", probesPassed: 3, lastSeenAt: new Date().toISOString(), lastProbedAt: new Date().toISOString() },
      ],
    });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeInTheDocument());
  });

  it("shows an empty state that does not read as failure", async () => {
    getPatterns.mockResolvedValue({ patterns: [] });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/keep talking/i)).toBeInTheDocument());
  });

  it("shows an empty state when the fetch fails too, never an error message", async () => {
    getPatterns.mockResolvedValue(null);
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/keep talking/i)).toBeInTheDocument());
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });
});
