import { lintUtterance, harperStatus } from "./harper.js";
import { requestUpgrades } from "./upgrades.js";
import { toPattern } from "./pattern.js";
import { computeDelivery } from "../metrics/delivery.js";
import { getFrequencies, recordFindings } from "../repo/ledger.js";

const MAX_CORRECTIONS = 2;
const MAX_UPGRADES = 1;

/**
 * Runs both passes IN SERIES (spec D8): Harper's findings go into the LLM
 * prompt so the model is not spending its budget re-reporting articles.
 * Parallelising would save microseconds and destroy the division of labour
 * that justifies having two passes.
 *
 * Never throws. Every sub-failure degrades one channel, never the response.
 */
export async function buildFeedback({ utterance, history = [], prosody = null, sessionPhonationMs = 0, sessionSyllables = 0 }) {
  let mechanical = harperStatus();
  let harperFindings = [];
  if (mechanical === "ok") {
    try {
      harperFindings = await lintUtterance(utterance);
    } catch (err) {
      console.warn("[feedback] Harper threw on this input:", err.message);
      mechanical = "failed";
    }
  }

  const llm = await requestUpgrades({ utterance, history, harperFindings });

  const corrections = [
    ...harperFindings.map((f) => ({
      span: f.span,
      original: f.original,
      suggestion: f.suggestion,
      message: f.message,
      kind: kindFor(f.lintKind),
      source: "harper",
    })),
    ...llm.extraCorrections.map((c) => ({
      span: spanOf(utterance, c.original),
      original: c.original,
      suggestion: c.suggestion,
      message: c.message,
      kind: "register",
      source: "llm",
    })),
  ].map((c) => ({ ...c, pattern: toPattern(c.kind, c.original) }));

  const upgrades = llm.upgrades.map((u) => ({ ...u, pattern: toPattern("vocab", u.original) }));

  const frequencies = await safeFrequencies([...corrections, ...upgrades].map((x) => x.pattern));
  const byFrequency = (a, b) => (frequencies.get(b.pattern) ?? 0) - (frequencies.get(a.pattern) ?? 0);
  corrections.sort(byFrequency);
  upgrades.sort(byFrequency);

  // Everything found is written, including what the cap hides. The cap limits
  // what the learner sees, not what the system knows.
  await safeRecord([
    ...corrections.map((c) => ({ pattern: c.pattern, type: c.kind, example: c.original, explanation: c.message })),
    ...upgrades.map((u) => ({ pattern: u.pattern, type: "vocab", example: u.original, explanation: u.why })),
  ]);

  const { hesitation, sessionFluency } = computeDelivery({ text: utterance, prosody, sessionPhonationMs, sessionSyllables });

  return {
    corrections: corrections.slice(0, MAX_CORRECTIONS),
    upgrades: upgrades.slice(0, MAX_UPGRADES),
    hesitation,
    sessionFluency,
    passes: { mechanical, pedagogical: llm.status },
  };
}

/**
 * Harper's documented LintKind inventory, mapped onto the ledger's types.
 * Spelling and Typo are absent on purpose: harper.js drops them at the
 * boundary as recogniser artefacts, so they never reach this function.
 */
const VOCAB_KINDS = new Set(["WordChoice", "Malapropism", "Eggcorn"]);
const REGISTER_KINDS = new Set(["Style", "Enhancement", "Redundancy", "Readability", "Regionalism"]);

function kindFor(lintKind) {
  if (VOCAB_KINDS.has(lintKind)) return "vocab";
  if (REGISTER_KINDS.has(lintKind)) return "register";
  return "grammar";
}

/** The LLM pass has no offsets; recover them from the verified quote. */
function spanOf(utterance, original) {
  const start = utterance.indexOf(original);
  return start < 0 ? null : [start, start + original.length];
}

async function safeFrequencies(patterns) {
  try {
    return await getFrequencies(patterns);
  } catch (err) {
    console.warn("[feedback] ledger read failed, falling back to discovery order:", err.message);
    return new Map();
  }
}

async function safeRecord(entries) {
  if (!entries.length) return;
  try {
    await recordFindings(entries);
  } catch (err) {
    console.warn("[feedback] ledger write failed, continuing:", err.message);
  }
}
