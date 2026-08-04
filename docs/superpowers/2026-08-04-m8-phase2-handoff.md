# Handoff — finish M8 and fix the STT privacy claim

**Written:** 2026-08-04, end of the session that shipped M8 phase 1.
**For:** a fresh session with no prior context, working autonomously.

---

## Mode for this session: ponytail, not the M2 process

M2 and M8 phase 1 were built with brainstorming → spec → plan → subagent-driven TDD → whole-branch
review. That process is not what is wanted for what's left. **Use the `ponytail` skill.** Read the
skill file at `C:\Users\Gamer\.claude\skills\ponytail\SKILL.md` (or invoke it) before writing code.

Concretely: no new spec, no new task-by-task plan, no subagent review loop. Read the existing specs
below for the *shape* of what's needed, then write the lazy, minimal, working version yourself. Make
the decisions this doc leaves open. Do not stop to ask — finish and leave the system operational.
Report back only when everything below is done.

## Where things stand

**`main` is at `cc88917`.** M8 phase 1 is merged: `POST /turn/open`, a seed provider chain with one
provider (`local`, a daily-rotating fixed topic list), `Session.seedProvider`/`topicId` for
measurement. 130 server tests, 191 client tests, all green. `useConversation.js` clears its 80%
coverage gate.

**Two things are open**, unrelated to each other:

1. M8 phase 2 — the RSS-fed seed provider. Spec written, nothing built.
2. The README claims local-first STT. It's false on the path everyone actually uses. Found this
   session, not yet fixed.

## 1. Fix the local-first claim (do this first, it's fast)

`client/src/lib/speech.js` creates a `SpeechRecognition` via `window.SpeechRecognition ||
window.webkitSpeechRecognition`. In Chrome this sends microphone audio to Google's servers for
transcription — it is not on-device by default. `README.md` currently says:

> It runs entirely on your machine — the mic never leaves the building.

That's true of the transcript, the database, and the grammar pass (Harper is WASM, no network). It is
**not** true of the audio itself, on the path every user is on by default. Fix, in order:

1. **Spike, time-boxed to 30 minutes:** does Chrome's `SpeechRecognition` support an on-device mode
   today (`processLocally` or similar — check current MDN/Chrome release notes, this moves fast), and
   does it cover `en-US`? If yes and it's a small change, wire it in as the default and the privacy
   claim becomes true. If no, or it's flaky, or it needs a flag most users won't have — stop the spike,
   don't chase it further.
2. **Either way, fix the README and the principle 1 statement** to be accurate about what's true today.
   If the spike succeeded: say STT is on-device where supported, falls back otherwise. If not: say
   audio is transcribed via the browser's speech service (specify Google for Chrome) until M6 ships
   local Whisper via `voicebox`, and that everything else (transcript, DB, grammar pass) stays local.
   Don't soften this — the whole project's pitch rests on principle 5 (honesty of measurement), and an
   inaccurate privacy claim is the same category of dishonesty on a topic that matters more.

## 2. M8 phase 2 — the RSS provider

Spec: [`docs/superpowers/specs/2026-08-02-sourced-proactivity-design.md`](specs/2026-08-02-sourced-proactivity-design.md).
Read §3 (locked decisions) and §11 (build order) for the shape — RSS metadata only, no transcripts,
topic-not-reference, session-wide topic, `SOURCE_FEEDS` env var, cache-first with no expiry logic. Do
not rebuild these decisions; they're settled. Do write the lazy version of the code, not the
heavily-layered one the spec sketches if a shorter path covers the same behavior.

**What must be true when you're done:**

- `SOURCE_FEEDS` in `server/.env.example` takes a comma-separated list of feed URLs (RSS or Atom —
  YouTube channel feeds work unmodified).
- With it set, the coach opens sessions on topics pulled from those feeds instead of the local
  rotation; with it unset or every feed dead/unreachable, it falls back to the local rotation with no
  error surfaced anywhere. Never blocks session start on a network call — cache-first, refresh in the
  background at boot.
- `Session.seedProvider` records `"feeds"` when a feed topic was actually used, matching the pattern
  already in place for `"local"`.
- No topic repeats until every cached item has been used once.

**Decisions already made, don't re-litigate:**

