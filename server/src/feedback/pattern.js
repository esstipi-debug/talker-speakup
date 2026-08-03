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
 * PATTERN_TOKENS tokens — the head of an utterance is what carries the
 * construction, and an unbounded key would fragment on every trailing word.
 */
const PATTERN_TOKENS = 4;

export function toPattern(type, text) {
  const key = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, PATTERN_TOKENS)
    .join(" ");
  return `${type}:${key}`;
}
