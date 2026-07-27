# Drill Content & Calibration Harness Implementation Plan (M7 · plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the curated L1-Spanish drill set, and build the offline harness that measures whether the local scorer agrees with human raters — the work that decides whether these scores may be shown at all.

**Architecture:** (a) `server/src/content/drills.v1.json`, versioned and grouped by target phoneme, with a test asserting every sentence contains the phoneme it claims. (b) `tools/calibration/`, which runs the scorer over speechocean762, reports Pearson and Spearman correlation at utterance and phoneme level, selects between candidate acoustic models, and implements spec §10's honest fallback: if correlation is weak, report substitutions and hide the numbers.

**Tech Stack:** Python 3.11, numpy, scipy (correlation), speechocean762, pytest; Vitest for the content assertions.

## Global Constraints

Every task's requirements implicitly include this section. Values are exact.

- **Repo root (a git worktree):** `C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e`
- **Branch:** `claude/pronunciation-layer-bd7af6`. Never commit to `main`.
- **Design spec:** `docs/superpowers/specs/2026-07-27-pronunciation-layer-design.md`. Read §12 (amendments) before §4 — nine approved decisions were corrected after verification.
- **Shell:** PowerShell 7. `timeout`, `2>/dev/null`, and bash `[ -f x ]` do not exist.
- **Runtime model:** `facebook/wav2vec2-lv-60-espeak-cv-ft` (392-token espeak IPA vocab, Apache-2.0). Never `mrrubino/*` (40 tokens, no `ə`/`iː`/`dʒ`), never `slplab/*` (ARPAbet, no licence), never `torchaudio.pipelines.MMS_FA` (character-level, CC-BY-NC).
- **Provider default:** `PRON_PROVIDER` unset → `mock`. `npm run dev` must work with no Docker running.
- **Ports:** server `3001`, sidecar `8899`, Kokoro TTS `8880`.
- **JS style:** ESM, double quotes, semicolons, 2-space indent, explicit `.js`/`.jsx` on every relative import. No TypeScript, no PropTypes. Hooks are named exports; components are default exports. There is no lint or format config — style is convention only.
- **Test placement:** test files sit *beside* their source (`foo.js` + `foo.test.js`).
- **Coverage floor:** 80% on every new server module.
- **`client/src/hooks/useConversation.js` is untouchable.** No task in any of the four plans may modify it or its test. Plan 3's final task proves this with `git diff`.
- **Nothing writes to the database.** Persistence is M3's single decision; pronunciation results live in client state only.
- **Azure is never a runtime path.** The adapter exists for `tools/calibration/` and requires an explicit key.
- **In unscripted mode `words[].phones` is stripped server-side** before the response is written. A test must fail if phones ever leak.
- **`substituted` is ABSENT, not null,** when a phoneme was produced as expected.
- **Commits stage explicit paths.** `git add -A` and `git add .` are forbidden. Verify the *staged* blob with `git show :<path>` before every commit — this repo has shipped a commit importing an untracked file (spec §11).

### Outstanding verification debt

The four adversarial critic passes (placeholders, interface drift, spec coverage, TDD quality) **did not run** — the API returned `529 Overloaded` twice. These plans carry a mechanical placeholder scan and an author self-review only. Treat the first task of each plan with extra scepticism, and re-run the adversarial pass when capacity allows.

---

## Chunk 4 — Drill content + calibration harness

This chunk builds two deliverables:

- **(a)** `server/src/content/drills.v1.json` — the curated, versioned drill set (frozen contract §8),
  with a Vitest suite that proves every sentence actually contains the phoneme it claims to target.
- **(b)** `tools/calibration/` — the offline harness that runs the local scorer over
  **speechocean762**, reports Pearson + Spearman correlation with human raters at utterance and
  phoneme level, **selects** an acoustic model between candidates, and implements spec §10's honest
  fallback (report substitutions, hide numbers) when correlation is weak.

### Preconditions (verify before Task 1)

1. **The server test harness must already exist.** These content tasks run `npm --prefix server test`,
   which requires `server/package.json` to carry `"test": "vitest run"` and the `vitest` devDependency,
   and `server/vitest.config.js` to exist. Both are created by the server-slot chunk. Verify:

   ```powershell
   node -e "const p=require('C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e/server/package.json'); console.log(p.scripts.test)"
   ```

   Expected output: `vitest run`. If it prints `undefined`, stop — the server-slot chunk has not
   landed yet and these tasks must be reordered after it.

2. **Python 3.11 is on PATH.** Verify:

   ```powershell
   python --version
   ```

   Expected output: `Python 3.11.x`.

3. **A note on IPA in the JSON.** `drills.v1.json` contains raw IPA (`ɪ`, `iː`, `æ`, `ə`, `dʒ`). Every
   file in this chunk is written UTF-8 **without** a BOM. If your editor adds one, `JSON.parse` throws
   `Unexpected token` on line 1 — that is the symptom, not a content error.

---

### Task 1: Drill content file — schema, seed row, and the /ɪ/ vs /iː/ set

**Files:**
- Create: `server/src/content/drills.v1.json`
- Test: `server/src/content/drills.v1.test.js` (create)

**Interfaces:**
- Produces: `server/src/content/drills.v1.json` — a `DrillContentFile`
  (`{ version: 1, updated: "2026-07-27", focuses: string[7], prompts: DrillPrompt[] }`), read at module
  load by `server/src/pron/prompts.js` via
  `readFileSync(new URL("../content/drills.v1.json", import.meta.url), "utf8")`.
- Consumes: nothing. This file has no imports and no runtime dependencies.

**Step 1 — write the failing test.**

Create `server/src/content/drills.v1.test.js`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The drill set is data, so its tests are data tests: they assert that every
// sentence really does carry the phoneme it claims to drill. The reference
// transcriptions below are curated (espeak-ng cannot run in Node), and the
// plan carries verification step V1 which re-checks them inside the sidecar
// container against the real espeak-ng backend.
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

// `ɪd` is a two-token sequence in the espeak inventory, not a single vocab
// entry, so targets are matched as contiguous token runs.
const TARGET_TOKENS = Object.freeze({ ɪd: ["ɪ", "d"] });

