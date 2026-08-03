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
    expect(toPattern("grammar", "")).toBe("grammar:");
    expect(toPattern("grammar", "!!!")).toBe("grammar:");
  });

  it("treats null and undefined text as empty, via the nullish coalescing default", () => {
    expect(toPattern("grammar", null)).toBe("grammar:");
    expect(toPattern("grammar", undefined)).toBe("grammar:");
  });

  it("coerces numeric input to its string form", () => {
    expect(toPattern("grammar", 30)).toBe("grammar:#");
  });
});
