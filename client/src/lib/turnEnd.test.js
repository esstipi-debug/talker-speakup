import { describe, it, expect } from "vitest";
import { silenceWindowMs, END_OF_TURN_SILENCE_MS, DANGLING_SILENCE_MS } from "./turnEnd.js";

describe("silenceWindowMs", () => {
  it("ends a turn that reads as complete after the short window", () => {
    expect(silenceWindowMs("I went to the park yesterday")).toBe(END_OF_TURN_SILENCE_MS);
  });

  it("waits longer when the words so far end on an article or a conjunction", () => {
    expect(silenceWindowMs("I went to the")).toBe(DANGLING_SILENCE_MS);
    expect(silenceWindowMs("I stayed home because")).toBe(DANGLING_SILENCE_MS);
    expect(silenceWindowMs("it was cheap and")).toBe(DANGLING_SILENCE_MS);
  });

  it("ignores case and trailing punctuation when reading the last word", () => {
    expect(silenceWindowMs("And THE")).toBe(DANGLING_SILENCE_MS);
    expect(silenceWindowMs("because...")).toBe(DANGLING_SILENCE_MS);
    expect(silenceWindowMs("We won.")).toBe(END_OF_TURN_SILENCE_MS);
  });

  it("treats a trailing comma as an unfinished phrase", () => {
    expect(silenceWindowMs("When I was a kid,")).toBe(DANGLING_SILENCE_MS);
  });

  // Words English sentences often DO end on stay on the short window — a false
  // "unfinished" only costs a wait, but these would cost it on every turn.
  it("does not stretch the wait for words that commonly end a sentence", () => {
    expect(silenceWindowMs("I think so")).toBe(END_OF_TURN_SILENCE_MS);
    expect(silenceWindowMs("I told her")).toBe(END_OF_TURN_SILENCE_MS);
    expect(silenceWindowMs("I like that")).toBe(END_OF_TURN_SILENCE_MS);
  });

  it("falls back to the short window when nothing has been heard", () => {
    expect(silenceWindowMs("")).toBe(END_OF_TURN_SILENCE_MS);
    expect(silenceWindowMs(undefined)).toBe(END_OF_TURN_SILENCE_MS);
  });

  it("uses the windows the learner chose: 2 s, or 4 s when the phrase dangles", () => {
    expect(END_OF_TURN_SILENCE_MS).toBe(2000);
    expect(DANGLING_SILENCE_MS).toBe(4000);
  });
});