// Reference en-us espeak transcriptions, space-separated tokens.
const IPA_LEXICON = Object.freeze({
  ship: "ʃ ɪ p",
  sheep: "ʃ iː p",
  sit: "s ɪ t",
  seat: "s iː t",
  live: "l ɪ v",
  leave: "l iː v",
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

describe("drills.v1.json — file shape", () => {
  it("declares version 1, an ISO date, and the seven frozen focus slugs", () => {
    expect(CONTENT.version).toBe(1);
    expect(CONTENT.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CONTENT.focuses).toEqual(FOCUS_ORDER);
  });

  it("carries the frozen seed row verbatim", () => {
    const seed = CONTENT.prompts.find((p) => p.id === "ih-iy-01");
    expect(seed).toEqual({
      id: "ih-iy-01",
      focus: "ih-iy",
      text: "The ship is full of sheep.",
      ipaTargets: ["ɪ", "iː"],
      keyWords: ["ship", "sheep"],
      contrast: "vowel length + quality",
      level: "B2",
    });
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
  it("ships at least 3 prompts for the ih-iy focus", () => {
    const n = CONTENT.prompts.filter((p) => p.focus === "ih-iy").length;
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
```

**Step 2 — run it and watch it fail.**

```powershell
npm --prefix server test -- src/content/drills.v1.test.js
```

Expected failure — the suite cannot even collect, because the JSON does not exist:

```
FAIL  src/content/drills.v1.test.js [ src/content/drills.v1.test.js ]
Error: ENOENT: no such file or directory, open 'C:\talker\.claude\worktrees\kern-brand-product-assets-5f587e\server\src\content\drills.v1.json'
```

**Step 3 — write the content file.**

Create `server/src/content/drills.v1.json`:

```json
{
  "version": 1,
  "updated": "2026-07-27",
  "focuses": ["ih-iy", "ae", "schwa", "v-b", "dzh", "s-cluster", "ed-ending"],
  "prompts": [
    {
      "id": "ih-iy-01",
      "focus": "ih-iy",
      "text": "The ship is full of sheep.",
      "ipaTargets": ["ɪ", "iː"],
      "keyWords": ["ship", "sheep"],
      "contrast": "vowel length + quality",
      "level": "B2"
    },
    {
      "id": "ih-iy-02",
      "focus": "ih-iy",
      "text": "Sit down and take the seat by the window.",
      "ipaTargets": ["ɪ", "iː"],
      "keyWords": ["sit", "seat"],
      "contrast": "vowel length + quality",
      "level": "A2"
    },
    {
      "id": "ih-iy-03",
      "focus": "ih-iy",
      "text": "I live here, so I never want to leave.",
      "ipaTargets": ["ɪ", "iː"],
      "keyWords": ["live", "leave"],
      "contrast": "vowel length + quality",
      "level": "B1"
    }
  ]
}
```

**Step 4 — run it and watch it pass.**

```powershell
npm --prefix server test -- src/content/drills.v1.test.js
```

Expected: `Test Files  1 passed (1)` / `Tests  8 passed (8)`.

**Step 5 — commit (explicit paths only).**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add server/src/content/drills.v1.json server/src/content/drills.v1.test.js
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :server/src/content/drills.v1.json | Select-Object -First 5
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(pron): drill content file with the ih-iy minimal-pair set"
```

The `git show :<path>` line is spec §11's staged-content check — confirm it prints the JSON opening
brace and `"version": 1`, not an error, before the commit runs.

---

### Task 2: Drill content — /æ/, schwa, and /v/ vs /b/

**Files:**
- Modify: `server/src/content/drills.v1.json`
- Test: `server/src/content/drills.v1.test.js` (modify)

**Interfaces:**
- Produces: 9 more `DrillPrompt` entries (`ae-01..03`, `schwa-01..03`, `v-b-01..03`) in the same file.
  No new symbols.
- Consumes: nothing new.

**Step 1 — extend the test so it fails.**

In `server/src/content/drills.v1.test.js`, replace the whole `describe("drills.v1.json — set size", ...)`
block with:

```js
describe("drills.v1.json — set size", () => {
  it("ships at least 3 prompts for ih-iy, ae, schwa and v-b", () => {
    for (const focus of ["ih-iy", "ae", "schwa", "v-b"]) {
      const n = CONTENT.prompts.filter((p) => p.focus === focus).length;
      expect(n, `prompts for focus "${focus}"`).toBeGreaterThanOrEqual(3);
    }
  });
});
```

**Step 2 — run it and watch it fail.**

```powershell
npm --prefix server test -- src/content/drills.v1.test.js
```

Expected failure:

```
FAIL  src/content/drills.v1.test.js > drills.v1.json — set size > ships at least 3 prompts for ih-iy, ae, schwa and v-b
AssertionError: prompts for focus "ae": expected +0 to be greater than or equal to 3
```

**Step 3 — add the transcriptions.**

In `server/src/content/drills.v1.test.js`, replace the `IPA_LEXICON` literal with:

```js
const IPA_LEXICON = Object.freeze({
  ship: "ʃ ɪ p",
  sheep: "ʃ iː p",
  sit: "s ɪ t",
  seat: "s iː t",
  live: "l ɪ v",
  leave: "l iː v",
  cat: "k æ t",
  sat: "s æ t",
  flat: "f l æ t",
  that: "ð æ t",
  man: "m æ n",
  bad: "b æ d",
  bat: "b æ t",
  bet: "b ɛ t",
  about: "ə b aʊ t",
  problem: "p ɹ ɑː b l ə m",
  again: "ə ɡ ɛ n",
  banana: "b ə n æ n ə",
  camera: "k æ m ə ɹ ə",
  company: "k ʌ m p ə n i",
  vote: "v oʊ t",
  boat: "b oʊ t",
  very: "v ɛ ɹ i",
  big: "b ɪ ɡ",
  van: "v æ n",
  believe: "b ɪ l iː v",
  vase: "v eɪ s",
  basement: "b eɪ s m ə n t",
});
```

**Step 4 — add the prompts.**

In `server/src/content/drills.v1.json`, find the `ih-iy-03` object's closing brace — the last three
lines of the `prompts` array are:

```json
      "level": "B1"
    }
  ]
```

Replace those three lines with:

```json
      "level": "B1"
    },
    {
      "id": "ae-01",
      "focus": "ae",
      "text": "The cat sat on a flat black mat.",
      "ipaTargets": ["æ"],
      "keyWords": ["cat", "sat", "flat"],
      "contrast": "absent in Spanish",
      "level": "A2"
    },
    {
      "id": "ae-02",
      "focus": "ae",
      "text": "That man had a bad habit.",
      "ipaTargets": ["æ"],
      "keyWords": ["that", "man", "bad"],
      "contrast": "absent in Spanish",
      "level": "B1"
    },
    {
      "id": "ae-03",
      "focus": "ae",
      "text": "He bet that the bat would not break.",
      "ipaTargets": ["æ"],
      "keyWords": ["bat", "bet"],
      "contrast": "absent in Spanish",
      "level": "B2"
    },
    {
      "id": "schwa-01",
      "focus": "schwa",
      "text": "We can talk about the problem again tomorrow.",
      "ipaTargets": ["ə"],
      "keyWords": ["about", "problem", "again"],
      "contrast": "schwa reduction in unstressed syllables",
      "level": "B1"
    },
    {
      "id": "schwa-02",
      "focus": "schwa",
      "text": "The banana and the camera belong to my sister.",
      "ipaTargets": ["ə"],
      "keyWords": ["banana", "camera"],
      "contrast": "schwa reduction in unstressed syllables",
      "level": "A2"
    },
    {
      "id": "schwa-03",
      "focus": "schwa",
      "text": "Comfortable seats are a problem for the whole company.",
      "ipaTargets": ["ə"],
      "keyWords": ["problem", "company"],
      "contrast": "schwa reduction in unstressed syllables",
      "level": "B2"
    },
    {
      "id": "v-b-01",
      "focus": "v-b",
      "text": "Did you vote from the boat?",
      "ipaTargets": ["v", "b"],
      "keyWords": ["vote", "boat"],
      "contrast": "phonemic in English, allophonic in Spanish",
      "level": "B1"
    },
    {
      "id": "v-b-02",
      "focus": "v-b",
      "text": "A very big van blocked the road.",
      "ipaTargets": ["v", "b"],
      "keyWords": ["very", "big", "van"],
      "contrast": "phonemic in English, allophonic in Spanish",
      "level": "A2"
    },
    {
      "id": "v-b-03",
      "focus": "v-b",
      "text": "I believe the vase was moved to the basement.",
      "ipaTargets": ["v", "b"],
      "keyWords": ["believe", "vase", "basement"],
      "contrast": "phonemic in English, allophonic in Spanish",
      "level": "B2"
    }
  ]
```

**Step 5 — run it and watch it pass.**

```powershell
npm --prefix server test -- src/content/drills.v1.test.js
```

Expected: `Tests  8 passed (8)`. In particular the "puts every declared target phoneme in a keyWord"
case now covers 12 prompts — `ae-03` passes on `bat` (`b æ t`), and `v-b-01` needs **both** `vote`
(`v oʊ t`) and `boat` (`b oʊ t`) to satisfy `["v", "b"]`.

**Step 6 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add server/src/content/drills.v1.json server/src/content/drills.v1.test.js
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :server/src/content/drills.v1.json | Select-String -Pattern '"id": "v-b-03"'
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(pron): drill prompts for ae, schwa and v-b"
```

The `Select-String` line must print the matching line; if it prints nothing, the working tree is ahead
of the index and the commit would ship a stale file.

---

### Task 3: Drill content — /dʒ/, s-clusters, final -ed, and the full-set assertion

**Files:**
- Modify: `server/src/content/drills.v1.json`
- Test: `server/src/content/drills.v1.test.js` (modify)

**Interfaces:**
- Produces: 9 more `DrillPrompt` entries (`dzh-01..03`, `s-cluster-01..03`, `ed-ending-01..03`),
  bringing the file to **21 prompts / 3 per focus**, which is the minimum the frozen content contract
  requires. No new symbols.
- Consumes: nothing new.

**Step 1 — tighten the test so it fails.**

Replace the whole `describe("drills.v1.json — set size", ...)` block with:

```js
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
      for (const target of ["t", "d", "ɪd"]) {
        const carrier = p.keyWords.find((kw) =>
          ipaContains(IPA_LEXICON[kw.toLowerCase()] ?? "", target),
        );
        expect(carrier, `${p.id} is missing an -ed /${target}/ carrier`).toBeDefined();
      }
    }
  });
});
```

**Step 2 — run it and watch it fail.**

```powershell
npm --prefix server test -- src/content/drills.v1.test.js
```

Expected failure:

```
FAIL  src/content/drills.v1.test.js > drills.v1.json — set size > ships at least 3 prompts for every declared focus
AssertionError: prompts for focus "dzh": expected +0 to be greater than or equal to 3
```

**Step 3 — add the transcriptions.**

In `server/src/content/drills.v1.test.js`, insert these entries immediately after the
`basement: "b eɪ s m ə n t",` line inside `IPA_LEXICON`:

```js
  judge: "dʒ ʌ dʒ",
  john: "dʒ ɑː n",
  job: "dʒ ɑː b",
  manager: "m æ n ɪ dʒ ɚ",
  january: "dʒ æ n j uː ɛ ɹ i",
  just: "dʒ ʌ s t",
  huge: "h j uː dʒ",
  bridge: "b ɹ ɪ dʒ",
  spain: "s p eɪ n",
  study: "s t ʌ d i",
  spanish: "s p æ n ɪ ʃ",
  student: "s t uː d ə n t",
  stopped: "s t ɑː p t",
  station: "s t eɪ ʃ ə n",
  screen: "s k ɹ iː n",
  studio: "s t uː d i oʊ",
  strange: "s t ɹ eɪ n dʒ",
  walked: "w ɔː k t",
  played: "p l eɪ d",
  wanted: "w ɑː n t ɪ d",
  finished: "f ɪ n ɪ ʃ t",
  opened: "oʊ p ə n d",
  started: "s t ɑːɹ t ɪ d",
  watched: "w ɑː tʃ t",
  called: "k ɔː l d",
  decided: "d ɪ s aɪ d ɪ d",
```

**Step 4 — add the prompts.**

In `server/src/content/drills.v1.json`, the last three lines of the `prompts` array are now:

```json
      "level": "B2"
    }
  ]
```

Replace those three lines with:

```json
      "level": "B2"
    },
    {
      "id": "dzh-01",
      "focus": "dzh",
      "text": "The judge gave John a fair job.",
      "ipaTargets": ["dʒ"],
      "keyWords": ["judge", "John", "job"],
      "contrast": "affricate absent in Spanish",
      "level": "B1"
    },
    {
      "id": "dzh-02",
      "focus": "dzh",
      "text": "The manager changed the schedule in January.",
      "ipaTargets": ["dʒ"],
      "keyWords": ["manager", "January"],
      "contrast": "affricate absent in Spanish",
      "level": "B2"
    },
    {
      "id": "dzh-03",
      "focus": "dzh",
      "text": "Just imagine a huge orange bridge.",
      "ipaTargets": ["dʒ"],
      "keyWords": ["just", "huge", "bridge"],
      "contrast": "affricate absent in Spanish",
      "level": "B2"
    },
    {
      "id": "s-cluster-01",
      "focus": "s-cluster",
      "text": "Spain is a special place to study Spanish.",
      "ipaTargets": ["s"],
      "keyWords": ["Spain", "study", "Spanish"],
      "contrast": "Spanish epenthesis (spain -> espain)",
      "level": "A2"
    },
    {
      "id": "s-cluster-02",
      "focus": "s-cluster",
      "text": "The student stopped at the small station.",
      "ipaTargets": ["s"],
      "keyWords": ["student", "stopped", "station"],
      "contrast": "Spanish epenthesis (spain -> espain)",
      "level": "B1"
    },
    {
      "id": "s-cluster-03",
      "focus": "s-cluster",
      "text": "The screen in the studio still looks strange.",
      "ipaTargets": ["s"],
      "keyWords": ["screen", "studio", "strange"],
      "contrast": "Spanish epenthesis (spain -> espain)",
      "level": "B2"
    },
    {
      "id": "ed-ending-01",
      "focus": "ed-ending",
      "text": "She walked home, he played outside, and they wanted more.",
      "ipaTargets": ["t", "d", "ɪd"],
      "keyWords": ["walked", "played", "wanted"],
      "contrast": "/t/ /d/ /ɪd/ allomorphy",
      "level": "B1"
    },
    {
      "id": "ed-ending-02",
      "focus": "ed-ending",
      "text": "I finished the work, opened the door, and started again.",
      "ipaTargets": ["t", "d", "ɪd"],
      "keyWords": ["finished", "opened", "started"],
      "contrast": "/t/ /d/ /ɪd/ allomorphy",
      "level": "B2"
    },
    {
      "id": "ed-ending-03",
      "focus": "ed-ending",
      "text": "We watched the film, called a friend, and decided to wait.",
      "ipaTargets": ["t", "d", "ɪd"],
      "keyWords": ["watched", "called", "decided"],
      "contrast": "/t/ /d/ /ɪd/ allomorphy",
      "level": "B2"
    }
  ]
