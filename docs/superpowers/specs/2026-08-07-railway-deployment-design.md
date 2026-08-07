# Railway Deployment — Design Spec

**Date:** 2026-08-07
**Status:** design approved, implementation plan not yet written
**Depends on:** nothing
**Relates to:** [provider modes](2026-08-07-provider-modes-design.md) — independent. Railway's
configuration is what that spec calls `cloud`, but expressed as two Railway variables. Neither spec
blocks the other, and this one ships first.

---

## 1. Context

The project has never been deployed. It runs as two processes on `localhost`, and the client only
exists inside Vite's dev server. Verified in code at `2540ac8`:

- `client/vite.config.js:9-16` — the dev server proxies `/turn`, `/health`, `/progress`, `/feedback`
  and `/patterns` to `:3001`. This proxy is **dev-only**; nothing serves the client in production.
- No `express.static` anywhere in `server/src`. There is no production client path at all.
- `server/package.json` — `start` is `node --env-file=.env src/index.js`.
- `.gitignore` excludes `client/dist`, so the build is produced at deploy time, never committed.
- `index.js:10` already reads `process.env.PORT`, defaulting to `3001`.
- `index.js:14` awaits Harper's WASM at boot, deliberately, so the learner's first turn does not pay
  for it.
- `app.js:20` mounts `cors()` with no options.
- `server/.env.example` sets `DATABASE_URL="file:./dev.db"` — a path relative to the Prisma schema.
- `useConversation.js:129-131` documents that the opening turn is deliberately **not** played aloud,
  because browsers block audio without a user gesture. Mobile autoplay policy is therefore already
  handled and needs nothing from this spec.

The operator wants the app reachable from an Android phone. Chrome on Android supports the Web Speech
API with `continuous = true`, so the full voice loop is expected to work there — over HTTPS, which
both `getUserMedia` and Web Speech require.

## 2. Goal & non-goals

### Goal

One Railway service, deployed from GitHub, serving both the API and the client over HTTPS, with the
SQLite ledger surviving deploys.

### Non-goals

1. **No authentication.** Deliberately declined by the operator after the exposure was stated. See D7.
2. **No multi-user support.** Sessions and the ledger are single-user by design. Two devices on the
   same URL share one identity.
3. **No TTS container.** No Kokoro service on Railway. The coach speaks with the phone's own voices.
4. **No local STT.** `POST /turn/audio` stays dormant; `postTurnAudio` still has no callers.
5. **No CI.** The project has none (voice-io spec §12) and this does not add any. The `pre-push` hook
   remains the only automatic gate.
6. **No custom domain, no backups, no staging environment.**

## 3. Locked decisions

**D1 — One service plus one Volume, not two services.** A separate static site for the client would
need CORS and an API base URL injected into the client at build time. Same-origin needs neither.

**D2 — Express serves the client build.** The client already calls relative paths (`lib/api.js`), so
serving `client/dist` from the same origin requires zero client changes.

**D3 — The static mount is gated on the build directory existing.** `app.js` is imported directly by
the server test suite, and `client/dist` is absent in dev and in tests. Gating on directory existence
rather than on an env flag means there is no variable anyone can forget to set, and no test that
starts failing because of one.

**D4 — `start` drops `--env-file=.env`; `dev` keeps it.** Railway injects environment variables and
writes no `.env` file. Node exits on a missing `--env-file` target, so keeping the flag means the
service never boots.

**D5 — `prisma` moves from the server's `devDependencies` to `dependencies`.** `migrate deploy` runs
at container start, which is after any dev-dependency pruning a build might do. This is the
difference between a deploy that always works and one that works until it doesn't.

**D6 — Migrations run at start, not at build.** The Volume is not mounted during the build phase, so
a build-time migration would write to an ephemeral filesystem and be discarded.

**D7 — No authentication, and CORS is left as it is.** The operator accepted the exposure: the URL is
public, and whoever finds it consumes the Mistral key and writes to the ledger. Given that, tightening
`cors()` would be theater — CORS restricts browser callers, not the `curl` that costs money. It is
recorded here as a decision rather than an oversight. A spend limit on the Mistral account is the
mitigation that actually bounds the damage, and it lives outside this repo.

**D8 — `TTS_PROVIDER=browser`.** Kokoro on Railway would mean a second service running CPU inference,
for a voice the phone already provides.

## 4. Service shape

One Railway service connected to `github.com/esstipi-debug/talker-speakup`, with a Volume.

| Setting | Value |
|---|---|
| Build | `npm run build` (root) |
| Start | `npm start` (root) |
| Volume mount | `/data` |
| Node | pinned via `engines` at the root and in `server/package.json` |

