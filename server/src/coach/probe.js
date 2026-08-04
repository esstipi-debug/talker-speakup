/**
 * Pure probe-selection policy. No I/O — `candidates` is already read by the
 * caller (repo/ledger.js's getProbeCandidates, unfiltered) and `turnsSoFar`
 * is already counted by the caller from the database (spec §4.1, §5.3).
 * Everything this function decides — whether to fire, which pattern, what
 * to say — is therefore testable without a database.
 */

/** UNCALIBRATED — spec §11. At most one probe every this many user turns. */
export const PROBE_TURN_INTERVAL = 3;
/** UNCALIBRATED — spec §11. Never probe on a single isolated slip. */
export const MIN_PROBE_FREQUENCY = 3;
/** UNCALIBRATED — spec §11. Rotation pool size, so one pattern can't monopolise every probe. */
export const PROBE_POOL_SIZE = 3;

/** Nulls sort as older than any real timestamp (spec §5.3: "nulls first"). */
function probedAtMs(candidate) {
  return candidate.lastProbedAt ? new Date(candidate.lastProbedAt).getTime() : -Infinity;
}

/**
 * @param {{ candidates: Array<{pattern:string, example:string, explanation:string|null, frequency:number, status:string, lastProbedAt:string|Date|null}>, turnsSoFar: number }} args
 * @returns {{ pattern: string, directive: string } | null}
 */
export function chooseProbe({ candidates, turnsSoFar }) {
  if (!turnsSoFar || turnsSoFar % PROBE_TURN_INTERVAL !== 0) return null;

  const pool = candidates
    .filter((c) => (c.status === "active" || c.status === "improving") && c.frequency >= MIN_PROBE_FREQUENCY)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, PROBE_POOL_SIZE);
  if (!pool.length) return null;

  const chosen = pool.reduce((oldest, c) => (probedAtMs(c) < probedAtMs(oldest) ? c : oldest));
  return { pattern: chosen.pattern, directive: buildDirective(chosen) };
}

/**
 * Built from `example` and `explanation` — never `pattern`, which is a
 * mangled lexical-prefix key that would tell the model nothing (spec §3.2,
 * §4.1). Starting wording (spec §12.1): iterate against real conversation.
 *
 * `type === "vocab"` candidates are upgrades — correct-but-plain language
 * the LLM pass suggested improving, never a mistake (M2's whole reason for
 * a separate upgrades channel from corrections). The directive must not
 * call it "a known mistake": conflating the two teaches the learner that
 * plain, correct English is an error, exactly what M2 exists to avoid.
 */
function buildDirective({ example, explanation, type }) {
  const why = explanation ? ` — ${explanation}` : "";
  if (type === "vocab") {
    return (
      `The learner has a piece of more natural phrasing worth reinforcing. A more idiomatic way exists ` +
      `for something like: "${example}"${why}. In your next reply, steer the conversation toward a natural ` +
      `opening where a sentence like that would come up again, so they get a chance to reach for the more ` +
      `polished phrasing. Do not mention that you are testing them — just create the opening naturally.`
    );
  }
  return (
    `The learner has a recurring pattern worth revisiting. They previously said something like: ` +
    `"${example}"${why}. In your next reply, steer the conversation toward a natural opening where a ` +
    `sentence like that would come up again, so they get a chance to try it differently. Do not mention ` +
    `that this is a known mistake or that you are testing them — just create the opening naturally.`
  );
}
