import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { app } from "../src/app.js";
import { __resetForTests } from "../src/config/mode.js";

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("GET /health — mode", () => {
  it("publishes the mode block alongside the existing slots", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode).toMatchObject({
      requested: expect.any(String),
      effective: expect.any(String),
      degraded: expect.any(Boolean),
    });
    expect(Array.isArray(body.mode.reasons)).toBe(true);
  });

  it("reports auto under the test run, which sets no mode", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.requested).toBe("auto");
  });

  it("is not degraded under auto, whatever the providers resolved to", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.degraded).toBe(false);
    expect(body.mode.reasons).toEqual([]);
  });

  it("leaves every pre-existing health field intact", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    for (const key of ["status", "brain", "tts", "stt", "pron", "feedback", "sources", "ts"]) {
      expect(body).toHaveProperty(key);
    }
  });

  it("stays coherent after the opener turn synthesizes, before the learner has spoken", async () => {
    const openRes = await fetch(`${base}/turn/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(openRes.status).toBe(200);
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.mode.requested).toBe("auto");
    expect(body.mode.degraded).toBe(false);
    expect(Array.isArray(body.mode.reasons)).toBe(true);
  });
});

/**
 * The test above proves the opener path doesn't break anything, but under
 * `auto` the "tts-unreachable" reason is gated off entirely (mode.js only
 * reports it when `requested !== "auto"`), so it cannot distinguish "the
 * opener called noteTTSOutcome" from "the opener never touched mode.js at
 * all". This block forces `hybrid` so the reason is reachable, and fails the
 * real Kokoro HTTP call (never the TTS factory) so /turn/open's own
 * synthesis — not a mock standing in for it — is what noteTTSOutcome
 * observes.
 */
describe("GET /health — mode reflects the opener's real synthesis outcome (forced hybrid)", () => {
  // Matches KokoroTTS's own default (server/src/tts/kokoro.js) so the stub
  // targets exactly the URL the already-memoized Kokoro instance calls.
  const KOKORO_BASE = (process.env.KOKORO_URL?.trim() || "http://localhost:8880/v1").replace(/\/+$/, "");
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    // Restore fetch and the mode so every other test in this file — which
    // asserts requested === "auto" — is unaffected by this block, even if an
    // assertion above throws.
    global.fetch = originalFetch;
    delete process.env.SPEAKUP_MODE;
    __resetForTests();
  });

  it("reports tts-unreachable when the opener's synthesis fails, and clears it once the opener next succeeds", async () => {
    process.env.SPEAKUP_MODE = "hybrid";
    __resetForTests();

    // Reject only the Kokoro transport call; every other request (including
    // this test's own fetches against the app under test) goes through the
    // real fetch untouched.
    global.fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input.url;
      if (href.startsWith(KOKORO_BASE)) {
        return new Response("kokoro down", { status: 503, statusText: "Service Unavailable" });
      }
      return originalFetch(input, init);
    };

    const failedOpen = await fetch(`${base}/turn/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(failedOpen.status).toBe(200); // TTS failure never breaks the turn

    const degradedHealth = await fetch(`${base}/health`);
    const degradedBody = await degradedHealth.json();
    expect(degradedBody.mode.requested).toBe("hybrid");
    expect(degradedBody.mode.reasons).toContain("tts-unreachable");

    // Now let the same transport succeed and confirm the flag clears — a
    // failure-only test would miss a stuck-degraded flag.
    global.fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input.url;
      if (href.startsWith(KOKORO_BASE)) {
        return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      return originalFetch(input, init);
    };

    const recoveredOpen = await fetch(`${base}/turn/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(recoveredOpen.status).toBe(200);

    const recoveredHealth = await fetch(`${base}/health`);
    const recoveredBody = await recoveredHealth.json();
    expect(recoveredBody.mode.reasons).not.toContain("tts-unreachable");
  });
});
