import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { MockPron } from "../pron/mock.js";
import { MAX_AUDIO_BYTES } from "../pron/contract.js";

const assess = vi.fn();
vi.mock("../pron/index.js", () => ({
  getPron: () => ({ assess: (...args) => assess(...args) }),
  currentPronProvider: () => "mock",
}));

import { createApp } from "../app.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  assess.mockReset();
  assess.mockImplementation((buffer, opts) => new MockPron().assess(buffer, opts));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /pron/prompts — the curated set", () => {
  it("returns the full set when focus is omitted", async () => {
    const res = await request(createApp()).get("/pron/prompts");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.focuses).toEqual([
      "ih-iy",
      "ae",
      "schwa",
      "v-b",
      "dzh",
      "s-cluster",
      "ed-ending",
    ]);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(21);
    expect(res.body.prompts[0]).toMatchObject({ id: "ih-iy-01", focus: "ih-iy" });
  });

  it("filters by focus and keeps the focus list complete", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=schwa");
    expect(res.status).toBe(200);
    expect(res.body.prompts.every((p) => p.focus === "schwa")).toBe(true);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(3);
    expect(res.body.focuses).toHaveLength(7);
  });

  it("treats an empty focus as no filter", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=");
    expect(res.status).toBe(200);
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(21);
  });

  it("rejects whitespace-only focus with UNKNOWN_FOCUS", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=%20");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
      code: "UNKNOWN_FOCUS",
    });
  });

  it("400s an unknown focus with a typed code and the valid values", async () => {
    const res = await request(createApp()).get("/pron/prompts?focus=nasal");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Unknown "focus". Valid values: ih-iy, ae, schwa, v-b, dzh, s-cluster, ed-ending.',
      code: "UNKNOWN_FOCUS",
    });
  });
});

const AUDIO = Buffer.alloc(16000 * 2 * 2, 7); // 2 s of pseudo-PCM
const TEXT = "The ship is full of sheep.";

function post(app) {
  return request(app).post("/pron/assess");
}

describe("POST /pron/assess — scripted scoring", () => {
  it("returns a full report tagged with the provider and the requested mode", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "drill.webm", contentType: "audio/webm" });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.mode).toBe("scripted");
    expect(res.body.pronProvider).toBe("mock");
    expect(res.body.model).toBe("mock");
    expect(res.body.overall).toEqual({
      accuracy: expect.any(Number),
      fluency: expect.any(Number),
      completeness: 100,
    });
    expect(res.body.prosody.f0MinHz).toBeNull();
    expect(res.body.words.map((w) => w.word)).toEqual([
      "The",
      "ship",
      "is",
      "full",
      "of",
      "sheep",
    ]);
    expect(res.body.words[0].phones.length).toBeGreaterThan(0);
  });

  it("forwards the trimmed text, the mode and the uploaded bytes to the provider", async () => {
    await post(createApp())
      .field("text", `  ${TEXT}  `)
      .attach("audio", AUDIO, { filename: "take-3.ogg", contentType: "audio/ogg" });

    const [buffer, opts] = assess.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBe(AUDIO.length);
    expect(opts).toEqual({ text: TEXT, mode: "scripted", filename: "take-3.ogg" });
  });

  it("400s an audio part with no filename — multer drops files with a falsy name before the handler runs", async () => {
    // form-data omits the `filename` attribute entirely when it's "" (form_data.js
    // `_getContentDisposition`), and multer's make-middleware.js unconditionally
    // does `if (!filename) return fileStream.resume()` — the part never becomes
    // req.file, so this can never reach the route's "default the filename"
    // fallback (server/src/routes/pron.js) — it 400s here instead.
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_AUDIO");
    expect(assess).not.toHaveBeenCalled();
  });
});

