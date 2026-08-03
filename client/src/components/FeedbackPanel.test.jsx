import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import FeedbackPanel from "./FeedbackPanel.jsx";

const base = {
  corrections: [], upgrades: [],
  hesitation: { band: "steady", basis: "audio", midPhrasePauses: 0, fillers: 0, selfRepairs: 0 },
  sessionFluency: null,
  passes: { mechanical: "ok", pedagogical: "ok" },
};

describe("FeedbackPanel", () => {
  it("renders nothing without feedback", () => {
    const { container } = render(<FeedbackPanel feedback={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a correction and its suggestion", () => {
    render(<FeedbackPanel feedback={{ ...base, corrections: [
      { span: [0, 13], original: "I have 30 years", suggestion: "I'm 30", message: "Age takes 'be'.", kind: "grammar", pattern: "p", source: "harper" },
    ] }} />);
    expect(screen.getByText(/I have 30 years/)).toBeInTheDocument();
    expect(screen.getByText(/I'm 30/)).toBeInTheDocument();
    expect(screen.getByText(/Age takes/)).toBeInTheDocument();
  });

  it("renders an upgrade", () => {
    render(<FeedbackPanel feedback={{ ...base, upgrades: [
      { original: "I have a problem", upgraded: "my laptop's been acting up", why: "More idiomatic.", pattern: "p" },
    ] }} />);
    expect(screen.getByText(/acting up/)).toBeInTheDocument();
  });

  it("says so when the pedagogical pass did not run", () => {
    render(<FeedbackPanel feedback={{ ...base, passes: { mechanical: "ok", pedagogical: "skipped" } }} />);
    expect(screen.getByText(/no api key/i)).toBeInTheDocument();
  });

  it("says so when the mechanical pass is unavailable", () => {
    render(<FeedbackPanel feedback={{ ...base, passes: { mechanical: "unavailable", pedagogical: "ok" } }} />);
    expect(screen.getByText(/grammar checker/i)).toBeInTheDocument();
  });

  it("never uses the word confidence", () => {
    const { container } = render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, band: "effortful" } }} />);
    // Check both surfaces: textContent misses words hiding in attributes
    // (title, aria-label, alt), so innerHTML is checked too — a failure here
    // tells you which surface leaked the word.
    expect(container.textContent.toLowerCase()).not.toContain("confidence");
    expect(container.innerHTML.toLowerCase()).not.toContain("confidence");
  });

  it("flags a text-only measurement basis", () => {
    render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, basis: "text-only" } }} />);
    expect(screen.getByText(/typed/i)).toBeInTheDocument();
  });

  it("renders hesitation counts as visible text", () => {
    render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, band: "some", midPhrasePauses: 3, fillers: 2, selfRepairs: 1 } }} />);
    expect(screen.getByText("Some hesitation · 3 mid-phrase pauses, 2 fillers, 1 self-repair")).toBeInTheDocument();
  });

  it("renders a count of 1 in the singular", () => {
    render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, band: "some", midPhrasePauses: 1, fillers: 1, selfRepairs: 1 } }} />);
    expect(screen.getByText(/1 mid-phrase pause,/)).toBeInTheDocument();
    expect(screen.getByText(/1 filler,/)).toBeInTheDocument();
    expect(screen.getByText(/1 self-repair$/)).toBeInTheDocument();
  });

  it("omits a zero count entirely", () => {
    render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, band: "some", midPhrasePauses: 0, fillers: 2, selfRepairs: 0 } }} />);
    expect(screen.getByText("Some hesitation · 2 fillers")).toBeInTheDocument();
  });

  it("renders the band label alone with no dangling separator when all counts are zero", () => {
    render(<FeedbackPanel feedback={{ ...base, hesitation: { ...base.hesitation, band: "steady", midPhrasePauses: 0, fillers: 0, selfRepairs: 0 } }} />);
    expect(screen.getByText("Steady delivery")).toBeInTheDocument();
  });
});
