import { describe, it, expect, beforeEach, vi } from "vitest";

// This file exists solely to cover the two branches of harper.js that a
// real WASM load can't exercise on demand: Harper failing to load, and a
// Harper lint with no suggestions. It mocks "harper.js" itself — the one
// file allowed to import it — rather than adding test-only seams to the
// production module. Each test resets the module registry and re-imports
// harper.js dynamically so the module-level `linter`/`status` state (and
// the mock registered for that test) start fresh.

describe("harper unavailable / fallback branches", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("harper.js");
    vi.doUnmock("harper.js/binaryInlined");
  });

  it("marks status unavailable and returns [] instead of throwing when Harper fails to load", async () => {
    vi.doMock("harper.js", () => ({
      LocalLinter: class {
        async setup() {
          throw new Error("wasm load boom");
        }
      },
      Dialect: { American: "American" },
    }));
    vi.doMock("harper.js/binaryInlined", () => ({ binaryInlined: {} }));

    const { setupHarper, harperStatus, lintUtterance } = await import(
      "../src/feedback/harper.js"
    );

    await setupHarper();

    expect(harperStatus()).toBe("unavailable");
    await expect(lintUtterance("anything")).resolves.toEqual([]);
  });

  it("falls back to an empty suggestion string when a lint has no suggestions", async () => {
    const fakeSpan = { start: 0, end: 3, free: vi.fn() };
    const fakeLint = {
      span: () => fakeSpan,
      suggestions: () => [],
      get_problem_text: () => "abc",
      message: () => "test message",
      lint_kind: () => "TestKind",
      free: vi.fn(),
    };

    vi.doMock("harper.js", () => ({
      LocalLinter: class {
        async setup() {}
        async lint() {
          return [fakeLint];
        }
      },
      Dialect: { American: "American" },
    }));
    vi.doMock("harper.js/binaryInlined", () => ({ binaryInlined: {} }));

    const { setupHarper, lintUtterance } = await import("../src/feedback/harper.js");

    await setupHarper();
    const findings = await lintUtterance("abc");

    expect(findings).toEqual([
      {
        span: [0, 3],
        original: "abc",
        suggestion: "",
        message: "test message",
        lintKind: "TestKind",
        source: "harper",
      },
    ]);
    expect(fakeSpan.free).toHaveBeenCalledTimes(1);
    expect(fakeLint.free).toHaveBeenCalledTimes(1);
  });

  it("filters out ASR-artefact lint kinds deterministically, freeing handles for the dropped ones too", async () => {
    // Deterministic counterpart to the live-Harper "drops ... artefacts"
    // test: that test depends on Harper actually emitting a Capitalization
    // lint for its fixtures, so if a future Harper stops emitting it the
    // assertion passes trivially without the filter ever running. Here the
    // lint_kind values are fully controlled, so this proves the filter
    // itself works -- against at least two different artefact kinds plus
    // one real kind that must survive.
    function makeFakeLint(kind, text) {
      const span = { start: 0, end: text.length, free: vi.fn() };
      const suggestion = { get_replacement_text: () => "", free: vi.fn() };
      return {
        span: () => span,
        suggestions: () => [suggestion],
        get_problem_text: () => text,
        message: () => `${kind} problem`,
        lint_kind: () => kind,
        free: vi.fn(),
        _span: span,
        _suggestion: suggestion,
      };
    }

    const capsLint = makeFakeLint("Capitalization", "she");
    const punctLint = makeFakeLint("Punctuation", "friend");
    const agreementLint = makeFakeLint("Agreement", "go");
    const fakeLints = [capsLint, punctLint, agreementLint];

    vi.doMock("harper.js", () => ({
      LocalLinter: class {
        async setup() {}
        async lint() {
          return fakeLints;
        }
      },
      Dialect: { American: "American" },
    }));
    vi.doMock("harper.js/binaryInlined", () => ({ binaryInlined: {} }));

    const { setupHarper, lintUtterance } = await import("../src/feedback/harper.js");

    await setupHarper();
    const findings = await lintUtterance("she go friend");

    // Only the non-artefact lint survives the filter.
    expect(findings).toHaveLength(1);
    expect(findings[0].lintKind).toBe("Agreement");
    expect(findings[0].original).toBe("go");

    // Every lint -- including the two filtered out -- was still translated
    // and its WASM handles freed. A handle dropped by the filter must not
    // leak.
    for (const lint of fakeLints) {
      expect(lint.free).toHaveBeenCalledTimes(1);
      expect(lint._span.free).toHaveBeenCalledTimes(1);
      expect(lint._suggestion.free).toHaveBeenCalledTimes(1);
    }
  });
});
