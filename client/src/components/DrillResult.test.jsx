import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DrillResult from "./DrillResult.jsx";

const report = {
  version: 1,
  mode: "scripted",
  pronProvider: "mock",
  model: "mock",
  overall: { accuracy: 62, fluency: 71, completeness: 100 },
  prosody: {
    speechRateWpm: 120,
    articulationRateSyllPerSec: 4,
    pauseCount: 0,
    pauseTotalSec: 0,
    f0MinHz: null,
    f0MaxHz: null,
    f0RangeSemitones: null,
  },
  words: [
    {
      word: "sheep",
      start: 0,
      end: 0.8,
      accuracy: 48,
      phones: [{ ipa: "iː", score: 31, start: 0, end: 0.4, substituted: "ɪ" }],
    },
  ],
};

const errors = [
  { word: "sheep", wordIndex: 0, phoneIndex: 0, ipa: "iː", substituted: "ɪ", score: 31, impact: 2 },
  { word: "sheep", wordIndex: 0, phoneIndex: 1, ipa: "p", substituted: null, score: 25, impact: 0 },
];

function setup(props = {}) {
  const handlers = { onRetry: vi.fn(), onNext: vi.fn() };
  render(<DrillResult report={report} errors={errors} scoringUnavailable={false} {...handlers} {...props} />);
  return handlers;
}

describe("DrillResult — scored", () => {
  it("shows the three overall scores", () => {
    setup();
    expect(screen.getByText("Accuracy").nextSibling).toHaveTextContent("62");
    expect(screen.getByText("Fluency").nextSibling).toHaveTextContent("71");
    expect(screen.getByText("Completeness").nextSibling).toHaveTextContent("100");
  });

  it("renders exactly the errors it was handed, in order, without re-ranking", () => {
    setup();
    const items = screen.getAllByRole("listitem", { name: "" }).filter((li) =>
      li.closest("ol"),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("you said /ɪ/ where /iː/ was expected");
    expect(items[1]).toHaveTextContent("/p/ came out unclear");
  });

  it("flags a meaning-changing error and leaves accent-only errors unflagged", () => {
    setup();
    expect(screen.getAllByText("changes the word")).toHaveLength(1);
  });

  it("congratulates instead of listing when there is nothing to fix", () => {
    setup({ errors: [] });
    expect(screen.getByText(/nothing to fix/i)).toBeInTheDocument();
    expect(screen.queryByText("changes the word")).toBeNull();
  });

  it("wires retry and next", async () => {
    const h = setup();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  it("renders the per-phoneme breakdown", () => {
    setup();
    expect(screen.getByTestId("phoneme-score")).toBeInTheDocument();
  });
});

describe("DrillResult — scoring unavailable", () => {
  it("shows the listen-and-repeat notice and no scores when there is no report", () => {
    render(
      <DrillResult
        report={null}
        errors={[]}
        scoringUnavailable={true}
        onRetry={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/listen-and-repeat/i);
    expect(screen.queryByText("Accuracy")).toBeNull();
    expect(screen.queryByTestId("phoneme-score")).toBeNull();
    expect(screen.queryByText("changes the word")).toBeNull();
  });

  it("still offers retry and next so the drill keeps moving", async () => {
    const h = setup({ report: null, errors: [], scoringUnavailable: true });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  it("prefers a real report over the sticky flag once scoring has recovered", () => {
    // scoringUnavailable can still be true (it is session-sticky on the hook)
    // even after a later take produced a genuine report; the report must win.
    setup({ scoringUnavailable: true });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Accuracy").nextSibling).toHaveTextContent("62");
    expect(screen.getByTestId("phoneme-score")).toBeInTheDocument();
  });
});

describe("DrillResult — no report", () => {
  it("renders nothing when there is neither a report nor an outage", () => {
    const { container } = render(
      <DrillResult report={null} errors={[]} scoringUnavailable={false} onRetry={vi.fn()} onNext={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
