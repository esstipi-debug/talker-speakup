/**
 * Pronunciation-assessment wire contract (design §4.3). Single owner of the
 * report shape, the input rules, and every typed error code shared by the
 * pron/ providers and the /pron routes.
 *
 * The canonical schema — reproduced verbatim so the shape lives next to the
 * validator that enforces it:
 *
 * {
 *   "$schema": "https://json-schema.org/draft/2020-12/schema",
 *   "$id": "https://speakup.local/schemas/pronunciation-report-v1.json",
 *   "title": "PronunciationReport",
 *   "type": "object",
 *   "additionalProperties": false,
 *   "required": ["version", "mode", "model", "overall", "prosody", "words"],
 *   "properties": {
 *     "version":      { "type": "integer", "const": 1 },
 *     "mode":         { "type": "string", "enum": ["scripted", "unscripted"] },
 *     "pronProvider": { "type": "string", "enum": ["local", "mock", "azure"] },
 *     "model":        { "type": "string", "minLength": 1 },
 *     "durationSec":  { "type": "number", "minimum": 0 },
 *     "sampleRate":   { "type": "integer", "const": 16000 },
 *     "overall": {
 *       "type": "object",
 *       "additionalProperties": false,
 *       "required": ["accuracy", "fluency", "completeness"],
 *       "properties": {
 *         "accuracy":     { "type": "integer", "minimum": 0, "maximum": 100 },
 *         "fluency":      { "type": "integer", "minimum": 0, "maximum": 100 },
 *         "completeness": { "type": "integer", "minimum": 0, "maximum": 100 }
 *       }
 *     },
 *     "prosody": {
 *       "type": "object",
 *       "additionalProperties": false,
 *       "required": [
 *         "speechRateWpm", "articulationRateSyllPerSec",
 *         "pauseCount", "pauseTotalSec",
 *         "f0MinHz", "f0MaxHz", "f0RangeSemitones"
 *       ],
 *       "properties": {
 *         "speechRateWpm":              { "type": "number", "minimum": 0 },
 *         "articulationRateSyllPerSec": { "type": "number", "minimum": 0 },
 *         "pauseCount":                 { "type": "integer", "minimum": 0 },
 *         "pauseTotalSec":              { "type": "number", "minimum": 0 },
 *         "f0MinHz":                    { "type": ["number", "null"], "minimum": 0 },
 *         "f0MaxHz":                    { "type": ["number", "null"], "minimum": 0 },
 *         "f0RangeSemitones":           { "type": ["number", "null"], "minimum": 0 }
 *       }
 *     },
 *     "words": {
 *       "type": "array",
 *       "minItems": 1,
 *       "items": {
 *         "type": "object",
 *         "additionalProperties": false,
 *         "required": ["word", "start", "end", "accuracy"],
 *         "properties": {
 *           "word":     { "type": "string", "minLength": 1 },
 *           "start":    { "type": "number", "minimum": 0 },
 *           "end":      { "type": "number", "minimum": 0 },
 *           "accuracy": { "type": "integer", "minimum": 0, "maximum": 100 },
 *           "phones": {
 *             "type": "array",
 *             "minItems": 1,
 *             "items": {
 *               "type": "object",
 *               "additionalProperties": false,
 *               "required": ["ipa", "score", "start", "end"],
 *               "properties": {
 *                 "ipa":         { "type": "string", "minLength": 1 },
 *                 "score":       { "type": "integer", "minimum": 0, "maximum": 100 },
 *                 "start":       { "type": "number", "minimum": 0 },
 *                 "end":         { "type": "number", "minimum": 0 },
 *                 "substituted": { "type": "string", "minLength": 1 }
 *               }
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * Invariant the schema cannot express: `substituted` is ABSENT — never null,
 * never "" — whenever the phoneme was produced as expected.
 */

/**
 * @typedef {object} PronPhone
 * @property {string} ipa
 * @property {number} score          integer 0-100
 * @property {number} start          seconds
 * @property {number} end            seconds
 * @property {string} [substituted]  ABSENT when the phone was produced as expected — never null
 */

/**
 * @typedef {object} PronWord
 * @property {string} word
 * @property {number} start
 * @property {number} end
 * @property {number} accuracy       integer 0-100
 * @property {PronPhone[]} [phones]  absent in mode "unscripted"
 */

/**
 * @typedef {object} PronOverall
 * @property {number} accuracy
 * @property {number} fluency
 * @property {number} completeness
 */

