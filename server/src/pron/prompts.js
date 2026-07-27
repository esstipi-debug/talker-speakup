import { readFileSync } from "node:fs";
import { PRON_ERROR_CODES } from "./contract.js";

/**
 * Serves the curated drill set (design §4.1, §5). Reads a versioned JSON file
 * today; becomes ledger-derived in M3/M4 with no change to the route or the
 * client contract.
 *
 * The file is read once at module load. An unreadable or malformed file is a
 * boot failure, not a per-request 500.
 */

/**
 * Recursively freezes an object/array graph so nothing downstream — a route
 * handler, a test, a future caller — can mutate the shared content loaded
 * once at module scope. Assignment or array mutation on the result throws
 * (ESM modules run in strict mode) instead of silently corrupting the set
 * for every later request.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const CONTENT = deepFreeze(
  JSON.parse(readFileSync(new URL("../content/drills.v1.json", import.meta.url), "utf8")),
);

// CONTENT.focuses is already frozen in place by deepFreeze above — no copy needed.
/** @type {readonly string[]} */
export const PROMPT_FOCUSES = CONTENT.focuses;

/**
 * @typedef {object} DrillPrompt
 * @property {string} id
 * @property {string} focus
 * @property {string} text
 * @property {string[]} ipaTargets
 * @property {string[]} keyWords
 * @property {string} contrast
 * @property {"A2"|"B1"|"B2"|"C1"} level
 */

/**
 * @typedef {object} PromptSet
 * @property {number} version
 * @property {string} updated
 * @property {string[]} focuses
 * @property {DrillPrompt[]} prompts
 */

/**
 * @param {{ focus?: string|string[]|null }} [opts]
 * @returns {{ ok: true, value: PromptSet } | { ok: false, status: number, code: string, error: string }}
 */
export function listPrompts({ focus } = {}) {
  if (focus !== undefined && focus !== null && focus !== "" && !PROMPT_FOCUSES.includes(focus)) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.UNKNOWN_FOCUS,
      error: `Unknown "focus". Valid values: ${PROMPT_FOCUSES.join(", ")}.`,
    };
  }
  // The unfiltered branch returns the shared, already-frozen CONTENT.prompts array.
  // Array.prototype.filter always allocates a new, unfrozen array, so the filtered
  // branch must freeze its own result to keep the same "mutation throws" guarantee
  // on both paths (elements are already frozen; only the wrapper array is new here).
  const prompts = focus
    ? Object.freeze(CONTENT.prompts.filter((prompt) => prompt.focus === focus))
    : CONTENT.prompts;
  return {
    ok: true,
    value: {
      version: CONTENT.version,
      updated: CONTENT.updated,
      // Always the complete list, even when the prompts are filtered — the
      // client renders the focus switcher from it.
      focuses: PROMPT_FOCUSES,
      prompts,
    },
  };
}
