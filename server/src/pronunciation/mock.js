/**
 * Deterministic scorer. Exists so the server suite never needs Docker, and so
 * the client can be developed against a stable payload shape.
 *
 * The phone labels carry ARPAbet stress digits because that is precisely what
 * english_us_arpa gives us for free and what M-LEX/M3 read (spec §5.1).
 */

const PHONES_PER_SYLLABLE = 3;
const MS_PER_PHONE = 80;

export class MockPronunciation {
  async score(_pcm, referenceText) {
    const words = String(referenceText).trim().split(/\s+/).filter(Boolean);
    let cursor = 0;
    return {
      scored: true,
      provider: "mock",
      referenceText,
      words: words.map((word, wordIndex) => {
        const syllables = Math.max(1, Math.ceil(word.length / 3));
        const phones = [];
        for (let s = 0; s < syllables; s += 1) {
          for (let p = 0; p < PHONES_PER_SYLLABLE; p += 1) {
            phones.push({
              label: p === 1 ? `AH${s === 0 ? 1 : 0}` : "T",
              startMs: cursor,
              endMs: cursor + MS_PER_PHONE,
            });
            cursor += MS_PER_PHONE;
          }
        }
        return {
          word,
          wordIndex,
          startMs: phones[0].startMs,
          endMs: phones[phones.length - 1].endMs,
          phones,
        };
      }),
    };
  }
}
