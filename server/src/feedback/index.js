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
  ]
    // A correction with no replacement renders as an arrow pointing at nothing
    // and costs one of the two rationed slots. Harper can legitimately produce
    // one (a lint with no suggestion); it carries no teaching value, so it is
    // dropped here — before the cap, so a useful finding takes the slot.
    .filter((c) => String(c.suggestion ?? "").trim())
    // The ledger KEY is deliberately decoupled from the pass that found the
    // mistake. "I have 30 years" is the same habit whether Harper flags it or
    // the LLM does; keying it by the finding pass would file one habit under
    // two rows and split its frequency. `kind` stays the display/type field.
    .map((c) => ({ ...c, pattern: toPattern("grammar", c.original) }));

  const upgrades = llm.upgrades.map((u) => ({ ...u, pattern: toPattern("vocab", u.original) }));

  const frequencies = await safeFrequencies([...corrections, ...upgrades].map((x) => x.pattern));
  const byFrequency = (a, b) => (frequencies.get(b.pattern)?.frequency ?? 0) - (frequencies.get(a.pattern)?.frequency ?? 0);
  corrections.sort(byFrequency);
  upgrades.sort(byFrequency);

  // toPattern keeps only the first few tokens, so two distinct findings in one
  // utterance can normalize to the same key. Left alone they would be upserted
  // twice in one batch — frequency +2 for a single turn, the exact inflation
  // the turnId idempotency gate exists to prevent — and render with duplicate
  // React keys. De-duplicating here, after the frequency sort and before both
  // the write and the cap, fixes all of it in one place.
  const uniqueCorrections = dedupeByPattern(corrections);
  const uniqueUpgrades = dedupeByPattern(upgrades);

  // Everything found is written, including what the cap hides. The cap limits
  // what the learner sees, not what the system knows.
  await safeRecord([
    ...uniqueCorrections.map((c) => ({ pattern: c.pattern, type: c.kind, example: c.original, explanation: c.message })),
    ...uniqueUpgrades.map((u) => ({ pattern: u.pattern, type: "vocab", example: u.original, explanation: u.why })),
  ]);

  const { hesitation, sessionFluency } = computeDelivery({ text: utterance, prosody, sessionPhonationMs, sessionSyllables });

  return {
    corrections: uniqueCorrections.slice(0, MAX_CORRECTIONS),
    upgrades: uniqueUpgrades.slice(0, MAX_UPGRADES),
    hesitation,
    sessionFluency,
    passes: { mechanical, pedagogical: llm.status },
    // M4-internal only — routes/feedback.js reads these two fields and must
    // not let them reach the HTTP response or the persisted payload.
    // `recordedPatterns` is pre-cap (everything actually written to the
    // ledger this turn, spec §5: "does that pattern appear among the new
    // findings"), unlike the capped `corrections`/`upgrades` above.
    recordedPatterns: [...uniqueCorrections, ...uniqueUpgrades].map((x) => x.pattern),
    // Plain object, not the Map `frequencies` is — JSON-safe, and this is
    // the pre-write snapshot getFrequencies read before safeRecord ran, so a
    // reader must add 1 to get the count as of *this* sighting (spec §5.2).
    frequenciesBeforeWrite: Object.fromEntries(frequencies),
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

/** First occurrence wins — the list is already ordered by what matters most. */
function dedupeByPattern(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (seen.has(x.pattern)) return false;
    seen.add(x.pattern);
    return true;
  });
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