Railway's builder runs a root `npm install`, then the build script, then the start script. The repo is
not an npm workspace, so the root scripts install each package explicitly:

```
build  → install server + client deps, prisma generate, vite build
start  → prisma migrate deploy, then node src/index.js
```

`prisma generate` must run on Railway rather than being carried over from the developer's machine:
the engines are platform-specific, and the developer's machine is Windows.

### Environment variables

| Variable | Value | Notes |
|---|---|---|
| `MISTRAL_API_KEY` | the key | With it present, `brain/index.js:16` auto-resolves to `mistral`. `BRAIN_PROVIDER` is unnecessary. |
| `TTS_PROVIDER` | `browser` | D8 |
| `DATABASE_URL` | `file:/data/speakup.db` | Absolute, on the Volume |
| `PORT` | injected by Railway | Already read at `index.js:10` |

`SOURCE_FEEDS` stays unset, so the coach opens from the built-in rotation. Setting it later is a
dashboard change, not a deploy.

## 5. Serving the client

A small module — `server/src/static.js` — resolves `client/dist` relative to the server source,
checks whether it exists, and returns either a mount function or `null`. `app.js` calls it after the
API routes are registered and before the error handler.

Route order is load-bearing:

1. `/health`, `/turn`, `/feedback`, `/patterns` — registered first, exactly as they are today
2. `express.static(dist)` — serves `index.html`, hashed assets, the brand mark
3. SPA fallback — `GET` only, and only for requests that did not match above
4. the existing error handler

The fallback must not swallow API traffic, and restricting it to `GET` is what guarantees that. Any
API request the routers already handle never reaches it. What remains is method mismatches: `GET
/turn` falling through to `index.html` instead of a 404 is harmless, whereas `POST /turn` answered
with HTML would turn a server-side routing bug into a confusing client-side parse error. The `GET`
restriction leaves that case to the existing error handler.

## 6. Persistence

The Volume mounts at `/data` and `DATABASE_URL` points inside it. Without a Volume, SQLite lives on
the container's ephemeral filesystem and every deploy silently resets the error ledger — the accrued
memory that is the entire point of M4.

`prisma migrate deploy` runs on every start. It is idempotent: on an already-current database it
applies nothing.

If the Volume is missing or unwritable, Prisma fails at start and the service crash-loops. That is
the correct behavior — a coach that has quietly forgotten everything is worse than one that will not
start.

## 7. Failure modes

| Failure | Behavior |
|---|---|
| `client/dist` missing (dev, tests, a failed build) | No static mount, no fallback. The API serves normally (D3) |
| `MISTRAL_API_KEY` unset in Railway | Brain resolves to `mock` and the `upgrades` channel goes quiet. The app still works — degraded, and `/health` already reports `brain: "mock"` |
| Volume missing or unwritable | Crash-loop at start, by design (§6) |
| Cold start after a deploy | The first turn is slow: Harper's WASM loads at boot (`index.js:14`) and the container is cold |
| `refreshFeeds()` fails at boot | Already unawaited and error-swallowed (`index.js:20`). No effect |
| The phone loses connectivity mid-session | Unchanged from local: `getHealth()` returns `null` and turn errors surface in the existing banner |
| Two devices open the URL | They share one ledger and can interleave sessions. Known and accepted (non-goal 2) |

## 8. Testing

Three or four tests in the server suite. Nothing runs against Railway.

- the static mount is absent when `client/dist` does not exist, and `app.js` still builds
- with a fixture directory present, static assets are served
- the SPA fallback returns `index.html` for an unknown `GET`
- the SPA fallback does **not** intercept `POST /turn` or `GET /health`

D3 is what keeps the existing suite passing untouched: with no build directory present in a local
run, `app.js` behaves exactly as it does today.

## 9. What can honestly be claimed

**This is a deployment, not a product.** No accounts, no isolation, no rate limiting, no backups. It
is the operator's single-user app, reachable from the operator's phone.

**Nothing about privacy improves, and one thing gets worse.** The transcript and the ledger now live
on Railway's disk rather than the operator's machine, so the README's "the transcript, the database
and the grammar pass never leave your machine" is **false for the deployed instance**. The README must
say so where it makes that claim; the sentence is true of a local run and untrue of this one.

**The mic is expected to work on Chrome for Android and is unverified everywhere else.** iOS routes
every browser through WebKit, where continuous recognition is doubtful. The text input remains a
first-class path there, but that is not speaking practice.

## 10. Deferred to the implementation plan

- Whether the root `build` script uses `npm ci` or `npm install` per package
- The exact `engines` floor (≥22 vs ≥24)
- Where the README documents the deployed instance and its privacy caveat (§9)
- Whether `server/.env.example` gains a commented Railway block or the README carries it alone
