import { describe, it, expect } from "vitest";
import { PROMPT_FOCUSES, listPrompts } from "./prompts.js";

const FROZEN_FOCUSES = ["ih-iy", "ae", "schwa", "v-b", "dzh", "s-cluster", "ed-ending"];
const LEVELS = ["A2", "B1", "B2", "C1"];

function tokens(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

describe("prompts — the full set", () => {
  it("exposes exactly the seven frozen focus slugs, frozen", () => {
    expect([...PROMPT_FOCUSES]).toEqual(FROZEN_FOCUSES);
    expect(Object.isFrozen(PROMPT_FOCUSES)).toBe(true);
  });

  it("returns the whole set when focus is omitted, null, or empty", () => {
    const full = listPrompts();
    expect(full.ok).toBe(true);
    expect(full.value.version).toBe(1);
    expect(full.value.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(full.value.prompts.length).toBeGreaterThanOrEqual(21);
    expect(listPrompts({ focus: null }).value.prompts).toHaveLength(full.value.prompts.length);
    expect(listPrompts({ focus: "" }).value.prompts).toHaveLength(full.value.prompts.length);
  });
});

describe("prompts — filtering", () => {
  it("returns only the requested focus but still advertises every focus", () => {
    const result = listPrompts({ focus: "v-b" });
    expect(result.ok).toBe(true);
    expect(result.value.prompts.length).toBeGreaterThanOrEqual(3);
    expect(result.value.prompts.every((p) => p.focus === "v-b")).toBe(true);
    expect(result.value.focuses).toEqual(FROZEN_FOCUSES);
  });

  it("rejects an unknown focus with a message listing the valid slugs", () => {
    expect(listPrompts({ focus: "th" })).toEqual({
      ok: false,
      status: 400,
      code: "UNKNOWN_FOCUS",
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
    });
  });

  it("rejects a repeated query param (express hands over an array)", () => {
    expect(listPrompts({ focus: ["ae", "schwa"] }).code).toBe("UNKNOWN_FOCUS");
  });
});

describe("prompts — content invariants", () => {
  const prompts = listPrompts().value.prompts;

  it("gives every focus at least three prompts", () => {
    for (const focus of FROZEN_FOCUSES) {
      expect(prompts.filter((p) => p.focus === focus).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses unique ids prefixed with their own focus", () => {
    const ids = prompts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prompt of prompts) {
      expect(prompt.id.startsWith(`${prompt.focus}-`)).toBe(true);
      expect(prompt.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("declares only known focuses and levels, with text inside the 300-char cap", () => {
    for (const prompt of prompts) {
      expect(FROZEN_FOCUSES).toContain(prompt.focus);
      expect(LEVELS).toContain(prompt.level);
      expect(prompt.text.length).toBeGreaterThan(0);
      expect(prompt.text.length).toBeLessThanOrEqual(300);
      expect(prompt.contrast.length).toBeGreaterThan(0);
    }
  });

  it("only lists keyWords that actually appear in the sentence", () => {
    for (const prompt of prompts) {
      const words = tokens(prompt.text);
      expect(prompt.keyWords.length).toBeGreaterThan(0);
      for (const keyWord of prompt.keyWords) {
        expect(words).toContain(keyWord.toLowerCase());
      }
    }
  });

  it("keeps ipaTargets free of stress marks, tie bars, separators and spaces", () => {
    for (const prompt of prompts) {
      expect(prompt.ipaTargets.length).toBeGreaterThan(0);
      for (const ipa of prompt.ipaTargets) {
        expect(ipa.length).toBeGreaterThan(0);
        expect(ipa).not.toMatch(/[ˈˌ|͡\s]/);
      }
    }
  });

  it("carries exactly the seven contract keys on every prompt", () => {
    for (const prompt of prompts) {
      expect(Object.keys(prompt).sort()).toEqual([
        "contrast",
        "focus",
        "id",
        "ipaTargets",
        "keyWords",
        "level",
        "text",
      ]);
    }
  });
});

describe("prompts — immutability of the shared set", () => {
  it("freezes every layer so a caller cannot corrupt the shared content", () => {
    const { prompts, focuses } = listPrompts().value;
    expect(Object.isFrozen(prompts)).toBe(true);
    expect(Object.isFrozen(focuses)).toBe(true);
    for (const prompt of prompts) {
      expect(Object.isFrozen(prompt)).toBe(true);
      expect(Object.isFrozen(prompt.ipaTargets)).toBe(true);
      expect(Object.isFrozen(prompt.keyWords)).toBe(true);
    }
  });

  it("throws instead of silently accepting mutation of a returned prompt", () => {
    const { prompts } = listPrompts().value;
    expect(() => {
      prompts[0].text = "corrupted";
    }).toThrow(TypeError);
    expect(() => {
      prompts.push({ id: "hack-01", focus: "ae", text: "x", ipaTargets: ["x"], keyWords: ["x"], contrast: "x", level: "A2" });
    }).toThrow(TypeError);
  });

  it("does not let a mutation attempt on one call leak into a later call", () => {
    const first = listPrompts().value.prompts;
    const originalLength = first.length;
    const originalText = first[0].text;

    try {
      first[0].text = "corrupted";
    } catch {
      // frozen — expected in strict-mode ESM
    }
    try {
      first.push({ id: "hack-02" });
    } catch {
      // frozen — expected in strict-mode ESM
    }

    const second = listPrompts().value.prompts;
    expect(second.length).toBe(originalLength);
    expect(second[0].text).toBe(originalText);
  });

  it("filtering by focus does not mutate the underlying content", () => {
    const before = listPrompts().value.prompts.length;
    listPrompts({ focus: "ae" });
    const after = listPrompts().value.prompts.length;
    expect(after).toBe(before);
  });
});
