/**
 * Normalizes a finding into the ErrorLedger's upsert key.
 *
 * Two failure modes, both bugs, pulling in opposite directions:
 *   - fragmentation: "I have 30 years" and "I have 25 years" landing in
 *     separate rows, so frequency never climbs and the ledger never notices a
 *     habit;
 *   - collision: unrelated mistakes sharing a row, so the ledger reports a
 *     habit that does not exist.
 *
 * The compromise: strip everything that varies without changing the mistake
 * (case, punctuation, specific numbers, whitespace), then keep the first
 * PATTERN_TOKENS tokens of each side — the head is what carries the
 * construction, and an unbounded key would fragment on every trailing word.
 *
 * The key is the TRANSFORMATION, `span>target`, not the span alone. Keyed on
 * the span only, Harper's one-word problem texts collapsed every unrelated
 * mistake whose text happens to be "go" into a single `grammar:go` row: its
 * frequency counted several habits at once, and the one `example` the probe
 * directive is built from belonged to whichever finding wrote last. What
 * identifies a habit is what has to change about it, so both halves are in
 * the key. `>` is safe as the separator: normalization strips every
 * non-alphanumeric character, so neither half can contain one.
 *
 * What this deliberately does NOT do: merge one grammatical rule across
 * different words. `go>goes` and `have>has` stay separate rows though both
 * are third-person -s. That is spec §3.2's standing limitation — the ledger
 * is lexical, and can probe "the phrase you keep repeating", never "the
 * present simple".
 */
const PATTERN_TOKENS = 4;

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, PATTERN_TOKENS)
    .join(" ");
}

/**
 * @param {string} type   ledger family — "grammar" | "vocab" | "register" | "pronunciation"
 * @param {string} text   what the learner said (a correction's `original`)
 * @param {string} [target] what it should have been (`suggestion`, or an upgrade's `upgraded`)
 */
export function toPattern(type, text, target) {
  return `${type}:${normalize(text)}>${normalize(target)}`;
}
