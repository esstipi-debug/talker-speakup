import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CONTENT = JSON.parse(
  readFileSync(new URL("./drills.v1.json", import.meta.url), "utf8"),
);

const FOCUS_ORDER = Object.freeze([
  "ih-iy",
  "ae",
  "schwa",
  "v-b",
  "dzh",
  "s-cluster",
  "ed-ending",
]);

const FOCUS_TARGETS = Object.freeze({
  "ih-iy": ["ɪ", "iː"],
  ae: ["æ"],
  schwa: ["ə"],
  "v-b": ["v", "b"],
  dzh: ["dʒ"],
  "s-cluster": ["s"],
  "ed-ending": ["t", "d", "ɪd"],
});

const FOCUS_CONTRAST = Object.freeze({
  "ih-iy": "vowel length + quality",
  ae: "absent in Spanish",
  schwa: "schwa reduction in unstressed syllables",
  "v-b": "phonemic in English, allophonic in Spanish",
  dzh: "affricate absent in Spanish",
  "s-cluster": "Spanish epenthesis (spain -> espain)",
  "ed-ending": "/t/ /d/ /ɪd/ allomorphy",
});

// `ɪd` is a two-token sequence in the espeak inventory, not a single vocab entry.
const TARGET_TOKENS = Object.freeze({ ɪd: ["ɪ", "d"] });

// Reference en-us espeak transcriptions for every keyWord actually used across
// drills.v1.json's 21 prompts. Curated by hand (espeak-ng cannot run in Node);
// PENDING VERIFICATION against the real espeak-ng backend once the sidecar
// container can be built and run (Plan 1's Docker tasks are deferred) --
// treat any failure here after that verification as a real content bug, not a
// test bug.
const IPA_LEXICON = Object.freeze({
  ship: "ʃ ɪ p",
  sheep: "ʃ iː p",
  fill: "f ɪ l",
  field: "f iː l d",
  wheat: "w iː t",
  seat: "s iː t",
  bit: "b ɪ t",
  cheap: "tʃ iː p",
  cat: "k æ t",
  sat: "s æ t",
  black: "b l æ k",
  mat: "m æ t",
  sam: "s æ m",
  had: "h æ d",
  bad: "b æ d",
  plan: "p l æ n",
  angry: "æ ŋ ɡ ɹ i",
  man: "m æ n",
  ran: "ɹ æ n",
  cab: "k æ b",
  sofa: "s oʊ f ə",
  comfortable: "k ʌ m f ɚ t ə b əl",
  camera: "k æ m ə ɹ ə",
  above: "ə b ʌ v",
  banana: "b ə n æ n ə",
  another: "ə n ʌ ð ɚ",
  problem: "p ɹ ɑː b l ə m",
  temperature: "t ɛ m p ɹ ə tʃ ɚ",
  vote: "v oʊ t",
  boat: "b oʊ t",
  van: "v æ n",
  very: "v ɛ ɹ i",
  best: "b ɛ s t",
  berries: "b ɛ ɹ i z",
  value: "v æ l j uː",
  brave: "b ɹ eɪ v",
  driver: "d ɹ aɪ v ɚ",
  bought: "b ɔː t",
  john: "dʒ ɑː n",
  judged: "dʒ ʌ dʒ d",
  large: "l ɑːɹ dʒ",
  jar: "dʒ ɑːɹ",
  manager: "m æ n ɪ dʒ ɚ",
  enjoys: "ɛ n dʒ ɔɪ z",
  job: "dʒ ɑː b",
  just: "dʒ ʌ s t",
  imagine: "ɪ m æ dʒ ɪ n",
  giant: "dʒ aɪ ə n t",
  bridge: "b ɹ ɪ dʒ",
  speaks: "s p iː k s",
  spanish: "s p æ n ɪ ʃ",
  spain: "s p eɪ n",
  spring: "s p ɹ ɪ ŋ",
  student: "s t uː d ə n t",
  studied: "s t ʌ d i d",
  strange: "s t ɹ eɪ n dʒ",
  story: "s t ɔː ɹ i",
  stop: "s t ɑː p",
  small: "s m ɔː l",
  station: "s t eɪ ʃ ə n",
  walked: "w ɔː k t",
  played: "p l eɪ d",
  wanted: "w ɑː n t ɪ d",
  asked: "æ s k t",
  answered: "æ n s ɚ d",
  decided: "d ɪ s aɪ d ɪ d",
  watched: "w ɑː tʃ t",
  closed: "k l oʊ z d",
  needed: "n iː d ɪ d",
});

const LEVELS = Object.freeze(["A2", "B1", "B2", "C1"]);

const wordsOf = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

const tokensFor = (target) => TARGET_TOKENS[target] ?? [target];

const ipaContains = (ipa, target) =>
  ` ${ipa} `.includes(` ${tokensFor(target).join(" ")} `);

