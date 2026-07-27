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
