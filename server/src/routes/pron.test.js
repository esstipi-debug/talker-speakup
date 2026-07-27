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
});