/**
 * @typedef {object} PronProsody
 * @property {number} speechRateWpm
 * @property {number} articulationRateSyllPerSec
 * @property {number} pauseCount
 * @property {number} pauseTotalSec
 * @property {number|null} f0MinHz
 * @property {number|null} f0MaxHz
 * @property {number|null} f0RangeSemitones
 */

/**
 * @typedef {object} PronunciationReport
 * @property {number} version                 always 1
 * @property {"scripted"|"unscripted"} mode
 * @property {"local"|"mock"|"azure"} [pronProvider]
 * @property {string} model
 * @property {number} [durationSec]
 * @property {number} [sampleRate]
 * @property {PronOverall} overall
 * @property {PronProsody} prosody
 * @property {PronWord[]} words
 */

export const PRON_MODES = Object.freeze(["scripted", "unscripted"]);
export const DEFAULT_MODE = "scripted";
export const MAX_TEXT_LENGTH = 300;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const REPORT_VERSION = 1;

export const PRON_ERROR_CODES = Object.freeze({
  MISSING_AUDIO: "MISSING_AUDIO",
  MISSING_TEXT: "MISSING_TEXT",
  TEXT_TOO_LONG: "TEXT_TOO_LONG",
  INVALID_MODE: "INVALID_MODE",
  AUDIO_TOO_LARGE: "AUDIO_TOO_LARGE",
  UNKNOWN_FOCUS: "UNKNOWN_FOCUS",
  NO_SPEECH: "NO_SPEECH",
  DECODE_FAILED: "DECODE_FAILED",
  UNPRONOUNCEABLE_TEXT: "UNPRONOUNCEABLE_TEXT",
  PRON_UNAVAILABLE: "PRON_UNAVAILABLE",
  BAD_REPORT: "BAD_REPORT",
});

/**
 * @param {number} value
 * @returns {number} integer in [0,100]; NaN / non-finite becomes 0
 */
export function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Validates a POST /pron/assess request body. Order matters: audio presence,
 * then audio size, then text, then mode — so a 15 MB upload with a blank
 * sentence is reported as the size problem it actually is.
 *
 * @param {{ text?: unknown, mode?: unknown, audioBytes?: unknown }} [input]
 * @returns {{ ok: true, value: { text: string, mode: "scripted"|"unscripted" } }
 *          | { ok: false, status: number, code: string, error: string }}
 */
export function validateAssessInput({ text, mode, audioBytes } = {}) {
  if (!Number.isInteger(audioBytes) || audioBytes <= 0) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.MISSING_AUDIO,
      error: 'Missing "audio" file.',
    };
  }
  if (audioBytes > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      status: 413,
      code: PRON_ERROR_CODES.AUDIO_TOO_LARGE,
      error: "That recording is too large. Keep drill takes under 15 MB.",
    };
  }
  if (typeof text !== "string" || !text.trim()) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.MISSING_TEXT,
      error: 'Missing "text" (the reference sentence, non-empty string).',
    };
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.TEXT_TOO_LONG,
      error: "That reference sentence is too long. Keep it under 300 characters.",
    };
  }
  if (mode !== undefined && !PRON_MODES.includes(mode)) {
    return {
      ok: false,
      status: 400,
      code: PRON_ERROR_CODES.INVALID_MODE,
      error: '"mode" must be "scripted" or "unscripted".',
    };
  }
  return { ok: true, value: { text: trimmed, mode: mode ?? DEFAULT_MODE } };
}

const OVERALL_KEYS = ["accuracy", "fluency", "completeness"];
const PROSODY_NUMBER_KEYS = ["speechRateWpm", "articulationRateSyllPerSec", "pauseTotalSec"];
const PROSODY_NULLABLE_KEYS = ["f0MinHz", "f0MaxHz", "f0RangeSemitones"];
const PROSODY_KEYS = [...PROSODY_NUMBER_KEYS, "pauseCount", ...PROSODY_NULLABLE_KEYS];
const WORD_KEYS = ["word", "start", "end", "accuracy", "phones"];
const PHONE_KEYS = ["ipa", "score", "start", "end", "substituted"];

function isScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fail(error) {
  return { ok: false, error };
}

function unknownKey(object, allowed, path) {
  const extra = Object.keys(object).find((key) => !allowed.includes(key));
  return extra ? `${path} has unknown key "${extra}".` : null;
}

