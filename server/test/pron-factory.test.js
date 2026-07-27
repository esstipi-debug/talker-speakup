import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPron, currentPronProvider, __resetForTests } from "../src/pronunciation/index.js";

const ORIGINAL = process.env.PRONUNCIATION_PROVIDER;

beforeEach(() => { __resetForTests(); });
afterAll(() => { process.env.PRONUNCIATION_PROVIDER = ORIGINAL; });

describe("pronunciation factory", () => {
  it("defaults to none when nothing is configured", () => {
    delete process.env.PRONUNCIATION_PROVIDER;
    expect(currentPronProvider()).toBe("none");
    expect(getPron()).toBeNull();
  });

  it("returns a scorer for the mock provider", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    expect(currentPronProvider()).toBe("mock");
    const result = await getPron().score(Buffer.alloc(16), "hello world");
    expect(result.scored).toBe(true);
    expect(result.words.map((w) => w.word)).toEqual(["hello", "world"]);
  });

  it("gives the mock provider stress digits, because that is the whole point of the phone tier", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const result = await getPron().score(Buffer.alloc(16), "hello");
    expect(result.words[0].phones.some((p) => /[012]$/.test(p.label))).toBe(true);
  });

  it("is deterministic — the same input twice gives byte-identical output", async () => {
    process.env.PRONUNCIATION_PROVIDER = "mock";
    const a = await getPron().score(Buffer.alloc(16), "hello world");
    const b = await getPron().score(Buffer.alloc(16), "hello world");
    expect(a).toEqual(b);
  });

  it("treats an unknown provider name as none rather than throwing", () => {
    process.env.PRONUNCIATION_PROVIDER = "nonsense";
    expect(currentPronProvider()).toBe("none");
    expect(getPron()).toBeNull();
  });
});
