import { describe, it, expect, beforeAll } from "vitest";
import { setupHarper, lintUtterance, harperStatus } from "../src/feedback/harper.js";

describe("lintUtterance", () => {
  beforeAll(async () => { await setupHarper(); }, 60000);

  it("reports the linter as available after setup", () => {
    expect(harperStatus()).toBe("ok");
  });

  it("finds an agreement error and points its span at the real text", async () => {
    // "the people is very nice" (a classic dropped-agreement construction) is
    // NOT flagged by Harper 2.7.0 -- confirmed by manual probing, do not
    // re-litigate that sentence choice. "She go to school every day." is a
    // dropped third-person -s, a classic L1-Spanish transfer error, and
    // Harper does flag it (lint_kind: "Agreement").
    const text = "She go to school every day.";
    const findings = await lintUtterance(text);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      // The span must address the string we passed in, not a reparsed copy.
      expect(text.slice(f.span[0], f.span[1])).toBe(f.original);
      expect(f.source).toBe("harper");
      expect(typeof f.lintKind).toBe("string");
    }
  });

  // ASR_ARTEFACT_KINDS is a denylist of exact strings. Nothing else in this
  // suite would notice if Harper renamed its kinds in a version bump: the
  // artefact test below asserts those names are ABSENT, and a renamed kind is
  // absent too, so it would keep passing while the filter silently stopped
  // filtering and recogniser noise started spending the learner's two
  // correction slots.
  //
  // This is the canary. It pins one kind string the linter really emits, so a
  // vocabulary change fails loudly here and points at the denylist. If it goes
  // red after a Harper upgrade, re-derive ASR_ARTEFACT_KINDS before touching
  // this assertion.
  it("still emits the exact lint kind the artefact denylist is written against", async () => {
    const findings = await lintUtterance("She go to school every day.");
    expect(findings.map((f) => f.lintKind)).toContain("Agreement");
  });

  it("returns an empty array for clean text", async () => {
    expect(await lintUtterance("I went to the shop yesterday.")).toEqual([]);
  });

  // There was a "does not treat the utterance as markdown" case here asserting
  // no finding came back with lintKind "Formatting". It was unfalsifiable:
  // ASR_ARTEFACT_KINDS drops Formatting at the boundary, so the assertion held
  // whatever Harper did with '#' and '*'. The real behaviour — that those kinds
  // never escape lintUtterance — is covered by the artefact-filter test below.

  // The recogniser writes the capitalization, not the learner. Both of these
  // yield a Capitalization lint on Harper 2.7.0 (measured). Assert on the
  // KINDS that survive, never on emptiness: if Harper later starts catching
  // the real errors in these sentences, this test must keep passing.
  it("drops lint kinds that are artefacts of the recogniser, not the learner", async () => {
    const artefacts = ["Capitalization", "Punctuation", "Formatting", "Spelling", "Typo"];
    for (const text of ["yesterday I go to the cinema with my friend", "there is many peoples in the street"]) {
      const kinds = (await lintUtterance(text)).map((f) => f.lintKind);
      expect(kinds.filter((k) => artefacts.includes(k))).toEqual([]);
    }
  });
});
