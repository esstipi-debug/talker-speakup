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

  it("returns an empty array for clean text", async () => {
    expect(await lintUtterance("I went to the shop yesterday.")).toEqual([]);
  });

  it("does not treat the utterance as markdown", async () => {
    // Bare '#' and '*' are ordinary speech artefacts, not headings/emphasis.
    const findings = await lintUtterance("I paid # 5 for it * twice");
    for (const f of findings) expect(f.lintKind).not.toBe("Formatting");
  });

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
