import { describe, it, expect, vi, beforeEach } from "vitest";
import { postPronAssess, getPronPrompts } from "./api.js";

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}
function errJson(status, body) {
  return { ok: false, status, json: async () => body };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("postPronAssess — request shape", () => {
  it("posts multipart audio/text/mode with a container-derived filename", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, pronProvider: "mock" }));
    const blob = new Blob(["take"], { type: "audio/ogg;codecs=opus" });

    await postPronAssess({ blob, text: "The ship is full of sheep." });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/pron/assess");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined(); // the browser owns the multipart boundary
    expect(init.body.get("text")).toBe("The ship is full of sheep.");
    expect(init.body.get("mode")).toBe("scripted");
    expect(init.body.get("audio").name).toBe("drill.ogg");
  });

  it("forwards an explicit mode", async () => {
    fetch.mockResolvedValue(okJson({ version: 1 }));
    await postPronAssess({ blob: new Blob(["x"]), text: "hi", mode: "unscripted" });
    expect(fetch.mock.calls[0][1].body.get("mode")).toBe("unscripted");
  });

  it("returns the parsed report on 200", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, pronProvider: "local", overall: { accuracy: 71 } }));
    const report = await postPronAssess({ blob: new Blob(["x"]), text: "hi" });
    expect(report.overall.accuracy).toBe(71);
  });
});

describe("postPronAssess — typed errors", () => {
  it("throws the server message and code", async () => {
    fetch.mockResolvedValue(
      errJson(422, { error: "Couldn't make out any speech in that recording.", code: "NO_SPEECH" }),
    );
    await expect(postPronAssess({ blob: new Blob(["x"]), text: "hi" })).rejects.toMatchObject({
      message: "Couldn't make out any speech in that recording.",
      code: "NO_SPEECH",
      status: 422,
    });
  });

  it("defaults to PRON_UNAVAILABLE and a generic message when the body is unreadable", async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });
    await expect(postPronAssess({ blob: new Blob(["x"]), text: "hi" })).rejects.toMatchObject({
      message: "Server error 502",
      code: "PRON_UNAVAILABLE",
      status: 502,
    });
  });
});

describe("getPronPrompts", () => {
  it("requests the full set when no focus is given", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, prompts: [] }));
    await getPronPrompts();
    expect(fetch).toHaveBeenCalledWith("/pron/prompts");
  });

  it("url-encodes the focus slug", async () => {
    fetch.mockResolvedValue(okJson({ version: 1, prompts: [] }));
    await getPronPrompts({ focus: "s-cluster" });
    expect(fetch).toHaveBeenCalledWith("/pron/prompts?focus=s-cluster");
  });

  it("throws the typed UNKNOWN_FOCUS error", async () => {
    fetch.mockResolvedValue(errJson(400, { error: 'Unknown "focus".', code: "UNKNOWN_FOCUS" }));
    await expect(getPronPrompts({ focus: "nope" })).rejects.toMatchObject({
      code: "UNKNOWN_FOCUS",
      status: 400,
    });
  });
});
