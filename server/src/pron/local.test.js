import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalPron } from "./local.js";

const AUDIO = Buffer.from("fake-webm-bytes");

function response(body, { status = 200, statusText = "OK" } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

beforeEach(() => {
  delete process.env.PRON_URL;
  delete process.env.PRON_TIMEOUT_MS;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local — configuration", () => {
  it("defaults to http://localhost:8899 with a 30 s timeout", () => {
    const pron = new LocalPron();
    expect(pron.baseUrl).toBe("http://localhost:8899");
    expect(pron.timeoutMs).toBe(30000);
  });

  it("strips trailing slashes from PRON_URL and parses PRON_TIMEOUT_MS", () => {
    process.env.PRON_URL = "  http://pron.local:9000///  ";
    process.env.PRON_TIMEOUT_MS = "5000";
    const pron = new LocalPron();
    expect(pron.baseUrl).toBe("http://pron.local:9000");
    expect(pron.timeoutMs).toBe(5000);
  });

  it("falls back to the default timeout when PRON_TIMEOUT_MS is not a number", () => {
    process.env.PRON_TIMEOUT_MS = "soon";
    expect(new LocalPron().timeoutMs).toBe(30000);
  });
});

describe("local — assess", () => {
  it("POSTs multipart audio/text/mode to /assess and returns the parsed report", async () => {
    const report = { version: 1, mode: "scripted", model: "facebook/x" };
    fetch.mockResolvedValue(response(report));

    const result = await new LocalPron().assess(AUDIO, { text: "the ship", mode: "unscripted" });

    expect(result).toEqual(report);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://localhost:8899/assess");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("text")).toBe("the ship");
    expect(init.body.get("mode")).toBe("unscripted");
    expect(init.body.get("audio").name).toBe("drill.webm");
    expect(init.body.get("audio").size).toBe(AUDIO.length);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults the mode to scripted and honours a caller-supplied filename", async () => {
    fetch.mockResolvedValue(response({ version: 1 }));
    await new LocalPron().assess(AUDIO, { text: "hi", filename: "take.ogg" });
    const form = fetch.mock.calls[0][1].body;
    expect(form.get("mode")).toBe("scripted");
    expect(form.get("audio").name).toBe("take.ogg");
  });

  it("maps a 422 NO_SPEECH body to a typed error carrying the sidecar's message", async () => {
    fetch.mockResolvedValue(
      response(
        { error: "Couldn't make out any speech in that recording.", code: "NO_SPEECH" },
        { status: 422, statusText: "Unprocessable Entity" },
      ),
    );
    await expect(new LocalPron().assess(AUDIO, { text: "hi" })).rejects.toMatchObject({
      code: "NO_SPEECH",
      message: "Couldn't make out any speech in that recording.",
    });
  });

  it("maps a 400 UNPRONOUNCEABLE_TEXT body to a typed error", async () => {
    fetch.mockResolvedValue(
      response(
        { error: "Couldn't turn that sentence into phonemes.", code: "UNPRONOUNCEABLE_TEXT" },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    await expect(new LocalPron().assess(AUDIO, { text: "xyzzy" })).rejects.toMatchObject({
      code: "UNPRONOUNCEABLE_TEXT",
    });
  });

  it("treats a code the Node layer does not know as PRON_UNAVAILABLE", async () => {
    fetch.mockResolvedValue(
      response({ error: "model cold", code: "MODEL_UNAVAILABLE" }, { status: 503, statusText: "Service Unavailable" }),
    );
    const error = await new LocalPron()
      .assess(AUDIO, { text: "hi" })
      .catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
    expect(error.message).toContain("Pron sidecar 503 Service Unavailable");
    expect(error.message).toContain("model cold");
  });

  it("caps the echoed upstream detail at 200 characters", async () => {
    fetch.mockResolvedValue(response("x".repeat(5000), { status: 500, statusText: "Internal Server Error" }));
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.message.length).toBeLessThan(260);
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });

  it("tags a refused connection as PRON_UNAVAILABLE without swallowing it", async () => {
    fetch.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: "ECONNREFUSED" }));
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.message).toBe("fetch failed");
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });

  it("tags an abort as PRON_UNAVAILABLE so the route degrades to listen-and-repeat", async () => {
    fetch.mockRejectedValue(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.name).toBe("AbortError");
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });

  it("aborts the request once the timeout elapses", async () => {
    process.env.PRON_TIMEOUT_MS = "10";
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const error = await new LocalPron().assess(AUDIO, { text: "hi" }).catch((err) => err);
    expect(error.code).toBe("PRON_UNAVAILABLE");
  });
});

describe("local — health", () => {
  it("GETs /health and returns the parsed body", async () => {
    const body = { status: "ok", model: "facebook/x", alignAvailable: true, ts: 1 };
    fetch.mockResolvedValue(response(body));
    expect(await new LocalPron().health()).toEqual(body);
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:8899/health");
  });

  it("throws on a non-OK health response instead of reporting the sidecar as up", async () => {
    fetch.mockResolvedValue(response("down", { status: 500, statusText: "Internal Server Error" }));
    await expect(new LocalPron().health()).rejects.toThrow(
      "Pron sidecar 500 Internal Server Error — down",
    );
  });
});
