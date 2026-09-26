import { describe, it, expect } from "vitest";
import { detectPauses, voicedSpanMs, PAUSE_MIN_MS } from "./pauses.js";

const HOP_MS = 10;

/** Build a frame array in dB: segments of [durationMs, dbValue]. */
function frames(...segments) {
  const out = [];
  for (const [ms, db] of segments) {
    for (let i = 0; i < Math.round(ms / HOP_MS); i += 1) out.push(db);
  }
  return Float32Array.from(out);
}

describe("detectPauses", () => {
  it("finds exactly one pause when 400ms of silence sits between two tones", () => {
    const f = frames([1000, -20], [400, -70], [1000, -20]);
    const pauses = detectPauses(f, { hopMs: HOP_MS });
    expect(pauses).toHaveLength(1);
    expect(pauses[0].durationMs).toBeGreaterThanOrEqual(380);
    expect(pauses[0].durationMs).toBeLessThanOrEqual(420);
  });

  it("ignores a 240ms gap, which is below the floor", () => {
    const f = frames([1000, -20], [240, -70], [1000, -20]);
    expect(detectPauses(f, { hopMs: HOP_MS })).toHaveLength(0);
  });

  it("is gain invariant — halving every frame's amplitude changes nothing", () => {
    const loud = frames([1000, -20], [400, -70], [1000, -20]);
    const quiet = loud.map((db) => db - 6); // -6 dB == x0.5 amplitude
    expect(detectPauses(quiet, { hopMs: HOP_MS })).toEqual(detectPauses(loud, { hopMs: HOP_MS }));
  });

  it("returns nothing for an all-silent buffer (no speech to be silent between)", () => {
    expect(detectPauses(frames([2000, -70]), { hopMs: HOP_MS })).toHaveLength(0);
  });

  it("exposes the threshold as a named constant", () => {
    expect(PAUSE_MIN_MS).toBe(250);
  });
});

describe("voicedSpanMs", () => {
  it("spans first to last voiced hop, excluding leading and trailing silence", () => {
    // 1.5s waiting to start, 3s of speech with a pause inside, 2s waiting for the turn to end.
    const f = frames([1500, -70], [1000, -20], [400, -70], [1600, -20], [2000, -70]);
    expect(voicedSpanMs(f, { hopMs: HOP_MS })).toBe(3000);
  });

  it("uses the same floor as detectPauses, so it is gain invariant too", () => {
    const loud = frames([500, -70], [1000, -20], [500, -70]);
    const quiet = loud.map((db) => db - 6);
    expect(voicedSpanMs(quiet, { hopMs: HOP_MS })).toBe(voicedSpanMs(loud, { hopMs: HOP_MS }));
  });

  it("returns null when there is no speech/silence contrast to measure against", () => {
    expect(voicedSpanMs(frames([2000, -20]), { hopMs: HOP_MS })).toBeNull();
    expect(voicedSpanMs(frames([2000, -70]), { hopMs: HOP_MS })).toBeNull();
  });

  it("returns null for an empty buffer or a missing hop", () => {
    expect(voicedSpanMs(new Float32Array(0), { hopMs: HOP_MS })).toBeNull();
    expect(voicedSpanMs(frames([500, -70], [500, -20]), { hopMs: 0 })).toBeNull();
  });
});
