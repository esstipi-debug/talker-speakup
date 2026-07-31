import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DrillCard from "./DrillCard.jsx";

const prompt = {
  id: "ih-iy-01",
  focus: "ih-iy",
  text: "The ship is full of sheep.",
  ipaTargets: ["ɪ", "iː"],
  keyWords: ["ship", "sheep"],
  contrast: "vowel length + quality",
  level: "B2",
};

function setup(props = {}) {
  const handlers = { onStart: vi.fn(), onStop: vi.fn(), onCancel: vi.fn() };
  render(<DrillCard prompt={prompt} status="prompt" micSupported {...handlers} {...props} />);
  return handlers;
}

describe("DrillCard — prompt state", () => {
  it("shows the reference sentence, the focus badge and the contrast", () => {
    setup();
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("The ship is full of sheep.");
    expect(screen.getByTestId("drill-focus")).toHaveTextContent("ih-iy");
    expect(screen.getByText("vowel length + quality")).toBeInTheDocument();
    expect(screen.getByText("B2")).toBeInTheDocument();
  });

  it("starts a take when the record button is pressed", async () => {
    const h = setup();
    await userEvent.click(screen.getByRole("button", { name: "Record your take" }));
    expect(h.onStart).toHaveBeenCalledTimes(1);
  });

  it("offers no stop or cancel control before recording", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Stop and score" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel take" })).toBeNull();
  });
});

describe("DrillCard — recording state", () => {
  it("swaps in stop and cancel, and announces that it is recording", async () => {
    const h = setup({ status: "recording" });
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record your take" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Stop and score" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel take" }));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("DrillCard — scoring state", () => {
  it("disables the record button while a take is being scored", () => {
    setup({ status: "scoring" });
    const button = screen.getByRole("button", { name: "Scoring…" });
    expect(button).toBeDisabled();
  });

  it("falls back to the prompt layout for an unknown status", () => {
    setup({ status: "banana" });
    expect(screen.getByRole("button", { name: "Record your take" })).toBeEnabled();
  });
});

describe("DrillCard — no microphone", () => {
  it("disables the drill with an explicit reason instead of a mic button", () => {
    setup({ micSupported: false });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/needs a microphone/i);
    expect(screen.queryByTestId("drill-reference")).toBeNull();
  });
});

describe("DrillCard — missing prompt", () => {
  it("renders without a prompt and keeps the record button out of reach", () => {
    setup({ prompt: null });
    expect(screen.getByRole("button", { name: "Record your take" })).toBeDisabled();
    expect(screen.getByTestId("drill-reference")).toHaveTextContent("");
  });
});