```

**Step 5 — run it and watch it pass.**

```powershell
npm --prefix server test -- src/content/drills.v1.test.js
```

Expected: `Tests  10 passed (10)`.

Then run the whole server suite to prove nothing else regressed:

```powershell
npm --prefix server test
```

Expected: all server test files pass.

**Step 6 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add server/src/content/drills.v1.json server/src/content/drills.v1.test.js
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :server/src/content/drills.v1.json | Select-String -Pattern '"id": "ed-ending-03"'
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(pron): complete the 21-prompt L1-Spanish drill set"
```

---


### Task 4: Calibration harness — Python environment and dependency manifest

**Files:**
- Create: `tools/calibration/requirements.txt`
- Modify: `.gitignore`
- Test: none yet — verification is that `pytest` runs at all.

**Interfaces:**
- Produces: a working interpreter at `tools/calibration/.venv/Scripts/python.exe` with `scipy`,
  `requests`, `numpy`, `pandas`, `datasets`, and `pytest` importable.
- Consumes: system `python` 3.11.

**Step 1 — write the dependency manifest.**

Create `tools/calibration/requirements.txt`:

```
# Calibration harness deps (design §8). Ranges, not pins: the exact resolved
# versions get recorded in README.md after the first successful install, per
# verification step V4. `datasets` is imported lazily inside
# run_calibration.iter_records so the unit tests need no corpus download.
datasets>=4,<5
requests>=2.32,<3
scipy>=1.14,<2
numpy>=2.1,<3
pandas>=2.2,<3
pytest>=8,<10
```

**Step 2 — create the environment.**

```powershell
cd C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e
python -m venv tools/calibration/.venv
tools/calibration/.venv/Scripts/python.exe -m pip install --upgrade pip
tools/calibration/.venv/Scripts/python.exe -m pip install -r tools/calibration/requirements.txt
```

The last command downloads ~300 MB (pyarrow, scipy, pandas) and takes several minutes. It ends with
`Successfully installed ...`.

**Step 3 — verify the interpreter and record what resolved.**

```powershell
tools/calibration/.venv/Scripts/python.exe -c "import scipy, numpy, requests, pandas; print(scipy.__version__, numpy.__version__)"
tools/calibration/.venv/Scripts/python.exe -m pip freeze > tools/calibration/.venv/pip-freeze.txt
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests -q
```

Expected from the last command — the directory does not exist yet, and that is the point: it proves
pytest itself runs.

```
ERROR: file or directory not found: tools/calibration/tests
```

`pip-freeze.txt` stays inside the ignored venv; Task 14 copies the load-bearing lines into the README.

**Step 4 — stop the artifacts from ever being committed.**

In `.gitignore`, find the last two lines:

```
__pycache__/
*.pyc
```

Append immediately after them:

```
# pronunciation calibration harness (tools/calibration)
tools/calibration/.venv/
tools/calibration/out/
.pytest_cache/
```

**Step 5 — prove the ignore rules bite.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e status --porcelain tools/calibration
```

Expected output — exactly one line, the manifest, with no `.venv` noise:

```
?? tools/calibration/requirements.txt
```

**Step 6 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/requirements.txt .gitignore
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :.gitignore | Select-String -Pattern "tools/calibration/.venv/"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "chore(calibration): python deps and ignore rules for the harness"
```

---

### Task 5: ARPAbet ↔ IPA mapping tables

speechocean762 scores phones as **ARPAbet with a stress digit** (`AA0`, `IH1`); the sidecar reports
**espeak IPA** (`ɑː`, `ɪ`). Verification step V6 says this mapping must be built and tested, not
assumed. This task builds the tables; Task 6 builds the sequence alignment on top of them.

**Files:**
- Create: `tools/calibration/arpabet_ipa.py`
- Test: `tools/calibration/tests/test_arpabet_ipa.py` (create)

**Interfaces:**
- Produces:
  - `ARPABET_PHONES: frozenset[str]` — the 39 stress-free ARPAbet phones
  - `ARPABET_TO_IPA: dict[str, str]`
  - `IPA_TO_ARPABET: dict[str, tuple[str, ...]]`
  - `UNKNOWN_ARPABET: str` (`"??"`)
  - `STRESS_DIGITS: str` (`"012"`)
  - `def strip_stress(phone: str) -> str`
  - `def arpabet_to_ipa(phone: str) -> str`
  - `def ipa_to_arpabet(token: str) -> tuple[str, ...]`
- Consumes: stdlib only.

**Step 1 — write the failing test.**

Create `tools/calibration/tests/test_arpabet_ipa.py`:

```python
"""Mapping-table tests (verification step V6)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from arpabet_ipa import (  # noqa: E402
    ARPABET_PHONES,
    ARPABET_TO_IPA,
    IPA_TO_ARPABET,
    arpabet_to_ipa,
    ipa_to_arpabet,
    strip_stress,
)


def test_strip_stress_removes_only_a_trailing_digit():
    assert strip_stress("AA0") == "AA"
    assert strip_stress("IH1") == "IH"
    assert strip_stress("er2") == "ER"
    assert strip_stress("SH") == "SH"
    assert strip_stress(" T ") == "T"
    assert strip_stress("") == ""


def test_every_arpabet_phone_has_a_canonical_ipa_that_maps_back():
    assert len(ARPABET_PHONES) == 39
    for phone in sorted(ARPABET_PHONES):
        ipa = ARPABET_TO_IPA[phone]
        assert ipa, f"{phone} has no canonical IPA"
        assert IPA_TO_ARPABET[ipa] == (phone,), f"{phone} -> {ipa} does not round-trip"


def test_arpabet_to_ipa_handles_stress_and_unknowns():
    assert arpabet_to_ipa("IY1") == "iː"
    assert arpabet_to_ipa("jh0") == "dʒ"
    assert arpabet_to_ipa("QQ") == ""


def test_ipa_to_arpabet_covers_the_multi_phone_espeak_units():
    assert ipa_to_arpabet("ɑːɹ") == ("AA", "R")
    assert ipa_to_arpabet("ɔːɹ") == ("AO", "R")
    assert ipa_to_arpabet("əl") == ("AH", "L")
    assert ipa_to_arpabet("ɚ") == ("ER",)
    assert ipa_to_arpabet("ʃ") == ("SH",)
    assert ipa_to_arpabet("QQQ") == ()


def test_reduced_and_full_vowels_both_land_on_ah():
    # espeak distinguishes ə from ʌ; ARPAbet folds both onto AH (AH0 / AH1).
    assert ipa_to_arpabet("ə") == ("AH",)
    assert ipa_to_arpabet("ʌ") == ("AH",)
    assert ARPABET_TO_IPA["AH"] == "ʌ"


def test_every_mapped_arpabet_phone_is_a_real_arpabet_phone():
    for token, phones in IPA_TO_ARPABET.items():
        assert phones, f"{token} maps to nothing"
        for phone in phones:
            assert phone in ARPABET_PHONES, f"{token} -> {phone} is not ARPAbet"
```

