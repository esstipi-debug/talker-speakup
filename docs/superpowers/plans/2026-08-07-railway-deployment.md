# Railway Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy SpeakUp as one Railway service that serves both the API and the built client over HTTPS, with the SQLite ledger surviving deploys, reachable from an Android phone.

**Architecture:** Express gains a static mount for `client/dist`, gated on the build existing so dev and tests are untouched. Root npm scripts teach Railway's builder how to handle a non-workspace monorepo. SQLite moves onto a Railway Volume, with migrations applied at container start.

**Tech Stack:** Node ≥22, Express 5.2, Vite 8, Prisma 6 + SQLite, Vitest (node environment, native `fetch`, no supertest), Railway (GitHub-connected service + Volume).

**Spec:** [`docs/superpowers/specs/2026-08-07-railway-deployment-design.md`](../specs/2026-08-07-railway-deployment-design.md)

## Global Constraints

- **Express 5.** `app.get("*")` throws at registration in Express 5 — path-to-regexp v8 rejects the bare `*`. Use a RegExp (`/.*/`) for catch-all routes.
- **Tests use native `fetch` against `app.listen(0)`.** No supertest. Follow `server/test/health.test.js`.
- **The static mount is gated on `client/dist/index.html` existing, never on an env flag** (spec D3). `app.js` is imported directly by the server suite.
- **`start` must not use `--env-file`** (spec D4). Node exits on a missing `--env-file` target and Railway writes no `.env`. `dev` keeps it.
- **Migrations run at start, never at build** (spec D6). The Volume is not mounted during the build phase.
- **No authentication, and `cors()` is left exactly as it is** (spec D7). Do not add auth, rate limiting, or CORS tightening in this plan.
- **`TTS_PROVIDER=browser`** (spec D8). No Kokoro service.
- **Node floor is `>=22`**, declared in both `package.json` and `server/package.json`.
- **`npm ci`, not `npm install`, in the build script.** Both `client/package-lock.json` and `server/package-lock.json` exist, so `ci` is reproducible.
- The stale test count in the README's Tests section is **not** this plan's job — it belongs to the provider-modes plan, which edits that same section.

---

### Task 1: Serve the client build from Express