describe("POST /pron/assess — provider failures", () => {
  it("502s with PRON_UNAVAILABLE when the provider rejects", async () => {
    assess.mockRejectedValueOnce(new Error("boom"));

    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "drill.webm" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
    expect(res.body.detail).toBe("boom");
  });

  it("502s with BAD_REPORT when the provider resolves a report that fails validateReport", async () => {
    // Deliberately malformed: `words` is a required, non-empty array per the
    // schema in contract.js — omitting it is a genuine validateReport failure,
    // not a stand-in for one.
    assess.mockResolvedValueOnce({
      version: 1,
      mode: "scripted",
      model: "mock",
      overall: { accuracy: 90, fluency: 80, completeness: 100 },
      prosody: {
        speechRateWpm: 120,
        articulationRateSyllPerSec: 4,
        pauseCount: 0,
        pauseTotalSec: 0,
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
    });

    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "drill.webm" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("BAD_REPORT");
    expect(res.body.detail).toBe("report.words must be a non-empty array.");
  });
});

describe("POST /pron/assess — input rejections", () => {
  it("400s a request with no audio part", async () => {
    const res = await post(createApp()).field("text", TEXT);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing "audio" file.', code: "MISSING_AUDIO" });
    expect(assess).not.toHaveBeenCalled();
  });

  it("400s a zero-byte audio part", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", Buffer.alloc(0), { filename: "empty.webm" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_AUDIO");
  });

  it("400s a missing or blank reference sentence", async () => {
    const res = await post(createApp())
      .field("text", "   ")
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Missing "text" (the reference sentence, non-empty string).',
      code: "MISSING_TEXT",
    });
  });

  it("400s a sentence over 300 characters", async () => {
    const res = await post(createApp())
      .field("text", "a".repeat(301))
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TEXT_TOO_LONG");
  });

  it("400s an unknown mode", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .field("mode", "freestyle")
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: '"mode" must be "scripted" or "unscripted".',
      code: "INVALID_MODE",
    });
    expect(assess).not.toHaveBeenCalled();
  });

  it("413s an oversized upload instead of falling through to the 500 handler", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("audio", Buffer.alloc(MAX_AUDIO_BYTES + 1024), { filename: "huge.webm" });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: "That recording is too large. Keep drill takes under 15 MB.",
      code: "AUDIO_TOO_LARGE",
    });
    expect(assess).not.toHaveBeenCalled();
  });

  it("falls through to the global 500 handler for a non-size multer error (unexpected field name)", async () => {
    // multer's `single("audio")` rejects any file part whose fieldname isn't
    // "audio" with a LIMIT_UNEXPECTED_FILE MulterError. uploadSingleAudio only
    // special-cases LIMIT_FILE_SIZE, so this exercises its `next(err)` branch
    // and lands on app.js's generic error handler.
    const res = await post(createApp())
      .field("text", TEXT)
      .attach("notaudio", AUDIO, { filename: "drill.webm" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error." });
    expect(assess).not.toHaveBeenCalled();
  });
});

