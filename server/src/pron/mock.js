import { clampScore, DEFAULT_MODE } from "./contract.js";

/**
 * Offline, zero-dependency pron scorer. Deterministic: the same reference text
 * always yields the same report, so route tests and the client drill are
 * reproducible with no sidecar and no Docker.
 */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const MOCK_IPA = ["ʃ", "iː", "p", "b", "v", "æ", "ə", "dʒ", "t", "ɪ"];
const MOCK_SUBSTITUTES = { "iː": "ɪ", æ: "e", v: "b", "dʒ": "j", ə: "ʌ", ɪ: "iː" };
const SUBSTITUTION_THRESHOLD = 50; // phone score below this emits `substituted` when a mapping exists
const MAX_PHONES_PER_WORD = 6;
const PUNCTUATION = /[^\p{L}\p{N}']/gu;
const MOCK_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // the buffer is only measured, never decoded
const BLANK_WORD = "(blank)"; // placeholder when input is empty or whitespace-only; upstream route should have rejected this

/**
 * FNV-1a, 32-bit, over UTF-16 code units. Exposed so tests can pin the
 * determinism rather than trust it.
 *
 * @param {string} text
 * @returns {number} unsigned 32-bit integer
 */
export function hashText(text) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function splitWords(text) {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const cleaned = raw.map((word) => word.replace(PUNCTUATION, "")).filter(Boolean);
  // "..." strips to nothing; a report with zero words fails validateReport, so
  // keep the raw tokens instead of emitting an invalid report.
  // If both are empty (e.g., empty or whitespace-only input), return a placeholder.
  return cleaned.length ? cleaned : (raw.length ? raw : [BLANK_WORD]);
}

export class MockPron {
  /**
   * @param {Buffer} audioBuffer
   * @param {{ text: string, mode?: "scripted"|"unscripted", filename?: string }} [opts]
   * @returns {Promise<import("./contract.js").PronunciationReport>}
   */
  async assess(audioBuffer, { text, mode = DEFAULT_MODE, filename = "drill.webm" } = {}) {
    void filename; // the mock never reads the bytes; the name is contract parity only
    const durationSec = round3((audioBuffer?.length ?? 0) / MOCK_SAMPLE_RATE / BYTES_PER_SAMPLE);
    const words = splitWords(text);

    const grouped = words.map((word, index) => {
      const wordSeed = hashText(`${word}#${index}`);
      const count = Math.max(1, Math.min(MAX_PHONES_PER_WORD, (word.length >> 1) || 1));
      const phones = [];
      for (let j = 0; j < count; j += 1) {
        const seed = (wordSeed + j * FNV_PRIME) >>> 0;
        const ipa = MOCK_IPA[seed % MOCK_IPA.length];
        const score = clampScore(20 + (seed % 81));
        const phone = { ipa, score, start: 0, end: 0 };
        if (score < SUBSTITUTION_THRESHOLD && MOCK_SUBSTITUTES[ipa]) {
          phone.substituted = MOCK_SUBSTITUTES[ipa];
        }
        phones.push(phone);
      }
      return { word, phones };
    });

    const totalPhones = grouped.reduce((sum, group) => sum + group.phones.length, 0);
    const step = totalPhones > 0 ? durationSec / totalPhones : 0;
    let cursor = 0;
    for (const group of grouped) {
      for (const phone of group.phones) {
        phone.start = round3(cursor * step);
        phone.end = round3((cursor + 1) * step);
        cursor += 1;
      }
    }

    const reportWords = grouped.map(({ word, phones }) => ({
      word,
      start: phones[0].start,
      end: phones.at(-1).end,
      accuracy: clampScore(phones.reduce((sum, p) => sum + p.score, 0) / phones.length),
      phones,
    }));

    const weighted = grouped.reduce(
      (sum, group, index) => sum + reportWords[index].accuracy * group.phones.length,
      0,
    );
    const hash = hashText(text);

    return {
      version: 1,
      mode,
      pronProvider: "mock",
      model: "mock",
      overall: {
        accuracy: clampScore(totalPhones ? weighted / totalPhones : 0),
        fluency: clampScore(60 + (hash % 41)),
        completeness: 100,
      },
      prosody: {
        speechRateWpm: round3(90 + (hash % 80)),
        articulationRateSyllPerSec: round3(3 + ((hash >>> 8) % 25) / 10),
        pauseCount: (hash >>> 16) % 3,
        pauseTotalSec: round3(((hash >>> 20) % 15) / 10),
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: reportWords,
    };
  }

  /**
   * Always ready — there is nothing to be unavailable. Exists so every
   * provider in the pron/ slot shares the same interface (BudgetCappedPron
   * and any future caller can call `.health()` on whichever provider it
   * holds without knowing which one it is).
   *
   * @returns {Promise<{ status: "ok", model: "mock" }>}
   */
  async health() {
    return { status: "ok", model: "mock" };
  }
}
