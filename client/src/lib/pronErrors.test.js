import { describe, it, expect } from "vitest";
import { rankPronErrors, MAX_REPORTED_ERRORS, ERROR_SCORE_CEILING } from "./pronErrors.js";

/** Report builder: words is [[word, [[ipa, score, substituted?], ...]], ...]. */
function report(words) {
  return {
    version: 1,
    mode: "scripted",
    model: "mock",
    overall: { accuracy: 50, fluency: 50, completeness: 100 },
    words: words.map(([word, phones]) => ({
      word,
      start: 0,
      end: 1,
      accuracy: 50,
      phones: phones.map(([ipa, score, substituted]) => ({
        ipa,
        score,
        start: 0,
        end: 0.1,
        ...(substituted === undefined ? {} : { substituted }),
      })),
    })),
  };
}

describe("rankPronErrors — intelligibility impact", () => {
  it("ranks the ship/sheep merge above a much worse-scoring dental /t/", () => {
    // The /t/ scores 12 — far worse in magnitude — but nobody misunderstands a
    // dental /t/. The iː -> ɪ substitution turns "sheep" into "ship".
    const errors = rankPronErrors(
      report([
        ["what", [["t", 12]]],
        ["sheep", [["iː", 55, "ɪ"]]],
      ]),
    );
    expect(errors.map((e) => e.ipa)).toEqual(["iː", "t"]);
    expect(errors[0]).toMatchObject({ word: "sheep", substituted: "ɪ", impact: 2 });
    expect(errors[1]).toMatchObject({ word: "what", substituted: null, impact: 0 });
  });

  it("ranks an unrecognised substitution between meaning-changing and accent-only", () => {
    const errors = rankPronErrors(
      report([
        ["butter", [["t", 20, "ɾ"]]], // substitution, not in the meaning-changing table -> 1
        ["thing", [["θ", 50, "s"]]], // meaning-changing -> 2
        ["park", [["k", 10]]], // no substitution -> 0
      ]),
    );
    expect(errors.map((e) => e.impact)).toEqual([2, 1, 0]);
    expect(errors.map((e) => e.word)).toEqual(["thing", "butter", "park"]);
  });

  it("breaks impact ties by the lower score first", () => {
    const errors = rankPronErrors(
      report([
        ["vote", [["v", 45, "b"]]],
        ["very", [["v", 12, "b"]]],
      ]),
    );
    expect(errors.map((e) => e.word)).toEqual(["very", "vote"]);
  });

  it("ignores phones at or above the error ceiling", () => {
    const errors = rankPronErrors(
      report([["sheep", [["iː", ERROR_SCORE_CEILING, "ɪ"], ["p", ERROR_SCORE_CEILING - 1]]]]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].ipa).toBe("p");
  });

  it("carries the indices needed to point back into the report", () => {
    const errors = rankPronErrors(report([["a", [["æ", 90]]], ["judge", [["dʒ", 20, "j"]]]]));
    expect(errors[0]).toMatchObject({ wordIndex: 1, phoneIndex: 0 });
  });

  it("caps the list at 3 by default", () => {
    const errors = rankPronErrors(
      report([["x", [["t", 1], ["d", 2], ["k", 3], ["p", 4], ["b", 5]]]]),
    );
    expect(errors).toHaveLength(MAX_REPORTED_ERRORS);
    expect(errors.map((e) => e.score)).toEqual([1, 2, 3]);
  });
});

describe("rankPronErrors — degenerate input", () => {
  it("returns [] for a null or empty report", () => {
    expect(rankPronErrors(null)).toEqual([]);
    expect(rankPronErrors(undefined)).toEqual([]);
    expect(rankPronErrors({})).toEqual([]);
    expect(rankPronErrors({ words: [] })).toEqual([]);
  });

  it("returns [] for an unscripted report where every word had its phones stripped", () => {
    const stripped = {
      version: 1,
      mode: "unscripted",
      model: "mock",
      overall: { accuracy: 40, fluency: 60, completeness: 100 },
      words: [
        { word: "the", start: 0, end: 0.2, accuracy: 30 },
        { word: "sheep", start: 0.2, end: 0.9, accuracy: 20 },
      ],
    };
    expect(rankPronErrors(stripped)).toEqual([]);
  });

  it("skips phone-less words in a mixed report instead of throwing", () => {
    const mixed = report([["sheep", [["iː", 20, "ɪ"]]]]);
    mixed.words.push({ word: "quiet", start: 1, end: 2, accuracy: 10 });
    const errors = rankPronErrors(mixed);
    expect(errors).toHaveLength(1);
    expect(errors[0].word).toBe("sheep");
  });

  it("is deterministic — two runs on the same report produce the same order", () => {
    const r = report([
      ["a", [["t", 30], ["d", 30]]],
      ["b", [["k", 30]]],
    ]);
    expect(rankPronErrors(r)).toEqual(rankPronErrors(r));
    expect(rankPronErrors(r).map((e) => `${e.wordIndex}:${e.phoneIndex}`)).toEqual([
      "0:0",
      "0:1",
      "1:0",
    ]);
  });

  it("honours an explicit limit", () => {
    const errors = rankPronErrors(report([["x", [["t", 1], ["d", 2], ["k", 3]]]]), { limit: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0].ipa).toBe("t");
  });

  it("does not mutate the report it was given", () => {
    const r = report([["sheep", [["iː", 20, "ɪ"]]]]);
    const snapshot = JSON.stringify(r);
    rankPronErrors(r);
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});