- No transcripts, no scraping beyond parsing the feed XML. Use `fast-xml-parser` (zero deps,
  maintained) — do not hand-roll Atom/RSS parsing with regex.
- The prompt never claims the learner watched anything — it's a topic seed, not a shared reference.
  `buildOpeningPrompt` in `server/src/prompts/coach-system.js` already enforces this; feed items just
  need to produce a `topic` string, same shape as `seed/local.js`'s output.
- One new Prisma model for cached feed items (call it whatever's natural — `FeedItem` was the spec's
  name), one new migration. Don't reuse `ErrorLedger` or bolt onto `Session`.

**One thing the whole-branch review on phase 1 flagged as a blocker for this phase, don't skip it:**
`server/src/seed/index.js`'s `PROVIDERS` array is currently a hardcoded module-level const with no
injection point, so nothing can test the fall-through behavior (a throwing/empty provider falling back
to the next one) from outside the module. Phase 2 needs that fall-through to actually work — a dead
feed must degrade to `local`, not break the opener. Make `PROVIDERS` injectable (a parameter with a
default, or an exported setter — pick the smaller diff) and write the one test that proves a feeds
provider returning null still produces a valid opener from `local`.

**Build it, run the full suite (`npm test` from repo root), commit.** No coverage gate exists for
`seed/**` (M8's own spec explicitly declined one — ordinary I/O and pure functions, not the
timing-critical voice code the gate exists for) — write tests because they're worth having, not to
satisfy a threshold.

## 3. When both are done

- `npm test` green, both suites.
- Merge to `main` locally (you're likely already working there or in a worktree off it — check
  `git worktree list` before creating a new one; this repo tends to accumulate stale ones).
- `git push origin main`.
- Update this repo's `README.md` milestone table: M8 row should read differently for phase 1 vs 2 done.

## Environment facts that will bite you

- A fresh checkout/worktree needs, from the repo root:
  ```bash
  npm --prefix server install
  cd server && npx prisma generate && cd ..
  npm --prefix client install
  ```
  Skipping this produces a wall of `@prisma/client did not initialize yet` or `harper.js` resolution
  errors that look like code defects and are not.
- Migrations: `npm --prefix server exec -- prisma migrate dev --name <name>` from the repo root; if it
  says "Could not find Prisma Schema", `cd server` and run `npx prisma migrate dev --name <name>`
  there instead. It prompts interactively for a name if you omit `--name` — always pass it.
- Server tests run with `fileParallelism: false` (SQLite serializes writers) — don't change it. The
  test DB is shared across test files and NOT reset between runs — don't assert on absolute row counts
  across a whole table, only on rows scoped to something the test itself created.
- `.superpowers/` is git-ignored — anything written there dies with the branch. Nothing durable belongs
  there.
- `server/package-lock.json` shows as locally modified in most worktrees from `npm install` version
  drift. Not your problem to fix; don't commit it unless you deliberately changed a dependency.

## What phase 1 taught, don't relearn it

- **The opener must never autoplay.** Browsers block audio without a prior user gesture. Render text,
  carry audio on the message object, let the existing replay control play it on demand.
- **A slow async call in a mount effect can race a user action that started after it did.** Guard on
  whether anything has actually happened yet (message count, status) before letting a late-resolving
  effect overwrite state — don't just guard against unmount.
- **`<StrictMode>` double-invokes effects in dev.** Any side-effectful call (a POST, not a GET) inside
  a mount effect needs a ref-based "already fired" guard, or it fires twice per real page load.
- **Don't compute a response field from in-memory state when persistence might have failed.** Report
  what was actually written, not what was attempted — see `persistOpening` in `server/src/routes/turn.js`
  for the pattern (`sessionUsable` flag), which mirrors `persistTurn` in the same file.

## Not blocking, don't chase these now

- Whether Mistral's chat API accepts a system-only message list (no key was available to check when
  `MistralBrain.openTurn` was written; it currently sends a synthetic `"Begin."` user message as a safe
  guess). Verify only if a key becomes available; the current code degrades safely either way.
- Spike K5 (does the voice loop survive a backgrounded tab, gating milestone M9) — unrelated to M8,
  lower priority, do it only if M8 phase 2 and the STT fix are both done with time left over.
