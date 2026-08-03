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

/**
 * Lint kinds that are artefacts of the pipeline, not of the learner.
 *
 * The transcript's capitalization and punctuation are authored by the speech
 * recogniser, so flagging them corrects the ASR engine and spends one of the
 * learner's two correction slots on noise. Measured on Harper 2.7.0: two of
 * its five hits across a 12-sentence Spanish-speaker sample were
 * Capitalization. Spelling and Typo go for the same reason — you cannot
 * misspell out loud.
 */
const ASR_ARTEFACT_KINDS = new Set(["Capitalization", "Punctuation", "Formatting", "Spelling", "Typo"]);

export async function lintUtterance(text) {
  if (!linter) return [];
  // language:'plaintext' is mandatory. Harper defaults to markdown, which
  // would parse spoken '#' and '*' as markup.
  const lints = await linter.lint(text, { language: "plaintext", dedup: true });
  try {
    return lints.map((lint) => translate(lint)).filter((f) => !ASR_ARTEFACT_KINDS.has(f.lintKind));
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
