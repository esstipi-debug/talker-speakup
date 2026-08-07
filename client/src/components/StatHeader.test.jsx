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
