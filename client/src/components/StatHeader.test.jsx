import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StatHeader from "./StatHeader.jsx";

describe("StatHeader session fluency", () => {
  it("shows no meter at all below the phonation floor", () => {
    render(<StatHeader totalXp={0} turns={0} sessionFluency={null} />);
    expect(screen.queryByLabelText(/delivery pace/i)).toBeNull();
  });

  it("shows the meter once there is a value", () => {
    render(<StatHeader totalXp={0} turns={0} sessionFluency={72} />);
    expect(screen.getByLabelText(/delivery pace/i)).toBeInTheDocument();
  });

  it("never prints a raw score or the word fluency as a number", () => {
    const { container } = render(<StatHeader totalXp={0} turns={0} sessionFluency={72} />);
    expect(container.textContent).not.toContain("72");
  });
});

describe("StatHeader — patterns toggle", () => {
  it("renders a patterns toggle button", () => {
    render(<StatHeader onTogglePatterns={() => {}} patternsOpen={false} />);
    expect(screen.getByRole("button", { name: /patterns/i })).toBeInTheDocument();
  });

  it("calls onTogglePatterns when clicked", () => {
    const onToggle = vi.fn();
    render(<StatHeader onTogglePatterns={onToggle} patternsOpen={false} />);
    screen.getByRole("button", { name: /patterns/i }).click();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("reflects the open state via aria-pressed", () => {
    render(<StatHeader onTogglePatterns={() => {}} patternsOpen={true} />);
    expect(screen.getByRole("button", { name: /patterns/i })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the mode pill", () => {
  it("renders nothing when the server did not report a mode", () => {
    render(<StatHeader totalXp={0} turns={0} />);
    expect(screen.queryByTitle(/^mode /)).toBeNull();
  });

  it("names the effective mode", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "hybrid", degraded: false, reasons: [] }} />);
    expect(screen.getByRole("img", { name: "mode hybrid" })).toBeInTheDocument();
  });

  it("names the requested mode too when they differ by choice", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "cloud", degraded: false, reasons: [] }} />);
    expect(screen.getByRole("img", { name: "mode cloud, requested hybrid" })).toBeInTheDocument();
  });

  it("puts the degradation reason in the accessible name, not only in colour", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "cloud", degraded: true, reasons: ["tts-unreachable"] }} />);
    expect(screen.getByRole("img", { name: "mode cloud, requested hybrid, degraded: TTS unreachable" })).toBeInTheDocument();
  });

  it("spells out both reasons when both hold", () => {
    render(
      <StatHeader
        totalXp={0}
        turns={0}
        mode={{ requested: "hybrid", effective: "web", degraded: true, reasons: ["missing-mistral-key", "tts-unreachable"] }}
      />,
    );
    expect(screen.getByRole("img", { name: "mode web, requested hybrid, degraded: no Mistral API key, TTS unreachable" })).toBeInTheDocument();
  });

  it("renders an unrecognised reason verbatim rather than dropping it", () => {
    render(<StatHeader totalXp={0} turns={0} mode={{ requested: "hybrid", effective: "custom", degraded: true, reasons: ["something-new"] }} />);
    expect(screen.getByRole("img", { name: "mode custom, requested hybrid, degraded: something-new" })).toBeInTheDocument();
  });
});
