import { describe, it, expect } from "vitest";
import { toPattern } from "../src/feedback/pattern.js";

describe("toPattern", () => {
  // Under-merging: the same mistake must not fragment into many ledger rows.
  it.each([
    ["I have 30 years", "I have 25 years"],
    ["I have 30 years", "i have 40 years!"],
    ["I have a problem with my computer", "I have a problem with my phone"],
    ["  the people   is  ", "The people is"],
  ])("merges %j and %j", (a, b) => {
    expect(toPattern("grammar", a)).toBe(toPattern("grammar", b));
  });

  // Over-merging: genuinely different mistakes must not collide.
  it.each([
    ["I have 30 years", "I am 30 years old"],
    ["the people is", "the news are"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(toPattern("grammar", a)).not.toBe(toPattern("grammar", b));
  });

  it("keeps the same text apart across types", () => {
    expect(toPattern("grammar", "make a party")).not.toBe(toPattern("vocab", "make a party"));
  });

  it("is prefixed by the type", () => {
    expect(toPattern("register", "very good")).toMatch(/^register:/);
  });

  it("survives empty and punctuation-only input", () => {
    expect(toPattern("grammar", "", "")).toBe("grammar:>");
    expect(toPattern("grammar", "!!!", "???")).toBe("grammar:>");
  });

  it("treats null and undefined text as empty, via the nullish coalescing default", () => {
    expect(toPattern("grammar", null, null)).toBe("grammar:>");
    expect(toPattern("grammar", undefined, undefined)).toBe("grammar:>");
  });

  it("coerces numeric input to its string form", () => {
    expect(toPattern("grammar", 30, 31)).toBe("grammar:#>#");
  });
});

/**
 * The collision the empty-ledger gate surfaced (2026-08-19): keyed on the
 * error span alone, Harper's one-word spans made `grammar:go` a catch-all for
 * every unrelated mistake whose problem text happens to be "go". The row's
 * frequency then counts several habits at once, and the single `example` the
 * probe directive is built from belongs to whichever wrote last.
 *
 * The fix keys on the transformation — span AND its correction — so what
 * identifies a habit is what has to change about it.
 */
describe("toPattern — keyed on the transformation, not the span alone", () => {
  it("separates two different mistakes that share a one-word span", () => {
    expect(toPattern("grammar", "go", "goes")).not.toBe(toPattern("grammar", "go", "went"));
  });

  it("merges the same mistake across different subjects", () => {
    // "He go to the store" and "She go to the park" both lint to span "go",
    // suggestion "goes" — one habit, one row.
    expect(toPattern("grammar", "go", "goes")).toBe(toPattern("grammar", "Go", "goes!"));
  });

  it("normalizes the target the same way it normalizes the span", () => {
    expect(toPattern("grammar", "I have 30 years", "I am 30 years old")).toBe(
      toPattern("grammar", "I have 25 years", "I am 25 years old"),
    );
  });

  it("truncates the target to the same token budget as the span", () => {
    expect(toPattern("vocab", "I have a problem with my computer", "my laptop has been acting up")).toBe(
      toPattern("vocab", "I have a problem with my phone", "my laptop has been playing up"),
    );
  });

  it("keeps a finding with no target apart from the same span with one", () => {
    expect(toPattern("grammar", "go")).not.toBe(toPattern("grammar", "go", "goes"));
  });
});
