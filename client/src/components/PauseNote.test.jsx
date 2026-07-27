import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PauseNote from "./PauseNote.jsx";

describe("PauseNote", () => {
  it("renders nothing when there is no note", () => {
    const { container } = render(<PauseNote note={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the sentence verbatim", () => {
    render(<PauseNote note="You broke mid-phrase 4 times — let the breath land on the comma instead." />);
    expect(screen.getByText(/broke mid-phrase 4 times/)).toBeInTheDocument();
  });

  it("is not a live region — VoiceStatus owns the only polite announcement", () => {
    const { container } = render(<PauseNote note="anything" />);
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});
