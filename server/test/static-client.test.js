import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/app.js";
import { mountClient, clientDistDir } from "../src/static.js";

/**
 * The fixture is a throwaway directory shaped like a Vite build. It is mounted
 * on a FRESH express app rather than on the real one, because the real app
 * mounts at import time and its build state depends on whether the developer
 * happens to have run `npm run build`.
 */
let fixtureDir;
let fixtureServer;
let fixtureBase;

let apiServer;
let apiBase;

beforeAll(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "speakup-dist-"));
  writeFileSync(path.join(fixtureDir, "index.html"), "<!doctype html><title>SpeakUp</title>");
  mkdirSync(path.join(fixtureDir, "assets"));
  writeFileSync(path.join(fixtureDir, "assets", "app-abc123.js"), "console.log('built');");

  const fixtureApp = express();
  fixtureApp.get("/health", (_req, res) => res.json({ status: "ok" }));
  mountClient(fixtureApp, fixtureDir);
  fixtureServer = fixtureApp.listen(0);
  await new Promise((resolve) => fixtureServer.once("listening", resolve));
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

  apiServer = app.listen(0);
  await new Promise((resolve) => apiServer.once("listening", resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => fixtureServer.close(resolve));
  await new Promise((resolve) => apiServer.close(resolve));
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("mountClient", () => {
  it("refuses to mount when there is no index.html", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "speakup-empty-"));
    try {
      expect(mountClient(express(), emptyDir)).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("mounts when a build is present", () => {
    expect(mountClient(express(), fixtureDir)).toBe(true);
  });

  it("resolves the build directory to client/dist at the repo root", () => {
    expect(clientDistDir().replace(/\\/g, "/")).toMatch(/\/client\/dist$/);
  });
});

describe("the mounted client", () => {
  it("serves index.html at the root", async () => {
    const res = await fetch(`${fixtureBase}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SpeakUp");
  });

  it("serves hashed assets", async () => {
    const res = await fetch(`${fixtureBase}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("built");
  });

  it("falls back to index.html for an unknown GET, so client routes survive a reload", async () => {
    const res = await fetch(`${fixtureBase}/some/deep/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SpeakUp");
  });

  it("does not intercept a GET that a real route already answers", async () => {
    const res = await fetch(`${fixtureBase}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("never answers a POST with HTML — method mismatches stay 404", async () => {
    const res = await fetch(`${fixtureBase}/some/deep/route`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});

describe("the real app", () => {
  /**
   * Build-state independent on purpose: these hold whether or not the
   * developer has run `npm run build`, which is exactly what makes them
   * non-flaky.
   */
  it("still answers /health with JSON", async () => {
    const res = await fetch(`${apiBase}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("still answers a bad POST /turn with a JSON 400, never HTML", async () => {
    const res = await fetch(`${apiBase}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