**Files:**
- Create: `server/src/static.js`
- Modify: `server/src/app.js:41` (after the routers, before the error handler)
- Test: `server/test/static-client.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `clientDistDir(): string` — absolute path to `<repo>/client/dist`
  - `mountClient(app: express.Application, dir?: string): boolean` — returns `true` when it mounted, `false` when there is no build

- [ ] **Step 1: Write the failing test**

Create `server/test/static-client.test.js`:

```js
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

  it("does not let a POST reach the SPA fallback", async () => {
    const res = await fetch(`${fixtureBase}/some/deep/route`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SpeakUp");
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix server test -- static-client
```

Expected: FAIL — `Failed to resolve import "../src/static.js"`.

- [ ] **Step 3: Write the implementation**

Create `server/src/static.js`:

```js
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

  return true;
}
```

- [ ] **Step 4: Wire it into the app**

In `server/src/app.js`, add the import beside the existing router imports:

```js
import { mountClient } from "./static.js";
```

and insert the call between `app.use("/patterns", patternsRouter);` and the error handler:

```js
app.use("/patterns", patternsRouter);

// Serves client/dist when a build exists (production). A no-op in dev and in
// tests, where there is none — spec D3.
mountClient(app);

// Fallback error handler so nothing crashes the single-user server.
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm --prefix server test
```

Expected: PASS, including every pre-existing server test.

- [ ] **Step 6: Commit**

```bash
git add server/src/static.js server/src/app.js server/test/static-client.test.js
git commit -m "feat(server): serve the client build from the API origin"
```

---

### Task 2: Teach the build and start scripts to run on Railway

**Files:**
- Modify: `package.json` (root — add `build`, `start`, `engines`)
- Modify: `server/package.json` (rewrite `start`, add `engines`, move `prisma` to `dependencies`)
- Test: none — verified by running the real build and the full suite (see Steps 3 and 4)

**Interfaces:**
- Consumes: `mountClient` from Task 1, indirectly — the build is what makes it mount.
- Produces: `npm run build` and `npm start` at the repo root, which are the two commands Railway invokes.

- [ ] **Step 1: Edit the root `package.json`**

Add `engines` after `"description"`, and two scripts. The full scripts block becomes:

```json
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "concurrently -k -n server,client -c magenta,cyan \"npm --prefix server run dev\" \"npm --prefix client run dev\"",
    "dev:server": "npm --prefix server run dev",
    "dev:client": "npm --prefix client run dev",
    "build": "npm ci --prefix server && npm ci --prefix client && npm --prefix server run prisma:generate && npm --prefix client run build",
    "start": "npm --prefix server run start",
    "test": "npm --prefix client test && npm --prefix server test",
    "install:all": "npm install && npm --prefix server install && npm --prefix client install",
    "prisma:migrate": "npm --prefix server run prisma:migrate",
    "prisma:generate": "npm --prefix server run prisma:generate",
    "prisma:studio": "npm --prefix server run prisma:studio"
  },
```

`prisma generate` runs here, on Railway, rather than being carried from the developer's machine: the query engines are platform-specific and the developer's machine is Windows.

- [ ] **Step 2: Edit `server/package.json`**

Three changes:

1. Rewrite `start` — it drops `--env-file=.env` and gains the migration. `dev` is untouched:

```json
    "dev": "node --env-file=.env --watch src/index.js",
    "start": "prisma migrate deploy && node src/index.js",
```

2. Add `engines` above `scripts`:

```json
  "engines": {
    "node": ">=22"
  },
```

3. Move `"prisma": "^6.19.3"` out of `devDependencies` and into `dependencies`, keeping both lists alphabetical:

```json
  "dependencies": {
    "@prisma/client": "^6.19.3",
    "cors": "^2.8.6",
    "express": "^5.2.1",
    "fast-xml-parser": "^5.10.1",
    "harper.js": "2.7.0",
    "multer": "^2.2.0",
    "prisma": "^6.19.3"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.1.10",
    "supertest": "^7.2.2",
    "vitest": "^4.1.10"
  }
```

`migrate deploy` runs at container start, after any dev-dependency pruning a build may perform (spec D5).

- [ ] **Step 3: Refresh the lockfile and run the real build**

```bash
npm install --prefix server && npm run build
```

Expected: `server/package-lock.json` updates to reflect the moved dependency, and `client/dist/index.html` exists when the command finishes.

- [ ] **Step 4: Verify the build did not break the suite**

```bash
npm test
```

Expected: PASS. Note that `client/dist` now exists locally, so the real `app` *does* mount the client during this run — the Task 1 assertions were written to be build-state independent precisely so this passes either way.

- [ ] **Step 5: Verify the production start command locally**

PowerShell, from the repo root:

```bash
$env:DATABASE_URL="file:./dev.db"; npm start
```

Expected: `prisma migrate deploy` reports the database is already up to date, the server logs its providers, and <http://localhost:3001> serves the built client — not a 404. Stop it with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add package.json server/package.json server/package-lock.json
git commit -m "build: root build/start scripts and a Node floor for deployment"
```

---

### Task 3: Document the deployment and correct the privacy claim

**Files:**
- Modify: `README.md` — the "Why this exists" paragraph, Principle 1, and a new "Deploy" section after "Quick start"
- Modify: `server/.env.example` — a commented Railway block

**Interfaces:**
- Consumes: the scripts from Task 2 and the env var names below.
- Produces: nothing code-facing.

This task exists because the deployment makes a README claim false (spec §9). It is not optional polish.

- [ ] **Step 1: Correct the claim in "Why this exists"**

Find this sentence:

> The transcript, the database, and the grammar pass never leave your machine.

Replace it with:

> Run locally — the default — and the transcript, the database, and the grammar pass never leave your machine. Deployed (see [Deploy](#deploy)), they live on the host instead; that trade is the price of reaching it from a phone.

- [ ] **Step 2: Correct Principle 1**

Find:

> 1. **Local-first, honestly scoped.** The transcript, the database, and the grammar pass stay on your
>    machine.

Replace the first sentence of that principle with:

> 1. **Local-first, honestly scoped.** On a local run the transcript, the database, and the grammar
>    pass stay on your machine. A deployed instance moves all three onto the host — local-first is the
>    default, not a guarantee that survives being put on the internet.

- [ ] **Step 3: Add the Deploy section**

Insert after the "Turning on the good stuff" subsection and before "## Tests":

````markdown
### Deploy

One Railway service, connected to the GitHub repo, plus a Volume. The service serves the API **and**
the built client from the same origin, so there is no CORS and no API base URL to inject.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Start command | `npm start` |
| Volume mount path | `/data` |

Variables, in the Railway dashboard:

```
MISTRAL_API_KEY=sk-...
TTS_PROVIDER=browser
DATABASE_URL=file:/data/speakup.db
```

`PORT` is injected by Railway. `BRAIN_PROVIDER` is unnecessary — with the key present, auto-detection
resolves Mistral on its own.

`TTS_PROVIDER=browser` is deliberate: the phone already has voices, and a Kokoro container would mean
a second service running CPU inference for a worse trade.

**What a deployed instance is not:** it has no authentication, no accounts and no isolation. The URL
is public, and anyone who finds it spends the API key and writes to the ledger. A spend limit on the
Mistral account is the mitigation. Two devices on the same URL share one ledger.

**The mic works on Chrome for Android** — Railway serves HTTPS, which both `getUserMedia` and Web
Speech require. iOS routes every browser through WebKit, where continuous recognition is doubtful;
the text input is still a first-class path there, but that is not speaking practice.
````

- [ ] **Step 4: Add the Railway block to `server/.env.example`**

Append at the end of the file:

```
# --- Deployment (Railway) ---
# Set these in the Railway dashboard, not in a file — the deployed service has
# no .env and `npm start` deliberately does not pass --env-file.
#   TTS_PROVIDER=browser
#   DATABASE_URL=file:/data/speakup.db   # absolute, on the mounted Volume
# PORT is injected by the platform and already read by src/index.js.
```

- [ ] **Step 5: Verify the README renders and the links resolve**

Confirm the new `#deploy` anchor matches the link added in Step 1, and that the table and both fenced
blocks render. Read the section start to finish once — this is documentation whose only failure mode
is being wrong.

- [ ] **Step 6: Commit**

```bash
git add README.md server/.env.example
git commit -m "docs: deployment section, and scope the local-first claim to local runs"
```

---

### Task 4: Provision the Railway service and smoke-test from the phone

**Files:** none — this task is dashboard work plus verification against the running deployment.

**Interfaces:**
- Consumes: `npm run build` / `npm start` (Task 2) and the variable names (Task 3).
- Produces: a public HTTPS URL.

- [ ] **Step 1: Push the branch and merge to `main`**

Railway deploys a branch. Land the three commits first:

```bash
git push -u origin claude/proyecto-hibrido-estado-293183
```

Then merge to `main` through the project's normal flow.

- [ ] **Step 2: Create the service**

In Railway: **New Project → Deploy from GitHub repo → `esstipi-debug/talker-speakup`**. Pick the
branch that holds this work.

- [ ] **Step 3: Set the build and start commands**

Service → **Settings → Build**: build command `npm run build`. **Settings → Deploy**: start command
`npm start`. Railway's builder auto-detects npm, but setting both explicitly removes the guess.

- [ ] **Step 4: Add the Volume**

Service → **Volumes → Add Volume**, mount path `/data`. Do this *before* the first successful boot:
without it, `DATABASE_URL` points at an ephemeral path and the ledger resets on every deploy.

- [ ] **Step 5: Set the variables**

Service → **Variables**:

```
MISTRAL_API_KEY=<the key>
TTS_PROVIDER=browser
DATABASE_URL=file:/data/speakup.db
```

Do not set `PORT` — Railway injects it.

- [ ] **Step 6: Deploy and read the logs**

Expected in order: the build installs both packages, `prisma generate` runs, Vite builds, then at
start `prisma migrate deploy` applies the seven migrations to a fresh database on the Volume, and
finally the boot line `[server] SpeakUp API → http://localhost:<port> (brain: mistral, voice:
browser, stt: none, pron: none)`.

If it crash-loops on Prisma, the Volume is missing or unwritable — that failure is by design (spec §6).

- [ ] **Step 7: Smoke-test from the desktop**

Open `https://<service>.up.railway.app/health`. Expected: JSON with `"brain": "mistral"` and
`"tts": "browser"`. Then open the root URL and confirm the app renders rather than a 404 — that is
Task 1's mount proving itself in production.

- [ ] **Step 8: Smoke-test from the Android phone**

On Chrome for Android, open the same URL and walk the loop end to end:

1. The coach's opening line appears (it does not autoplay — that is correct, `useConversation.js:129`)
2. Tap the mic; the interim transcript updates as you speak
3. Tap stop; the transcript appears for review and editing
4. Send; the coach replies and speaks in the phone's voice
5. Tap the mic mid-reply and confirm barge-in cuts the audio
6. Open the Patterns panel and confirm it returns rows rather than a fetch error

- [ ] **Step 9: Confirm the ledger survives a deploy**

Trigger a redeploy from the dashboard. When it is back up, open Patterns again: the rows from Step 8
must still be there. If they are gone, the Volume is not mounted where `DATABASE_URL` points.

- [ ] **Step 10: Record the outcome**

Append what actually happened — especially anything that failed on the phone — to
[`docs/superpowers/plans/voice-io-verification-checklist.md`](voice-io-verification-checklist.md),
which is where this project tracks human-verification debt. Then commit.

```bash
git add docs/superpowers/plans/voice-io-verification-checklist.md
git commit -m "docs: record the Railway deployment smoke test"
```

---

## Self-review notes

**Spec coverage.** D1/D2 → Task 4 Steps 2-5 and Task 1. D3 → Task 1 Steps 1, 3. D4 → Task 2 Step 2.
D5 → Task 2 Step 2.3. D6 → Task 2 Step 2.1. D7 → recorded in Global Constraints and Task 3 Step 3;
no code. D8 → Task 3 Step 3 and Task 4 Step 5. Spec §5 route order → Task 1 Step 4. §6 persistence →
Task 4 Steps 4, 9. §7 failure modes → covered by Task 1's tests and Task 4 Step 6. §8 testing →
Task 1. §9 honest claims → Task 3 Steps 1-3.

**Deferred items resolved.** The spec's §10 left four open: `npm ci` vs `npm install` → `ci`, both
lockfiles exist. Engines floor → `>=22`. Where the privacy caveat lands → both README sites, Task 3
Steps 1-2. Whether `.env.example` gains a Railway block → yes, Task 3 Step 4.

**Known interaction with the provider-modes plan.** That plan edits the same README Tests section and
adds `server/src/config/**` to the coverage gate. Neither touches a file this plan creates, so the
order is free — but if modes lands first, re-read Task 3's anchors before editing.
