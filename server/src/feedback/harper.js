import { LocalLinter, Dialect } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";

/**
 * The ONLY file allowed to import harper.js — same boundary micStream.js holds
 * for Web Audio. Harper's own types (Lint, Span, Suggestion) never escape this
 * module; they are translated to the project's Finding shape at the border.
 *
 * The binary is the inlined build: it carries the WASM as a data URL, so there
 * is no asset path to resolve and nothing for a bundler to lose.
 */
let linter = null;
let status = "unavailable";

export async function setupHarper() {
  if (linter) return;
  try {
    const candidate = new LocalLinter({ binary: binaryInlined, dialect: Dialect.American });
    // Load the WASM now, at boot — never lazily, or the learner's first turn
    // pays for it.
    await candidate.setup();
    linter = candidate;
    status = "ok";
  } catch (err) {
    console.warn("[feedback] Harper failed to load — mechanical pass unavailable:", err.message);
    status = "unavailable";
  }
}

export function harperStatus() {
  return status;
}

export async function lintUtterance(text) {
  if (!linter) return [];
  // language:'plaintext' is mandatory. Harper defaults to markdown, which
  // would parse spoken '#' and '*' as markup.
  const lints = await linter.lint(text, { language: "plaintext", dedup: true });
  try {
    return lints.map((lint) => translate(lint));
  } finally {
    // Lints are WASM handles. This process is long-lived.
    for (const lint of lints) lint.free();
  }
}

function translate(lint) {
  const span = lint.span();
  const suggestions = lint.suggestions();
  try {
    return {
      span: [span.start, span.end],
      original: lint.get_problem_text(),
      suggestion: suggestions[0]?.get_replacement_text() ?? "",
      message: lint.message(),
      lintKind: lint.lint_kind(),
      source: "harper",
    };
  } finally {
    span.free();
    for (const s of suggestions) s.free();
  }
}