**Step 2 — run it and watch it fail.**

```powershell
cd C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests -q
```

Expected failure:

```
E   ModuleNotFoundError: No module named 'arpabet_ipa'
```

**Step 3 — write the module.**

Create `tools/calibration/arpabet_ipa.py`:

```python
"""ARPAbet <-> espeak-IPA mapping for the calibration harness (verification V6).

speechocean762 scores phones as ARPAbet with a stress digit (`AA0`, `IH1`).
The sidecar reports espeak IPA tokens (`ɑː`, `ɪ`, `dʒ`). Correlating the two
requires an explicit mapping, including the many-to-one cases where a single
espeak token such as `ɑːɹ` covers two ARPAbet phones (`AA R`).

Direction of truth is IPA -> ARPAbet: that is the direction the harness travels,
and the direction that has to handle multi-phone units.
"""

from __future__ import annotations

STRESS_DIGITS = "012"

#: Sentinel emitted by expand_ipa() for a token this table does not know.
UNKNOWN_ARPABET = "??"

#: The 39 stress-free CMUdict / ARPAbet phones.
ARPABET_PHONES = frozenset(
    {
        "AA", "AE", "AH", "AO", "AW", "AY", "B", "CH", "D", "DH",
        "EH", "ER", "EY", "F", "G", "HH", "IH", "IY", "JH", "K",
        "L", "M", "N", "NG", "OW", "OY", "P", "R", "S", "SH",
        "T", "TH", "UH", "UW", "V", "W", "Y", "Z", "ZH",
    }
)

#: Canonical IPA for each ARPAbet phone. Total by construction: one entry per
#: ARPAbet phone, every one of them round-tripping through IPA_TO_ARPABET.
ARPABET_TO_IPA: dict[str, str] = {
    "AA": "ɑː", "AE": "æ", "AH": "ʌ", "AO": "ɔː", "AW": "aʊ",
    "AY": "aɪ", "B": "b", "CH": "tʃ", "D": "d", "DH": "ð",
    "EH": "ɛ", "ER": "ɚ", "EY": "eɪ", "F": "f", "G": "ɡ",
    "HH": "h", "IH": "ɪ", "IY": "iː", "JH": "dʒ", "K": "k",
    "L": "l", "M": "m", "N": "n", "NG": "ŋ", "OW": "oʊ",
    "OY": "ɔɪ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "UH": "ʊ", "UW": "uː", "V": "v",
    "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}

#: espeak IPA token -> the ARPAbet phone sequence it covers.
IPA_TO_ARPABET: dict[str, tuple[str, ...]] = {
    # canonical one-to-one (mirrors ARPABET_TO_IPA)
    "ɑː": ("AA",), "æ": ("AE",), "ʌ": ("AH",), "ɔː": ("AO",), "aʊ": ("AW",),
    "aɪ": ("AY",), "b": ("B",), "tʃ": ("CH",), "d": ("D",), "ð": ("DH",),
    "ɛ": ("EH",), "ɚ": ("ER",), "eɪ": ("EY",), "f": ("F",), "ɡ": ("G",),
    "h": ("HH",), "ɪ": ("IH",), "iː": ("IY",), "dʒ": ("JH",), "k": ("K",),
    "l": ("L",), "m": ("M",), "n": ("N",), "ŋ": ("NG",), "oʊ": ("OW",),
    "ɔɪ": ("OY",), "p": ("P",), "ɹ": ("R",), "s": ("S",), "ʃ": ("SH",),
    "t": ("T",), "θ": ("TH",), "ʊ": ("UH",), "uː": ("UW",), "v": ("V",),
    "w": ("W",), "j": ("Y",), "z": ("Z",), "ʒ": ("ZH",),
    # espeak variants that collapse onto the same ARPAbet phone
    "ə": ("AH",), "ɐ": ("AH",), "ɑ": ("AA",), "ɔ": ("AO",),
    "ɜː": ("ER",), "ɝ": ("ER",), "e": ("EH",), "ᵻ": ("IH",),
    "i": ("IY",), "u": ("UW",), "r": ("R",), "g": ("G",),
    # multi-phone espeak units — the V6 cases
    "ɑːɹ": ("AA", "R"), "ɔːɹ": ("AO", "R"), "oːɹ": ("AO", "R"),
    "ɛɹ": ("EH", "R"), "ɪɹ": ("IH", "R"), "ʊɹ": ("UH", "R"),
    "aɪɚ": ("AY", "ER"), "aʊɚ": ("AW", "ER"),
    "əl": ("AH", "L"), "ən": ("AH", "N"), "əm": ("AH", "M"),
    "iə": ("IY", "AH"),
}


def strip_stress(phone: str) -> str:
    """`"AA0"` -> `"AA"`. Uppercases and trims; a bare `""` stays `""`."""
    cleaned = phone.strip().upper()
    if cleaned and cleaned[-1] in STRESS_DIGITS:
        return cleaned[:-1]
    return cleaned


def arpabet_to_ipa(phone: str) -> str:
    """Canonical IPA for one ARPAbet phone, `""` when the phone is unknown."""
    return ARPABET_TO_IPA.get(strip_stress(phone), "")


def ipa_to_arpabet(token: str) -> tuple[str, ...]:
    """ARPAbet phones covered by one espeak IPA token, `()` when unknown."""
    return IPA_TO_ARPABET.get(token.strip(), ())
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests -q
```

Expected: `6 passed`.

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/arpabet_ipa.py tools/calibration/tests/test_arpabet_ipa.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/arpabet_ipa.py | Select-String -Pattern "def ipa_to_arpabet"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): ARPAbet to espeak-IPA mapping tables"
```

---

### Task 6: Sequence alignment between IPA tokens and ARPAbet phones

A machine phone list (`["k", "ɑːɹ"]`) and a human phone list (`["K", "AA1", "R"]`) describe the same
word with different lengths. Pairing them by index silently mis-scores every phone after the first
multi-phone unit. This task pairs them by Needleman-Wunsch over the *expanded* sequences.

**Files:**
- Modify: `tools/calibration/arpabet_ipa.py`
- Test: `tools/calibration/tests/test_arpabet_ipa.py` (modify)

**Interfaces:**
- Produces:
  - `def expand_ipa(ipa_tokens: list[str]) -> tuple[list[str], list[int]]` — flat predicted ARPAbet
    sequence plus, per element, the index of the IPA token that owns it
  - `def align_ipa_to_arpabet(ipa_tokens: list[str], arpabet_phones: list[str]) -> list[tuple[int, ...]]`
    — per IPA token, the indices into `arpabet_phones` it aligns to; `()` when it aligns to nothing
- Consumes: `strip_stress`, `ipa_to_arpabet`, `UNKNOWN_ARPABET` from the same module.

**Step 1 — extend the test so it fails.**

In `tools/calibration/tests/test_arpabet_ipa.py`, change the import block to add the two new names:

```python
from arpabet_ipa import (  # noqa: E402
    ARPABET_PHONES,
    ARPABET_TO_IPA,
    IPA_TO_ARPABET,
    align_ipa_to_arpabet,
    arpabet_to_ipa,
    expand_ipa,
    ipa_to_arpabet,
    strip_stress,
)
```

and append these cases to the end of the file:

```python
def test_expand_ipa_records_the_owning_token_per_phone():
    predicted, owners = expand_ipa(["k", "ɑːɹ"])
    assert predicted == ["K", "AA", "R"]
    assert owners == [0, 1, 1]


def test_expand_ipa_marks_unknown_tokens_without_dropping_them():
    predicted, owners = expand_ipa(["s", "QQQ", "t"])
    assert predicted == ["S", "??", "T"]
    assert owners == [0, 1, 2]


def test_align_pairs_one_to_one_when_the_sequences_agree():
    assert align_ipa_to_arpabet(
        ["ð", "ə", "ʃ", "iː", "p"],
        ["DH", "AH0", "SH", "IY1", "P"],
    ) == [(0,), (1,), (2,), (3,), (4,)]


def test_align_gives_a_multi_phone_unit_both_of_its_slots():
    assert align_ipa_to_arpabet(["k", "ɑːɹ"], ["K", "AA1", "R"]) == [(0,), (1, 2)]


def test_align_leaves_a_deleted_phone_unowned():
    # espeak says "stopped" is /s t ɑː p t/; the corpus canonical is S T AA P.
    assert align_ipa_to_arpabet(
        ["s", "t", "ɑː", "p", "t"],
        ["S", "T", "AA1", "P"],
    ) == [(0,), (1,), (2,), (3,), ()]


