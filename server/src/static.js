import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Vite build output: server/src -> <repo>/client/dist. */
export function clientDistDir() {
  return path.resolve(HERE, "..", "..", "client", "dist");
}

/**
 * Serves the built client from the same origin as the API, so the client's
 * relative paths need no base URL and no CORS (spec D1, D2).
 *
 * Gated on index.html existing rather than on an env flag: app.js is imported
 * directly by the test suite and there is no build in dev, so "no build" is a
 * supported state, not an error (spec D3). There is no variable to forget.
 *
 * Returns true when it mounted.
 */
export function mountClient(app, dir = clientDistDir()) {
  const indexHtml = path.join(dir, "index.html");
  if (!existsSync(indexHtml)) return false;

  app.use(express.static(dir));

  // GET only, and a RegExp because Express 5 rejects the bare "*" path.
  // Restricting the method leaves POST mismatches to the 404 handler instead
  // of answering an API call with HTML (spec §5).
  app.get(/.*/, (_req, res) => res.sendFile(indexHtml));

  // Anything that reaches here is a non-GET request to a path with no route
  // (e.g. a mistaken POST). Answer a plain 404 instead of letting Express's
  // default handler send its HTML error page, which would look like the
  // client responding to an API call.
  app.use((_req, res) => res.status(404).end());

  return true;
}
