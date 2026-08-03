import { describe, it, expect } from "vitest";
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