describe("POST /pron/assess — unscripted never carries phonemes (design §3)", () => {
  async function unscripted(app = createApp()) {
    return post(app)
      .field("text", TEXT)
      .field("mode", "unscripted")
      .attach("audio", AUDIO, { filename: "drill.webm" });
  }

  it("strips phones from every word", async () => {
    const res = await unscripted();
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("unscripted");
    expect(res.body.words.length).toBeGreaterThan(0);
    for (const word of res.body.words) {
      expect(word).not.toHaveProperty("phones");
    }
  });

  it("leaves no phone-shaped data anywhere in the serialized body", async () => {
    const res = await unscripted();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('"phones"');
    expect(raw).not.toContain('"ipa"');
    expect(raw).not.toContain('"substituted"');
  });

  it("keeps the word-level and overall numbers, which do not depend on phonemes", async () => {
    const res = await unscripted();
    for (const word of res.body.words) {
      expect(typeof word.word).toBe("string");
      expect(Number.isInteger(word.accuracy)).toBe(true);
      expect(word.end).toBeGreaterThanOrEqual(word.start);
    }
    expect(res.body.overall.completeness).toBe(100);
    expect(res.body.prosody.pauseCount).toBeGreaterThanOrEqual(0);
  });

  it("strips even when the provider ignores mode and returns phones anyway", async () => {
    assess.mockResolvedValue({
      version: 1,
      mode: "scripted",
      model: "rogue-provider",
      overall: { accuracy: 50, fluency: 50, completeness: 50 },
      prosody: {
        speechRateWpm: 100,
        articulationRateSyllPerSec: 4,
        pauseCount: 0,
        pauseTotalSec: 0,
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: [
        {
          word: "sheep",
          start: 0,
          end: 1,
          accuracy: 50,
          phones: [{ ipa: "iː", score: 12, start: 0, end: 1, substituted: "ɪ" }],
        },
      ],
    });

    const res = await unscripted();
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("substituted");
    expect(res.body.words[0]).toEqual({ word: "sheep", start: 0, end: 1, accuracy: 50 });
  });

  it("still returns phones in scripted mode — the strip is mode-gated, not global", async () => {
    const res = await post(createApp())
      .field("text", TEXT)
      .field("mode", "scripted")
      .attach("audio", AUDIO, { filename: "drill.webm" });
    expect(res.body.words[0].phones.length).toBeGreaterThan(0);
  });
});

function providerThrows(code, message = "boom") {
  assess.mockRejectedValue(Object.assign(new Error(message), code ? { code } : {}));
}

describe("POST /pron/assess — degradation ladder (design §7)", () => {
  async function scripted() {
    return post(createApp())
      .field("text", TEXT)
      .attach("audio", AUDIO, { filename: "drill.webm" });
  }

  it("502s with PRON_UNAVAILABLE when the sidecar is unreachable", async () => {
    providerThrows("PRON_UNAVAILABLE", "fetch failed");
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(
      "Pronunciation scoring is offline. The drill continues as listen-and-repeat.",
    );
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
    expect(res.body.detail).toBe("fetch failed");
    expect(console.error).toHaveBeenCalledWith("[pron/assess] provider error:", expect.any(Error));
  });

  it("502s with PRON_UNAVAILABLE when the failure carries no code at all", async () => {
    providerThrows(undefined, "TypeError: nope");
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
  });

  it("422s NO_SPEECH — silence is the learner's recording, not an outage", async () => {
    providerThrows("NO_SPEECH", "sidecar says silence");
    const res = await scripted();
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Couldn't make out any speech in that recording.",
      code: "NO_SPEECH",
      detail: "sidecar says silence",
    });
  });

  it("400s UNPRONOUNCEABLE_TEXT — the sentence is the problem, not the service", async () => {
    providerThrows("UNPRONOUNCEABLE_TEXT", "no tokens for 'xyzzy'");
    const res = await scripted();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Couldn't turn that sentence into phonemes. Try plain English words.",
      code: "UNPRONOUNCEABLE_TEXT",
      detail: "no tokens for 'xyzzy'",
    });
  });

  it("502s a sidecar code the Node layer does not map", async () => {
    providerThrows("DECODE_FAILED", "ffmpeg exit 1");
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PRON_UNAVAILABLE");
    expect(res.body.detail).toBe("ffmpeg exit 1");
  });

  it("502s BAD_REPORT when the provider returns something the contract rejects", async () => {
    assess.mockResolvedValue({ version: 1, overall: {}, words: [] });
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("The pronunciation scorer returned an unreadable report.");
    expect(res.body.code).toBe("BAD_REPORT");
    expect(res.body.detail).toContain("report.overall");
  });

  it("502s BAD_REPORT when a provider emits substituted: null", async () => {
    assess.mockResolvedValue({
      version: 1,
      mode: "scripted",
      model: "rogue",
      overall: { accuracy: 50, fluency: 50, completeness: 50 },
      prosody: {
        speechRateWpm: 100,
        articulationRateSyllPerSec: 4,
        pauseCount: 0,
        pauseTotalSec: 0,
        f0MinHz: null,
        f0MaxHz: null,
        f0RangeSemitones: null,
      },
      words: [
        {
          word: "sheep",
          start: 0,
          end: 1,
          accuracy: 50,
          phones: [{ ipa: "iː", score: 90, start: 0, end: 1, substituted: null }],
        },
      ],
    });
    const res = await scripted();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("BAD_REPORT");
  });

  it("logs exactly one provider error per failed request", async () => {
    providerThrows("PRON_UNAVAILABLE");
    await scripted();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