def test_align_keeps_neighbours_in_step_across_an_unknown_token():
    assert align_ipa_to_arpabet(["s", "QQQ", "t"], ["S", "AH0", "T"]) == [(0,), (), (2,)]


def test_align_still_pairs_a_substituted_phone():
    # A wrong-but-present phone must stay paired: the human scored that slot.
    assert align_ipa_to_arpabet(["ʃ", "ɪ", "p"], ["SH", "IY1", "P"]) == [(0,), (1,), (2,)]


def test_align_of_empty_inputs_is_empty():
    assert align_ipa_to_arpabet([], ["S"]) == []
    assert align_ipa_to_arpabet(["s"], []) == [()]
```

**Step 2 — run it and watch it fail.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests -q
```

Expected failure:

```
E   ImportError: cannot import name 'align_ipa_to_arpabet' from 'arpabet_ipa'
```

**Step 3 — implement.**

Append to `tools/calibration/arpabet_ipa.py`:

```python
def expand_ipa(ipa_tokens: list[str]) -> tuple[list[str], list[int]]:
    """Flatten IPA tokens into predicted ARPAbet phones plus an owner index.

    An unknown token contributes exactly one `UNKNOWN_ARPABET` placeholder so
    the surrounding tokens keep their positions.
    """
    predicted: list[str] = []
    owners: list[int] = []
    for index, token in enumerate(ipa_tokens):
        mapped = ipa_to_arpabet(token) or (UNKNOWN_ARPABET,)
        for phone in mapped:
            predicted.append(phone)
            owners.append(index)
    return predicted, owners


def _nw_align(
    left: list[str],
    right: list[str],
    *,
    match: int = 2,
    mismatch: int = -1,
    gap: int = -2,
) -> list[tuple[int | None, int | None]]:
    """Needleman-Wunsch. Returns (left_index, right_index) pairs; None = gap.

    Traceback prefers diagonal, then up, then left, so the output is
    deterministic for a given input.
    """
    rows, cols = len(left), len(right)
    score = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(1, rows + 1):
        score[i][0] = score[i - 1][0] + gap
    for j in range(1, cols + 1):
        score[0][j] = score[0][j - 1] + gap
    for i in range(1, rows + 1):
        for j in range(1, cols + 1):
            hit = match if left[i - 1] == right[j - 1] else mismatch
            score[i][j] = max(
                score[i - 1][j - 1] + hit,
                score[i - 1][j] + gap,
                score[i][j - 1] + gap,
            )

    pairs: list[tuple[int | None, int | None]] = []
    i, j = rows, cols
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            hit = match if left[i - 1] == right[j - 1] else mismatch
            if score[i][j] == score[i - 1][j - 1] + hit:
                pairs.append((i - 1, j - 1))
                i -= 1
                j -= 1
                continue
        if i > 0 and score[i][j] == score[i - 1][j] + gap:
            pairs.append((i - 1, None))
            i -= 1
            continue
        pairs.append((None, j - 1))
        j -= 1
    pairs.reverse()
    return pairs


def align_ipa_to_arpabet(
    ipa_tokens: list[str],
    arpabet_phones: list[str],
) -> list[tuple[int, ...]]:
    """Per IPA token, the `arpabet_phones` indices it aligns to.

    An empty tuple means the token aligned to nothing: it was inserted relative
    to the corpus transcription, or the table does not know it. Callers MUST
    skip those tokens rather than invent a human score for them.
    """
    predicted, owners = expand_ipa(ipa_tokens)
    actual = [strip_stress(phone) for phone in arpabet_phones]
    owned: list[list[int]] = [[] for _ in ipa_tokens]
    for left_index, right_index in _nw_align(predicted, actual):
        if left_index is None or right_index is None:
            continue
        if predicted[left_index] == UNKNOWN_ARPABET:
            continue
        owned[owners[left_index]].append(right_index)
    return [tuple(indices) for indices in owned]
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests -q
```

Expected: `14 passed`.

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/arpabet_ipa.py tools/calibration/tests/test_arpabet_ipa.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/arpabet_ipa.py | Select-String -Pattern "def align_ipa_to_arpabet"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): Needleman-Wunsch alignment of IPA tokens to ARPAbet phones"
```

---


### Task 7: Correlation primitive

**Files:**
- Create: `tools/calibration/correlate.py`
- Test: `tools/calibration/tests/test_correlate.py` (create)

**Interfaces:**
- Produces:
  - `PASS_MIN_COVERAGE: float` (`0.80`), `PASS_MIN_UTTERANCE_PEARSON: float` (`0.60`),
    `PASS_MIN_PHONEME_SPEARMAN: float` (`0.35`), `FALLBACK_MIN_SUBSTITUTION_F1: float` (`0.30`),
    `MIN_SAMPLES: int` (`30`)
  - `@dataclass(frozen=True) class Correlation` with fields
    `n: int, pearson_r: float, pearson_p: float, spearman_rho: float, spearman_p: float`
  - `def correlate(xs: list[float], ys: list[float]) -> Correlation`
- Consumes: `scipy.stats.pearsonr`, `scipy.stats.spearmanr`.

**Step 1 — write the failing test.**

Create `tools/calibration/tests/test_correlate.py`:

```python
"""Correlation, verdict and model-selection tests for the calibration harness."""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from correlate import Correlation, correlate  # noqa: E402


def test_perfectly_linear_data_correlates_at_one():
    result = correlate([1.0, 2.0, 3.0, 4.0], [10.0, 20.0, 30.0, 40.0])
    assert isinstance(result, Correlation)
    assert result.n == 4
    assert result.pearson_r == pytest.approx(1.0)
    assert result.spearman_rho == pytest.approx(1.0)


def test_perfectly_inverted_data_correlates_at_minus_one():
    result = correlate([1.0, 2.0, 3.0, 4.0], [40.0, 30.0, 20.0, 10.0])
    assert result.pearson_r == pytest.approx(-1.0)
    assert result.spearman_rho == pytest.approx(-1.0)


def test_monotone_but_curved_data_ranks_higher_than_it_lines_up():
    # Spearman sees the perfect ordering; Pearson is dragged down by the curve.
    xs = [1.0, 2.0, 3.0, 4.0, 5.0]
    ys = [1.0, 4.0, 9.0, 16.0, 100.0]
    result = correlate(xs, ys)
    assert result.spearman_rho == pytest.approx(1.0)
    assert result.pearson_r < 0.95


def test_constant_input_yields_nan_rather_than_a_crash():
    result = correlate([5.0, 5.0, 5.0, 5.0], [1.0, 2.0, 3.0, 4.0])
    assert result.n == 4
    assert math.isnan(result.pearson_r)
    assert math.isnan(result.spearman_rho)


def test_too_few_samples_yields_nan():
    result = correlate([1.0, 2.0], [1.0, 2.0])
    assert result.n == 2
    assert math.isnan(result.pearson_r)


def test_mismatched_lengths_are_a_programming_error():
    with pytest.raises(ValueError, match="same length"):
        correlate([1.0, 2.0], [1.0])
```

**Step 2 — run it and watch it fail.**

```powershell
cd C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected failure:

```
E   ModuleNotFoundError: No module named 'correlate'
```

**Step 3 — implement.**

Create `tools/calibration/correlate.py`:

```python
"""Correlation + model-selection report for the pronunciation calibration harness.

Reads the CSV written by run_calibration.py and answers one question per
acoustic model: are its numeric scores trustworthy enough to show a learner?

Verdicts (see README, "Pass/fail thresholds"):
  PASS                -> ship numeric scores
  SUBSTITUTIONS_ONLY  -> design §10 fallback: report `substituted`, hide numbers
  FAIL                -> the model is not usable
  DISQUALIFIED        -> the model could not score enough of the corpus

Usage:
  python tools/calibration/correlate.py tools/calibration/out/scores.csv
  python tools/calibration/correlate.py out/facebook.csv out/mrrubino.csv
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from scipy import stats

#: A model that cannot score this fraction of the corpus is disqualified before
#: correlation is even considered — a model that only scores the easy 40 % has a
#: flattering r for reasons that have nothing to do with quality.
PASS_MIN_COVERAGE = 0.80

#: Utterance-level Pearson r required to show numeric scores to a learner.
PASS_MIN_UTTERANCE_PEARSON = 0.60

#: Phoneme-level Spearman rho required alongside it. Deliberately lower:
#: per-phone human labels are a 3-point scale averaged over 5 raters, so the
#: ceiling on any phoneme-level correlation is far below the utterance ceiling.
PASS_MIN_PHONEME_SPEARMAN = 0.35

#: design §10 fallback gate. Below this the substitutions are noise too.
FALLBACK_MIN_SUBSTITUTION_F1 = 0.30

#: Fewer pairs than this and the correlation is not evidence of anything.
MIN_SAMPLES = 30


@dataclass(frozen=True)
class Correlation:
    """Pearson and Spearman for one (human, machine) score population."""

    n: int
    pearson_r: float
    pearson_p: float
    spearman_rho: float
    spearman_p: float


def _nan_correlation(n: int) -> Correlation:
    nan = float("nan")
    return Correlation(n=n, pearson_r=nan, pearson_p=nan, spearman_rho=nan, spearman_p=nan)


def correlate(xs: list[float], ys: list[float]) -> Correlation:
    """Pearson + Spearman over paired scores.

    Returns NaN correlations (never raises) when there are fewer than three
    pairs or either series is constant — both happen on small or degenerate
    slices and must not abort a whole calibration report.
    """
    if len(xs) != len(ys):
        raise ValueError("xs and ys must be the same length")
    n = len(xs)
    if n < 3 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return _nan_correlation(n)
    pearson = stats.pearsonr(xs, ys)
    spearman = stats.spearmanr(xs, ys)
    return Correlation(
        n=n,
        pearson_r=round(float(pearson[0]), 6),
        pearson_p=round(float(pearson[1]), 6),
        spearman_rho=round(float(spearman[0]), 6),
        spearman_p=round(float(spearman[1]), 6),
    )
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected: `6 passed`.

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/correlate.py tools/calibration/tests/test_correlate.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/correlate.py | Select-String -Pattern "def correlate"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): Pearson/Spearman primitive with degenerate-input guards"
```

