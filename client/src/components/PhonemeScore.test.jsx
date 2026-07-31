import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PhonemeScore from "./PhonemeScore.jsx";

const scored = [
  {
    word: "the",
    start: 0,
    end: 0.2,
    accuracy: 90,
    phones: [{ ipa: "ð", score: 95, start: 0, end: 0.2 }],
  },
  {
    word: "sheep",
    start: 0.2,
    end: 0.8,
    accuracy: 48,
    phones: [
      { ipa: "ʃ", score: 70, start: 0.2, end: 0.35 },
      { ipa: "iː", score: 31, start: 0.35, end: 0.6, substituted: "ɪ" },
    ],
  },
];

describe("PhonemeScore", () => {
  it("renders one entry per word with its accuracy", () => {
    render(<PhonemeScore words={scored} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("the")).toBeInTheDocument();
    expect(screen.getByText("sheep")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("48")).toBeInTheDocument();
  });

  it("spells out a substitution rather than showing a bare score", () => {
    render(<PhonemeScore words={scored} />);
    expect(screen.getByTitle("expected iː, heard ɪ")).toBeInTheDocument();
    expect(screen.getByTitle("expected ʃ")).toBeInTheDocument();
  });

  it("buckets chips by score band without hiding the number", () => {
    render(<PhonemeScore words={scored} />);
    // 90 -> accent band, 70 -> coach band, 31 -> red band; the number is always text.
    expect(screen.getByTitle("expected ð").className).toContain("text-accent");
    expect(screen.getByTitle("expected ʃ").className).toContain("text-coach-soft");
    expect(screen.getByTitle("expected iː, heard ɪ").className).toContain("text-red-300");
    expect(screen.getByTitle("expected iː, heard ɪ")).toHaveTextContent("31");
  });

  it("renders word chips with no phone row when the phones were stripped", () => {
    const stripped = [
      { word: "the", start: 0, end: 0.2, accuracy: 30 },
      { word: "sheep", start: 0.2, end: 0.9, accuracy: 20 },
    ];
    render(<PhonemeScore words={stripped} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.queryByTitle(/^expected /)).toBeNull();
  });

  it("renders nothing for an empty word list", () => {
    const { container } = render(<PhonemeScore words={[]} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
