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

  it("shows its own error state when the fetch fails, distinct from the empty state", async () => {
    getPatterns.mockResolvedValue(null);
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeInTheDocument());
    expect(screen.queryByText(/keep talking/i)).not.toBeInTheDocument();
  });

  it("frames an upgrade (vocab type) as reinforcement, never as a mistake", async () => {
    getPatterns.mockResolvedValue({
      patterns: [
        { pattern: "vocab:i have a problem", type: "vocab", example: "I have a problem", frequency: 3, status: "active", probesPassed: 0, lastSeenAt: new Date().toISOString(), lastProbedAt: null },
      ],
    });
    render(<PatternsPanel open={true} />);
    await waitFor(() => expect(screen.getByText(/worth reaching for/i)).toBeInTheDocument());
    expect(screen.queryByText(/slipping/i)).not.toBeInTheDocument();
  });

  it("caps the panel's height so a long list scrolls instead of pushing the conversation off-screen", () => {
    getPatterns.mockResolvedValue({ patterns: [] });
    const { container } = render(<PatternsPanel open={true} />);
    const section = container.querySelector("section");
    expect(section.className).toMatch(/max-h-/);
    expect(section.className).toMatch(/overflow-y-auto/);
  });
});