---

### Task 8: Reading the score CSV — rows, models, coverage, pairs

**Files:**
- Modify: `tools/calibration/correlate.py`
- Test: `tools/calibration/tests/test_correlate.py` (modify)

**Interfaces:**
- Produces:
  - `REQUIRED_COLUMNS: tuple[str, ...]`
  - `def load_rows(path: Path) -> list[dict[str, str]]`
  - `def models(rows: list[dict[str, str]]) -> list[str]`
  - `def coverage(rows: list[dict[str, str]], model: str) -> float`
  - `def pairs(rows: list[dict[str, str]], model: str, level: str) -> tuple[list[float], list[float]]`
- Consumes: `csv`, `pathlib.Path`.

**Step 1 — extend the test so it fails.**

Add to the imports at the top of `tools/calibration/tests/test_correlate.py`:

```python
import csv  # noqa: E402

from correlate import (  # noqa: E402
    REQUIRED_COLUMNS,
    coverage,
    load_rows,
    models,
    pairs,
)
```

and append:

```python
def _write_csv(tmp_path, rows):
    path = tmp_path / "scores.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(REQUIRED_COLUMNS))
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in REQUIRED_COLUMNS})
    return path


def _row(**overrides):
    base = {
        "model": "facebook",
        "level": "utterance",
        "utt_id": "test-00000",
        "word_index": "",
        "phone_index": "",
        "ipa": "",
        "arpabet": "",
        "human": "80",
        "machine": "70",
        "human_sub": "",
        "machine_sub": "",
        "machine_sub_arpabet": "",
        "error_code": "",
    }
    base.update(overrides)
    return base


def test_load_rows_reads_every_data_row(tmp_path):
    path = _write_csv(tmp_path, [_row(), _row(utt_id="test-00001", human="60")])
    rows = load_rows(path)
    assert len(rows) == 2
    assert rows[1]["human"] == "60"


def test_load_rows_rejects_a_csv_missing_a_required_column(tmp_path):
    path = tmp_path / "bad.csv"
    path.write_text("model,level\nfacebook,utterance\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing column"):
        load_rows(path)


def test_models_are_sorted_and_deduplicated():
    rows = [_row(model="mrrubino"), _row(model="facebook"), _row(model="facebook")]
    assert models(rows) == ["facebook", "mrrubino"]


def test_coverage_is_scored_utterances_over_attempted_utterances():
    rows = [
        _row(),
        _row(utt_id="test-00001"),
        _row(utt_id="test-00002", level="error", human="", machine="", error_code="NO_SPEECH"),
        _row(model="mrrubino", level="error", human="", machine="", error_code="UNPRONOUNCEABLE_TEXT"),
    ]
    assert coverage(rows, "facebook") == pytest.approx(2 / 3)
    assert coverage(rows, "mrrubino") == 0.0
    assert coverage(rows, "absent") == 0.0


def test_pairs_selects_one_level_of_one_model_and_skips_blanks():
    rows = [
        _row(human="80", machine="70"),
        _row(level="phoneme", human="100", machine="90"),
        _row(model="mrrubino", human="10", machine="10"),
        _row(human="", machine="55"),
    ]
    assert pairs(rows, "facebook", "utterance") == ([80.0], [70.0])
    assert pairs(rows, "facebook", "phoneme") == ([100.0], [90.0])
```

**Step 2 — run it and watch it fail.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected failure:

```
E   ImportError: cannot import name 'REQUIRED_COLUMNS' from 'correlate'
```

**Step 3 — implement.**

In `tools/calibration/correlate.py`, extend the import block at the top:

```python
from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path

from scipy import stats
```

and append to the end of the file:

```python
#: Columns run_calibration.py writes and this module reads. A CSV that lacks any
#: of them is rejected loudly — a silently-missing column would just produce an
#: empty, plausible-looking report.
REQUIRED_COLUMNS = (
    "model",
    "level",
    "utt_id",
    "word_index",
    "phone_index",
    "ipa",
    "arpabet",
    "human",
    "machine",
    "human_sub",
    "machine_sub",
    "machine_sub_arpabet",
    "error_code",
)


def load_rows(path: Path) -> list[dict[str, str]]:
    """Read one score CSV. Raises ValueError when a required column is absent."""
    with Path(path).open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        for column in REQUIRED_COLUMNS:
            if column not in header:
                raise ValueError(f"{path}: missing column {column!r}")
        return [dict(row) for row in reader]


def models(rows: list[dict[str, str]]) -> list[str]:
    """Every model label present in the rows, sorted for a stable report."""
    return sorted({row["model"] for row in rows if row["model"]})


def coverage(rows: list[dict[str, str]], model: str) -> float:
    """Scored utterances / attempted utterances for one model, 0.0 when none."""
    scored = 0
    failed = 0
    for row in rows:
        if row["model"] != model:
            continue
        if row["level"] == "utterance" and row["machine"].strip():
            scored += 1
        elif row["level"] == "error":
            failed += 1
    attempted = scored + failed
    return scored / attempted if attempted else 0.0


def pairs(
    rows: list[dict[str, str]],
    model: str,
    level: str,
) -> tuple[list[float], list[float]]:
    """(human, machine) score series for one model at one level."""
    human: list[float] = []
    machine: list[float] = []
    for row in rows:
        if row["model"] != model or row["level"] != level:
            continue
        if not row["human"].strip() or not row["machine"].strip():
            continue
        human.append(float(row["human"]))
        machine.append(float(row["machine"]))
    return human, machine
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected: `11 passed`.

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/correlate.py tools/calibration/tests/test_correlate.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/correlate.py | Select-String -Pattern "def coverage"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): score-CSV reader with coverage and per-level pairing"
```

---

### Task 9: Substitution agreement — the metric the §10 fallback rests on

If the numeric scores fail calibration, the honest product is `substituted` without a score. That is
only honest if the substitutions themselves are measured. speechocean762 gives, per word, a
`mispronunciations` list of `{canonical-phone, index, pronounced-phone}`, which is exactly the ground
truth for that claim.

**Files:**
- Modify: `tools/calibration/correlate.py`
- Test: `tools/calibration/tests/test_correlate.py` (modify)

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class SubstitutionAgreement` with fields
    `true_positives: int, false_positives: int, false_negatives: int, precision: float,
    recall: float, f1: float, identity_matches: int, identity_accuracy: float`
  - `def substitution_agreement(rows: list[dict[str, str]], model: str) -> SubstitutionAgreement`
- Consumes: `arpabet_ipa.strip_stress`.

**Step 1 — extend the test so it fails.**

Add to the `from correlate import (...)` block in `tools/calibration/tests/test_correlate.py`:

```python
    SubstitutionAgreement,
    substitution_agreement,
```

and append:

```python
def test_substitution_agreement_counts_detection_and_identity():
    rows = [
        # true positive, right identity: human heard IY where IH was expected
        _row(level="phoneme", human_sub="IY1", machine_sub="iː", machine_sub_arpabet="IY"),
        # true positive, wrong identity
        _row(level="phoneme", human_sub="EH0", machine_sub="æ", machine_sub_arpabet="AE"),
        # false positive: the machine invented a substitution
        _row(level="phoneme", human_sub="", machine_sub="b", machine_sub_arpabet="B"),
        # false negative: the machine missed one
        _row(level="phoneme", human_sub="D", machine_sub="", machine_sub_arpabet=""),
        # agreed-correct phone, counts toward neither
        _row(level="phoneme"),
        # utterance rows are ignored entirely
        _row(level="utterance", human_sub="D"),
    ]
    result = substitution_agreement(rows, "facebook")
    assert isinstance(result, SubstitutionAgreement)
    assert (result.true_positives, result.false_positives, result.false_negatives) == (2, 1, 1)
    assert result.precision == pytest.approx(2 / 3)
    assert result.recall == pytest.approx(2 / 3)
    assert result.f1 == pytest.approx(2 / 3)
    assert result.identity_matches == 1
    assert result.identity_accuracy == pytest.approx(0.5)


def test_substitution_agreement_is_all_zero_when_nothing_was_flagged():
    result = substitution_agreement([_row(level="phoneme")], "facebook")
    assert result.f1 == 0.0
    assert result.precision == 0.0
    assert result.recall == 0.0
    assert result.identity_accuracy == 0.0


def test_substitution_identity_ignores_the_stress_digit():
    rows = [_row(level="phoneme", human_sub="AA1", machine_sub="ɑː", machine_sub_arpabet="AA")]
    result = substitution_agreement(rows, "facebook")
    assert result.identity_matches == 1