/**
 * Structural gate on anything a provider hands back. Everything the JSON Schema
 * in this file's header states, plus the three invariants a schema cannot say:
 * `substituted` absent-not-null, `substituted !== ipa`, and no unknown keys.
 *
 * @param {unknown} report
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateReport(report) {
  if (!report || typeof report !== "object") return fail("report is not an object.");
  if (report.version !== REPORT_VERSION) {
    return fail(`report.version must be ${REPORT_VERSION}.`);
  }

  const { overall, prosody, words } = report;

  if (!overall || typeof overall !== "object") return fail("report.overall is missing.");
  for (const key of OVERALL_KEYS) {
    if (!isScore(overall[key])) return fail(`report.overall.${key} must be an integer 0-100.`);
  }
  const overallExtra = unknownKey(overall, OVERALL_KEYS, "report.overall");
  if (overallExtra) return fail(overallExtra);

  if (!prosody || typeof prosody !== "object") return fail("report.prosody is missing.");
  for (const key of PROSODY_NUMBER_KEYS) {
    if (!isNonNegativeNumber(prosody[key])) {
      return fail(`report.prosody.${key} must be a number >= 0.`);
    }
  }
  if (!Number.isInteger(prosody.pauseCount) || prosody.pauseCount < 0) {
    return fail("report.prosody.pauseCount must be an integer >= 0.");
  }
  for (const key of PROSODY_NULLABLE_KEYS) {
    if (prosody[key] !== null && !isNonNegativeNumber(prosody[key])) {
      return fail(`report.prosody.${key} must be a number >= 0 or null.`);
    }
  }
  const prosodyExtra = unknownKey(prosody, PROSODY_KEYS, "report.prosody");
  if (prosodyExtra) return fail(prosodyExtra);

  if (!Array.isArray(words) || words.length === 0) {
    return fail("report.words must be a non-empty array.");
  }

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const at = `report.words[${i}]`;
    if (!word || typeof word !== "object") return fail(`${at} is not an object.`);
    if (typeof word.word !== "string" || !word.word) {
      return fail(`${at}.word must be a non-empty string.`);
    }
    if (!isNonNegativeNumber(word.start)) return fail(`${at}.start must be a number >= 0.`);
    if (!isNonNegativeNumber(word.end) || word.end < word.start) {
      return fail(`${at}.end must be a number >= start.`);
    }
    if (!isScore(word.accuracy)) return fail(`${at}.accuracy must be an integer 0-100.`);
    const wordExtra = unknownKey(word, WORD_KEYS, at);
    if (wordExtra) return fail(wordExtra);

    if (!("phones" in word)) continue;
    if (!Array.isArray(word.phones) || word.phones.length === 0) {
      return fail(`${at}.phones must be a non-empty array.`);
    }
    for (let j = 0; j < word.phones.length; j += 1) {
      const phone = word.phones[j];
      const pAt = `${at}.phones[${j}]`;
      if (!phone || typeof phone !== "object") return fail(`${pAt} is not an object.`);
      if (typeof phone.ipa !== "string" || !phone.ipa) {
        return fail(`${pAt}.ipa must be a non-empty string.`);
      }
      if (!isScore(phone.score)) return fail(`${pAt}.score must be an integer 0-100.`);
      if (!isNonNegativeNumber(phone.start)) return fail(`${pAt}.start must be a number >= 0.`);
      if (!isNonNegativeNumber(phone.end) || phone.end < phone.start) {
        return fail(`${pAt}.end must be a number >= start.`);
      }
      if ("substituted" in phone) {
        if (typeof phone.substituted !== "string" || !phone.substituted) {
          return fail(
            `${pAt}.substituted must be a non-empty string when present — omit the key entirely when the phone was produced as expected.`,
          );
        }
        if (phone.substituted === phone.ipa) {
          return fail(`${pAt}.substituted must differ from ipa.`);
        }
      }
      const phoneExtra = unknownKey(phone, PHONE_KEYS, pAt);
      if (phoneExtra) return fail(phoneExtra);
    }
  }

  return { ok: true };
}

/**
 * Enforces design §3 — unscripted mode never carries phonemes. Returns a new
 * report; the input is never mutated, because the same report object may be
 * logged or reused by the caller.
 *
 * @param {PronunciationReport} report
 * @returns {PronunciationReport}
 */
export function stripPhones(report) {
  return {
    ...report,
    words: report.words.map((word) => {
      const copy = { ...word };
      delete copy.phones;
      return copy;
    }),
  };
}