// A keyWord's transcription ends in a bare /t/ or /d/ token (not preceded by /ɪ/, which
// would make it the /ɪd/ allomorph instead), or ends in the two-token /ɪ d/ sequence.
// Substring matching (`ipaContains`) cannot tell these apart because " ɪ d " trivially
// contains " d ", so this checks the actual word-final position instead.
const edEndingOf = (ipa) => {
  const tokens = ipa.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  const secondLast = tokens[tokens.length - 2];
  if (secondLast === "ɪ" && last === "d") return "ɪd";
  if (last === "t") return "t";
  if (last === "d") return "d";
  return null;
};

// A keyWord's transcription begins with /s/ immediately followed by another consonant
// (a genuine word-initial cluster), not /s/ followed by a vowel.
const CONSONANTS = new Set([
  "p", "t", "k", "m", "n", "l", "ɹ", "w", "f", "b", "d", "g", "s", "ʃ", "tʃ", "dʒ", "ŋ",
  "v", "θ", "ð", "z", "h", "j",
]);
const hasInitialSCluster = (ipa) => {
  const tokens = ipa.trim().split(/\s+/);
  return tokens[0] === "s" && tokens.length > 1 && CONSONANTS.has(tokens[1]);
};

describe("drills.v1.json — file shape", () => {
  it("declares version 1, an ISO date, and the seven frozen focus slugs", () => {
    expect(CONTENT.version).toBe(1);
    expect(CONTENT.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CONTENT.focuses).toEqual(FOCUS_ORDER);
  });

  it("gives every prompt a unique id prefixed with its own focus", () => {
    const seen = new Set();
    for (const p of CONTENT.prompts) {
      expect(CONTENT.focuses).toContain(p.focus);
      expect(p.id.startsWith(`${p.focus}-`)).toBe(true);
      expect(seen.has(p.id)).toBe(false);
      seen.add(p.id);
    }
  });

  it("gives every prompt the frozen ipaTargets and contrast for its focus", () => {
    for (const p of CONTENT.prompts) {
      expect(p.ipaTargets).toEqual(FOCUS_TARGETS[p.focus]);
      expect(p.contrast).toBe(FOCUS_CONTRAST[p.focus]);
    }
  });

  it("keeps every sentence unique, under 300 chars, at a known CEFR level", () => {
    const texts = CONTENT.prompts.map((p) => p.text);
    expect(new Set(texts).size).toBe(texts.length);
    for (const p of CONTENT.prompts) {
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.text.length).toBeLessThanOrEqual(300);
      expect(LEVELS).toContain(p.level);
    }
  });
});

describe("drills.v1.json — phoneme coverage", () => {
  it("keeps every keyWord as a real word of its own sentence", () => {
    for (const p of CONTENT.prompts) {
      const words = wordsOf(p.text);
      for (const kw of p.keyWords) {
        expect(words, `${p.id} keyWord "${kw}"`).toContain(kw.toLowerCase());
      }
    }
  });

  it("has a reference transcription for every keyWord", () => {
    for (const p of CONTENT.prompts) {
      for (const kw of p.keyWords) {
        expect(
          Object.keys(IPA_LEXICON),
          `${p.id} keyWord "${kw}"`,
        ).toContain(kw.toLowerCase());
      }
    }
  });

  it("puts every declared target phoneme in a keyWord of the same prompt", () => {
    for (const p of CONTENT.prompts) {
      for (const target of p.ipaTargets) {
        const carrier = p.keyWords.find((kw) =>
          ipaContains(IPA_LEXICON[kw.toLowerCase()] ?? "", target),
        );
        expect(
          carrier,
          `${p.id} declares "${target}" but no keyWord pronounces it`,
        ).toBeDefined();
      }
    }
  });
});

describe("drills.v1.json — set size", () => {
  it("ships at least 3 prompts for every declared focus", () => {
    for (const focus of CONTENT.focuses) {
      const n = CONTENT.prompts.filter((p) => p.focus === focus).length;
      expect(n, `prompts for focus "${focus}"`).toBeGreaterThanOrEqual(3);
    }
  });

  it("ships at least 21 prompts in total", () => {
    expect(CONTENT.prompts.length).toBeGreaterThanOrEqual(21);
  });

  it("covers /t/, /d/ and /ɪd/ in every ed-ending prompt", () => {
    const ed = CONTENT.prompts.filter((p) => p.focus === "ed-ending");
    expect(ed.length).toBeGreaterThanOrEqual(3);
    for (const p of ed) {
      for (const ending of ["t", "d", "ɪd"]) {
        const carrier = p.keyWords.find(
          (kw) => edEndingOf(IPA_LEXICON[kw.toLowerCase()] ?? "") === ending,
        );
        expect(carrier, `${p.id} is missing an -ed /${ending}/ carrier`).toBeDefined();
      }
    }
  });

  it("covers a genuine word-initial /s/ cluster in every s-cluster prompt", () => {
    const sCluster = CONTENT.prompts.filter((p) => p.focus === "s-cluster");
    expect(sCluster.length).toBeGreaterThanOrEqual(3);
    for (const p of sCluster) {
      const carrier = p.keyWords.find((kw) =>
        hasInitialSCluster(IPA_LEXICON[kw.toLowerCase()] ?? ""),
      );
      expect(carrier, `${p.id} is missing a genuine s-cluster carrier`).toBeDefined();
    }
  });
});