```

**Step 2 — run it and watch it fail.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected failure:

```
E   ImportError: cannot import name 'SubstitutionAgreement' from 'correlate'
```

**Step 3 — implement.**

In `tools/calibration/correlate.py` add one import line under the `scipy` import:

```python
from arpabet_ipa import strip_stress
```

and append to the end of the file:

```python
@dataclass(frozen=True)
class SubstitutionAgreement:
    """How well the machine's `substituted` field tracks the human labels.

    `f1` measures *detection* (did the machine flag the same phones the raters
    flagged). `identity_accuracy` measures whether, having flagged one, it named
    the right replacement — the part a learner actually reads.
    """

    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    identity_matches: int
    identity_accuracy: float


def substitution_agreement(
    rows: list[dict[str, str]],
    model: str,
) -> SubstitutionAgreement:
    """Detection precision/recall/F1 plus identity accuracy over phoneme rows."""
    true_positives = 0
    false_positives = 0
    false_negatives = 0
    identity_matches = 0
    for row in rows:
        if row["model"] != model or row["level"] != "phoneme":
            continue
        human = row["human_sub"].strip()
        machine = row["machine_sub"].strip()
        if human and machine:
            true_positives += 1
            predicted = [
                phone for phone in row["machine_sub_arpabet"].split("+") if phone
            ]
            if strip_stress(human) in predicted:
                identity_matches += 1
        elif machine:
            false_positives += 1
        elif human:
            false_negatives += 1

    precision = (
        true_positives / (true_positives + false_positives)
        if true_positives + false_positives
        else 0.0
    )
    recall = (
        true_positives / (true_positives + false_negatives)
        if true_positives + false_negatives
        else 0.0
    )
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    identity_accuracy = identity_matches / true_positives if true_positives else 0.0
    return SubstitutionAgreement(
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=round(precision, 6),
        recall=round(recall, 6),
        f1=round(f1, 6),
        identity_matches=identity_matches,
        identity_accuracy=round(identity_accuracy, 6),
    )
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected: `14 passed`.

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/correlate.py tools/calibration/tests/test_correlate.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/correlate.py | Select-String -Pattern "def substitution_agreement"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): substitution detection and identity agreement metric"
```

---


### Task 10: The verdict — pass/fail thresholds, the §10 fallback, and model selection

This is the task that makes the harness *select* a model rather than merely describe one.

**Files:**
- Modify: `tools/calibration/correlate.py`
- Test: `tools/calibration/tests/test_correlate.py` (modify)

**Interfaces:**
- Produces:
  - `VERDICT_RANK: dict[str, int]` — `{"PASS": 0, "SUBSTITUTIONS_ONLY": 1}`
  - `@dataclass(frozen=True) class ModelVerdict` with fields
    `model: str, coverage: float, levels: dict[str, Correlation],
    substitutions: SubstitutionAgreement, verdict: str, show_numeric_scores: bool,
    reasons: tuple[str, ...]`
  - `def judge(rows: list[dict[str, str]], model: str) -> ModelVerdict`
  - `def select_model(verdicts: list[ModelVerdict]) -> ModelVerdict | None`
- Consumes: `correlate`, `coverage`, `pairs`, `substitution_agreement`, and the five threshold
  constants from Task 7.

**Step 1 — extend the test so it fails.**

Add to the `from correlate import (...)` block:

```python
    ModelVerdict,
    judge,
    select_model,
)
```

and append:

```python
def _utterance_rows(model, count, *, invert=False):
    rows = []
    for index in range(count):
        human = float(index * 2)
        machine = float((count - index) * 2) if invert else human
        rows.append(
            _row(
                model=model,
                level="utterance",
                utt_id=f"test-{index:05d}",
                human=str(human),
                machine=str(machine),
            )
        )
    return rows


def _phoneme_rows(model, count, *, invert=False, subs=0):
    rows = []
    for index in range(count):
        human = float(index)
        machine = float(count - index) if invert else human
        human_sub = "IY1" if index < subs else ""
        machine_sub = "iː" if index < subs else ""
        rows.append(
            _row(
                model=model,
                level="phoneme",
                utt_id=f"test-{index:05d}",
                word_index="0",
                phone_index=str(index),
                ipa="ɪ",
                arpabet="IH",
                human=str(human),
                machine=str(machine),
                human_sub=human_sub,
                machine_sub=machine_sub,
                machine_sub_arpabet="IY" if machine_sub else "",
            )
        )
    return rows


def test_a_well_correlated_model_passes_and_shows_numbers():
    rows = _utterance_rows("facebook", 40) + _phoneme_rows("facebook", 40)
    result = judge(rows, "facebook")
    assert isinstance(result, ModelVerdict)
    assert result.verdict == "PASS"
    assert result.show_numeric_scores is True
    assert result.coverage == pytest.approx(1.0)
    assert result.levels["utterance"].pearson_r == pytest.approx(1.0)


def test_low_coverage_disqualifies_before_correlation_is_considered():
    rows = _utterance_rows("mrrubino", 10) + [
        _row(
            model="mrrubino",
            level="error",
            utt_id=f"err-{index:05d}",
            human="",
            machine="",
            error_code="UNPRONOUNCEABLE_TEXT",
        )
        for index in range(40)
    ]
    result = judge(rows, "mrrubino")
    assert result.verdict == "DISQUALIFIED"
    assert result.show_numeric_scores is False
    assert any("coverage" in reason for reason in result.reasons)


def test_weak_correlation_with_usable_substitutions_falls_back_to_substitutions_only():
    rows = _utterance_rows("facebook", 40, invert=True) + _phoneme_rows(
        "facebook", 40, invert=True, subs=20
    )
    result = judge(rows, "facebook")
    assert result.verdict == "SUBSTITUTIONS_ONLY"
    assert result.show_numeric_scores is False
    assert result.substitutions.f1 == pytest.approx(1.0)
    assert any("fallback" in reason for reason in result.reasons)


def test_weak_correlation_and_weak_substitutions_fails_outright():
    rows = _utterance_rows("facebook", 40, invert=True) + _phoneme_rows(
        "facebook", 40, invert=True
    )
    result = judge(rows, "facebook")
    assert result.verdict == "FAIL"
    assert result.show_numeric_scores is False


def test_too_few_samples_never_passes():
    rows = _utterance_rows("facebook", 5) + _phoneme_rows("facebook", 5)
    result = judge(rows, "facebook")
    assert result.verdict != "PASS"
    assert any("samples" in reason for reason in result.reasons)


def test_select_model_prefers_pass_then_the_stronger_correlation():
    strong = judge(_utterance_rows("a", 40) + _phoneme_rows("a", 40), "a")
    fallback = judge(
        _utterance_rows("b", 40, invert=True) + _phoneme_rows("b", 40, invert=True, subs=20),
        "b",
    )
    assert select_model([fallback, strong]).model == "a"
    assert select_model([fallback]).model == "b"
    assert select_model([]) is None


def test_select_model_returns_none_when_every_candidate_failed():
    failed = judge(
        _utterance_rows("a", 40, invert=True) + _phoneme_rows("a", 40, invert=True), "a"
    )
    assert failed.verdict == "FAIL"
    assert select_model([failed]) is None
```

**Step 2 — run it and watch it fail.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected failure:

```
E   ImportError: cannot import name 'ModelVerdict' from 'correlate'
```

**Step 3 — implement.**

Append to `tools/calibration/correlate.py`:

```python
#: Only these two verdicts are selectable, best first.
VERDICT_RANK = {"PASS": 0, "SUBSTITUTIONS_ONLY": 1}


@dataclass(frozen=True)
class ModelVerdict:
    """The calibration answer for one acoustic model."""

    model: str
    coverage: float
    levels: dict[str, Correlation]
    substitutions: SubstitutionAgreement
    verdict: str
    show_numeric_scores: bool
    reasons: tuple[str, ...]


def judge(rows: list[dict[str, str]], model: str) -> ModelVerdict:
    """Apply the documented thresholds to one model's rows.

    Order matters: coverage first (a model that only scored the easy third of
    the corpus has a flattering r for the wrong reason), then the two
    correlation gates, then the design §10 substitutions-only fallback.
    """
    model_coverage = round(coverage(rows, model), 6)
    levels: dict[str, Correlation] = {}
    for level in sorted(
        {row["level"] for row in rows if row["model"] == model and row["level"] != "error"}
    ):
        human, machine = pairs(rows, model, level)
        levels[level] = correlate(human, machine)
    subs = substitution_agreement(rows, model)

    reasons: list[str] = []
    if model_coverage < PASS_MIN_COVERAGE:
        reasons.append(
            f"coverage {model_coverage:.2f} < {PASS_MIN_COVERAGE:.2f} — not enough of the corpus scored"
        )
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            levels=levels,
            substitutions=subs,
            verdict="DISQUALIFIED",
            show_numeric_scores=False,
            reasons=tuple(reasons),
        )

    passed = True
    utterance = levels.get("utterance")
    if utterance is None or utterance.n < MIN_SAMPLES:
        passed = False
        reasons.append(
            f"utterance samples {0 if utterance is None else utterance.n} < {MIN_SAMPLES}"
        )
    elif not utterance.pearson_r >= PASS_MIN_UTTERANCE_PEARSON:
        passed = False
        reasons.append(
            f"utterance pearson r {utterance.pearson_r} < {PASS_MIN_UTTERANCE_PEARSON}"
        )

    phoneme = levels.get("phoneme")
    if phoneme is None or phoneme.n < MIN_SAMPLES:
        passed = False
        reasons.append(f"phoneme samples {0 if phoneme is None else phoneme.n} < {MIN_SAMPLES}")
    elif not phoneme.spearman_rho >= PASS_MIN_PHONEME_SPEARMAN:
        passed = False
        reasons.append(
            f"phoneme spearman rho {phoneme.spearman_rho} < {PASS_MIN_PHONEME_SPEARMAN}"
        )

    if passed:
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            levels=levels,
            substitutions=subs,
            verdict="PASS",
            show_numeric_scores=True,
            reasons=("every threshold met",),
        )

    if subs.f1 >= FALLBACK_MIN_SUBSTITUTION_F1:
        reasons.append(
            f"substitution F1 {subs.f1} >= {FALLBACK_MIN_SUBSTITUTION_F1} — design §10 fallback: "
            "report substitutions, hide numeric scores"
        )
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            levels=levels,
            substitutions=subs,
            verdict="SUBSTITUTIONS_ONLY",
            show_numeric_scores=False,
            reasons=tuple(reasons),
        )

    reasons.append(f"substitution F1 {subs.f1} < {FALLBACK_MIN_SUBSTITUTION_F1}")
    return ModelVerdict(
        model=model,
        coverage=model_coverage,
        levels=levels,
        substitutions=subs,
        verdict="FAIL",
        show_numeric_scores=False,
        reasons=tuple(reasons),
    )


def select_model(verdicts: list[ModelVerdict]) -> ModelVerdict | None:
    """The best selectable model, or None when every candidate is unusable.

    PASS beats SUBSTITUTIONS_ONLY; within a tier the stronger utterance-level
    Pearson wins; the model label breaks remaining ties so the choice is
    reproducible.
    """
    eligible = [verdict for verdict in verdicts if verdict.verdict in VERDICT_RANK]
    if not eligible:
        return None

    def sort_key(verdict: ModelVerdict) -> tuple[int, float, str]:
        utterance = verdict.levels.get("utterance")
        r = utterance.pearson_r if utterance is not None else float("nan")
        if math.isnan(r):
            r = -2.0
        return (VERDICT_RANK[verdict.verdict], -r, verdict.model)

    return sorted(eligible, key=sort_key)[0]
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected: `21 passed`.

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/correlate.py tools/calibration/tests/test_correlate.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/correlate.py | Select-String -Pattern "def select_model"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): threshold verdicts, section-10 fallback and model selection"
```

---

### Task 11: The report and the CLI

**Files:**
- Modify: `tools/calibration/correlate.py`
- Test: `tools/calibration/tests/test_correlate.py` (modify)

**Interfaces:**
- Produces:
  - `def verdict_to_dict(verdict: ModelVerdict) -> dict` — JSON-safe (non-finite floats become `null`)
  - `def format_report(verdicts: list[ModelVerdict]) -> str`
  - `def main(argv: list[str] | None = None) -> int` — exit `0` when a model was selected, `1` otherwise
- Consumes: `argparse`, `json`, `dataclasses.asdict`.

**Step 1 — extend the test so it fails.**

Add to the `from correlate import (...)` block:

```python
    format_report,
    main,
    verdict_to_dict,
)
```

and append:

```python
import json  # noqa: E402


def test_verdict_to_dict_is_json_safe():
    verdict = judge(_utterance_rows("a", 5) + _phoneme_rows("a", 5), "a")
    payload = verdict_to_dict(verdict)
    encoded = json.dumps(payload)  # would raise on a NaN if we left one in
    assert '"model": "a"' in encoded
    assert payload["levels"]["utterance"]["n"] == 5
    assert payload["verdict"] == verdict.verdict


def test_format_report_names_every_model_and_its_verdict():
    strong = judge(_utterance_rows("facebook", 40) + _phoneme_rows("facebook", 40), "facebook")
    weak = judge(
        _utterance_rows("mrrubino", 40, invert=True) + _phoneme_rows("mrrubino", 40, invert=True),
        "mrrubino",
    )
    text = format_report([strong, weak])
    assert "facebook" in text
    assert "mrrubino" in text
    assert "PASS" in text
    assert "FAIL" in text
    assert "coverage" in text


def test_main_writes_a_verdict_file_and_exits_zero_on_a_selection(tmp_path, capsys):
    rows = _utterance_rows("facebook", 40) + _phoneme_rows("facebook", 40)
    path = _write_csv(tmp_path, rows)
    out = tmp_path / "verdict.json"

    code = main([str(path), "--out", str(out)])

    assert code == 0
    printed = capsys.readouterr().out
    assert "SELECTED: facebook" in printed
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["selected"] == "facebook"
    assert payload["showNumericScores"] is True
    assert payload["thresholds"]["passMinUtterancePearson"] == 0.6
    assert payload["models"][0]["model"] == "facebook"


def test_main_exits_one_when_no_model_is_selectable(tmp_path, capsys):
    rows = _utterance_rows("facebook", 40, invert=True) + _phoneme_rows(
        "facebook", 40, invert=True
    )
    path = _write_csv(tmp_path, rows)

    code = main([str(path), "--out", str(tmp_path / "verdict.json")])

    assert code == 1
    assert "SELECTED: none" in capsys.readouterr().out
```

**Step 2 — run it and watch it fail.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests/test_correlate.py -q
```

Expected failure:

```
E   ImportError: cannot import name 'format_report' from 'correlate'
```

**Step 3 — implement.**

In `tools/calibration/correlate.py` extend the import block:

```python
import argparse
import csv
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
```

and append to the end of the file:

```python
def _jsonable(value):
    """Recursively replace non-finite floats with None so json.dumps stays strict."""
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def verdict_to_dict(verdict: ModelVerdict) -> dict:
    """JSON-safe view of a ModelVerdict (NaN correlations become null)."""
    return _jsonable(asdict(verdict))


def format_report(verdicts: list[ModelVerdict]) -> str:
    """Human-readable calibration report, one block per model."""
    lines: list[str] = []
    for verdict in verdicts:
        lines.append(f"=== {verdict.model} — {verdict.verdict} ===")
        lines.append(
            f"  coverage {verdict.coverage:.3f}"
            f"   numeric scores: {'show' if verdict.show_numeric_scores else 'HIDE'}"
        )
        for level in sorted(verdict.levels):
            correlation = verdict.levels[level]
            lines.append(
                f"  {level:<13} n={correlation.n:<6}"
                f" pearson r={correlation.pearson_r:.3f} (p={correlation.pearson_p:.4f})"
                f" spearman rho={correlation.spearman_rho:.3f} (p={correlation.spearman_p:.4f})"
            )
        subs = verdict.substitutions
        lines.append(
            f"  substitutions  tp={subs.true_positives} fp={subs.false_positives}"
            f" fn={subs.false_negatives} f1={subs.f1:.3f}"
            f" identity={subs.identity_accuracy:.3f}"
        )
        for reason in verdict.reasons:
            lines.append(f"  - {reason}")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Exit 0 when a model was selected, 1 when none was."""
    parser = argparse.ArgumentParser(
        description="Correlate sidecar pronunciation scores against speechocean762 human scores."
    )
    parser.add_argument(
        "csv_paths",
        nargs="+",
        type=Path,
        help="one or more score CSVs written by run_calibration.py",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="verdict JSON path (default: verdict.json beside the first CSV)",
    )
    args = parser.parse_args(argv)

    rows: list[dict[str, str]] = []
    for path in args.csv_paths:
        rows.extend(load_rows(path))

    verdicts = [judge(rows, model) for model in models(rows)]
    chosen = select_model(verdicts)

    print(format_report(verdicts))
    print(f"SELECTED: {chosen.model if chosen else 'none'}")

    out = args.out or args.csv_paths[0].with_name("verdict.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "selected": chosen.model if chosen else None,
        "showNumericScores": bool(chosen and chosen.show_numeric_scores),
        "thresholds": {
            "passMinCoverage": PASS_MIN_COVERAGE,
            "passMinUtterancePearson": PASS_MIN_UTTERANCE_PEARSON,
            "passMinPhonemeSpearman": PASS_MIN_PHONEME_SPEARMAN,
            "fallbackMinSubstitutionF1": FALLBACK_MIN_SUBSTITUTION_F1,
            "minSamples": MIN_SAMPLES,
        },
        "models": [verdict_to_dict(verdict) for verdict in verdicts],
    }
    out.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return 0 if chosen else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

**Step 4 — run it and watch it pass.**

```powershell
tools/calibration/.venv/Scripts/python.exe -m pytest tools/calibration/tests -q
```

Expected: `39 passed` (14 mapping + 25 correlate).

**Step 5 — commit.**

```powershell
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e add tools/calibration/correlate.py tools/calibration/tests/test_correlate.py
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e show :tools/calibration/correlate.py | Select-String -Pattern "SELECTED:"
git -C C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e commit -m "feat(calibration): correlation report CLI with a machine-readable verdict"
```

---
