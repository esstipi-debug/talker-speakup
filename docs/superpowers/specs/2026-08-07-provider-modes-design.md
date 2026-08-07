# Provider Modes (`web` · `cloud` · `hybrid`) — Design Spec

**Date:** 2026-08-07
**Status:** design approved, implementation plan not yet written
**Depends on:** nothing — every slot it touches already exists
**Feeds:** M6 (a `local` mode becomes one more row in the preset table)

---

## 1. Context

The three provider factories resolve their provider exactly once, at boot, and memoize it. Verified in
code at `d4aaf57`:

- `brain/index.js:16` — `BRAIN_PROVIDER` if set, otherwise `mistral` when `MISTRAL_API_KEY` is
  present, otherwise `mock`. A declared `mistral` without a key logs a warning and downgrades to
  `mock`.
- `tts/index.js:16` — `TTS_PROVIDER` if set, otherwise `kokoro`.
- `stt/index.js:15` — `STT_PROVIDER` if set, otherwise `none`.
- `pronunciation/index.js:21` — `PRONUNCIATION_PROVIDER` if set and known, otherwise `none`. This is
  the only factory that already exposes `__resetForTests()`.
- `app.js:23` — `GET /health` publishes all four resolved providers plus `feedback` and `sources`.
- `useConversation.js:121` — the client fetches `/health` **once, at mount**, and stores
  `{ brain, tts, stt }`.
- `routes/turn.js:35-44` — every synthesis attempt in the app funnels through one `try/catch`, and
  both the success and failure branches converge on the same return.

So the two configurations the project actually runs — "everything in the browser, free" and "Mistral
plus a local Kokoro" — exist only as prose in the README and as a `.env` the operator edits by hand.
There is no name for them, no one-command way to select one, and nothing anywhere that distinguishes
*the configuration that was asked for* from *the one that is running*.

## 2. Goal & non-goals

### Goal

Make the project's real operating configurations selectable by name in one command, and make the
running app state its own mode honestly — including when it is not the mode that was requested.

### Non-goals

1. **No hot switching.** Modes are chosen at boot. There is no `POST /mode`, no UI toggle, and the
   memoized factories stay memoized. Changing mode restarts the server.
2. **No reachability probing.** Nothing pings Kokoro at boot or on a timer. This follows the
   precedent already set and documented in `pronunciation/index.js:9-13`.
3. **No new providers.** This spec wires up `mock`, `mistral`, `browser` and `kokoro`, all of which
   ship today. It does not add a local brain — despite `server/.env.example` listing
   `OLLAMA_BASE_URL`, no Ollama implementation exists (`server/src/brain/` holds `mock.js` and
   `mistral.js` only).
4. **No client-side mode selection.** The client reports the mode; it never chooses it.
5. **No serverless "web mode".** Running the client without the Node server is a different project
   and is out of scope. See §11.

## 3. Locked decisions

**D1 — A mode controls two slots: `brain` and `tts`.** `stt`, `pron` and `sources` stay orthogonal
env vars. They do not vary across the three configurations being named, and folding them in would
invent coupling that has to be undone when M6 adds local Whisper.

**D2 — `auto` is the default, and it is exactly today's behavior.** Absent `--mode`, resolution is
byte-for-byte what `d4aaf57` does. Any other default would silently move an existing `.env` that has
a key but no `TTS_PROVIDER` from Kokoro to the browser voice — a regression delivered by a change
that was supposed to be additive.

**D3 — Explicit env vars beat mode defaults.** Precedence is: explicit env var → mode default →
legacy default. An operator's existing `.env` keeps meaning what it meant.

**D4 — Requested mode and effective mode are separate published facts.** The effective mode is
*derived* from the real `(brain, tts)` pair; a pair matching no preset is named `custom`.

**D5 — `degraded` marks failure, not choice.** Requesting `hybrid` and overriding `TTS_PROVIDER=browser`
by hand yields `effective: "cloud"`, `degraded: false`. Only a missing key or an unreachable TTS sets
`degraded: true`.

**D6 — TTS reachability is learned from real turns only.** The flag starts `null`, meaning *not yet
attempted*, and `null` never degrades. Starting Kokoro mid-session recovers on the next successful
turn with no restart — the same property `pron` was given for the same reason.

**D7 — The client refreshes `/health` on the edge, not per turn and not per contract change.**
Fattening the `/turn` response would duplicate a concept that already lives in `/health` and change a
contract three routes return. Refreshing every turn would add an `await topicStats()` DB round-trip
per turn whenever `SOURCE_FEEDS` is configured (`app.js:25`).

**D8 — An unknown mode warns and falls back to `auto`.** It never throws. This matches the brain's
existing warn-and-degrade behavior at `brain/index.js:18` and the project's "degrade, never break"
principle.

## 4. The preset table

| Slot | `auto` | `web` | `cloud` | `hybrid` |
|---|---|---|---|---|
| `brain` | key ? `mistral` : `mock` | `mock` | `mistral` | `mistral` |
| `tts` | `kokoro` | `browser` | `browser` | `kokoro` |
| `upgrades` channel | follows the key | off | on | on |
| Requires | — | nothing | `MISTRAL_API_KEY` | key + Kokoro on `:8880` |

The `upgrades` row is a consequence, not a setting: `feedback/upgrades.js:12` returns
`{ status: "skipped" }` when `MISTRAL_API_KEY` is absent. No mode configures it.

## 5. Architecture

One new module, `server/src/config/mode.js` (~80 lines):

```
resolveMode()             → "auto" | "web" | "cloud" | "hybrid"   (memoized, logs once)
slotDefault(slot)         → the mode's default for "brain" | "tts", or null under auto
noteTTSOutcome(ok)        → sets the module's only mutable state: _ttsReachable
modeStatus({brain, tts})  → { requested, effective, degraded, reasons }
__resetForTests()         → mirrors pronunciation/index.js:44
```

**`modeStatus` takes the providers as arguments rather than importing them.** The factories import
`mode.js` for their defaults, so `mode.js` importing the factories would close a cycle. `app.js`
already imports all four `current*Provider()` functions and is the natural caller. The result is a
pure function of its arguments plus one module-level flag — testable with no module mocking.

**`_ttsReachable` is the only mutable state in this design.** Everything else is derived. A missing
key is deducible by comparing the requested mode's defaults against the provider the factory
actually resolved. Reachability is not deducible from configuration — it requires having tried.

### Mode selection

`resolveMode()` reads, in order: a `--mode=<value>` argument in `process.argv`, then `SPEAKUP_MODE`,
then `auto`. Only the `--mode=<value>` form is supported; `--mode <value>` is not.

The CLI flag is the primary path rather than an inline env var because the project's operator is on
Windows, where `SPEAKUP_MODE=web npm run dev` is not valid syntax in PowerShell or cmd. An argument
is portable without adding `cross-env`.

### Factory changes

Two one-line changes, preserving the existing chains:

- `brain/index.js:16` → `explicit || slotDefault("brain") || (hasMistralKey ? "mistral" : "mock")`
- `tts/index.js:16` → `explicit || slotDefault("tts") || "kokoro"`

The existing `mistral`-without-key guard at `brain/index.js:18` is unchanged. It already downgrades
correctly; this spec only adds a reader for the outcome.

### Turn hook

Two lines in `runTurn()` (`routes/turn.js:35-44`): `noteTTSOutcome(true)` after a successful
synthesis, `noteTTSOutcome(false)` in the existing `catch`. `noteTTSOutcome` must never throw and
must never touch the database.

### `/health`

One added key. Every existing field keeps its shape, so current consumers are unaffected.

```json
"mode": { "requested": "hybrid", "effective": "cloud", "degraded": true, "reasons": ["tts-unreachable"] }
```

`index.js:22` adds the mode to the boot log line that already prints the providers.

## 6. Degradation reasons

| `reason` | Set when | Cleared by |
|---|---|---|
| `missing-mistral-key` | The requested mode's `brain` default is `mistral` and the factory resolved `mock` | Restarting with a key |
| `tts-unreachable` | The configured TTS is `kokoro` or `voicebox` **and** the last real attempt failed | The next turn that synthesizes successfully |

`reasons` is an array because both can hold at once. `degraded` is `reasons.length > 0`.

Reachability is ignored entirely when the configured TTS is `browser` — there is nothing to reach, so
a `false` flag left over from an earlier configuration cannot leak into the report.

## 7. Client

`useConversation.js:121` carries `mode` through the existing `setProviders` call. `getHealth()` in
`lib/api.js:18` is unchanged; only its comment is updated.

**Edge-triggered refresh (D7).** The client knows whether it expected audio (`ttsProvider !== "browser"`)
and whether it received any. A ref holds that boolean; when the value changes — and only then — it
re-fetches `/health`. Roughly four lines. Zero requests in steady state, and it recovers in both
directions: the turn that fails marks, the turn that synthesizes again clears.

**`StatHeader` gains a mode pill** ahead of the existing ones. The `brain`/`tts`/`stt` pills stay: the
mode is the summary, the slots are the detail, and removing them would break `StatHeader.test.jsx` and
`__a11y__.test.jsx` for no user-visible gain.

When `degraded` is true the pill must not be distinguished by color alone. The reason goes in the
accessible name — *"mode hybrid, degraded: TTS unreachable"* — because color as the sole carrier of
meaning is what the project's `jest-axe` assertions exist to catch.

## 8. Scripts

Root `package.json` keeps `dev` untouched (mode `auto`) and adds three siblings:

```
dev:web     → concurrently … npm --prefix server run dev -- --mode=web     … client dev
dev:cloud   → … --mode=cloud …
dev:hybrid  → … --mode=hybrid …
```

Arguments after `--` are appended to the end of the server's `dev` script, landing after
`src/index.js`, which is where `resolveMode()` scans for them.

No `start:*` variants: this runs on `localhost` only, and nothing uses the `start` script today.

## 9. Failure modes

| Failure | Behavior |
|---|---|
| Unknown `--mode` value | Warn, fall back to `auto`, keep serving (D8) |
| `--mode=hybrid`, no API key | Brain resolves `mock`; `effective: "custom"`, `reasons: ["missing-mistral-key"]` — the real pair is (mock, kokoro), which matches no preset |
| `--mode=hybrid`, Kokoro down | Turn returns without audio as it does today; client speaks; after the first failed turn `reasons: ["tts-unreachable"]` |
| Kokoro started mid-session | Next successful synthesis clears the reason. No restart (D6) |
| Both slots degraded | `reasons` carries both; `effective` is `web` |
| Slots overridden by hand | `effective: "custom"` when the pair matches no preset; `degraded: false` (D5) |
| `/health` unreachable from the client | `getHealth()` already returns `null` and the pills stay hidden (`api.js:22`). Unchanged |

## 10. Testing

New file `server/test/mode.test.js`, plus extensions to `health.test.js`, one turn test, and the
client suites. Approximately 15 tests.

**The load-bearing test is the dull one: `auto` reproduces today's resolution exactly.** It is the
guard against the silent regression D2 exists to prevent.

Server:

- precedence holds for both slots (explicit env > mode default > legacy)
- `auto` matches current behavior for every combination of key present/absent
- an unknown mode falls back to `auto` without throwing
- `modeStatus` derives the effective name, and yields `custom` for an unmatched pair
- `degraded` is false for a deliberate override, true for a missing key
- `_ttsReachable === null` never degrades
- reachability is ignored when the TTS is `browser`
- `noteTTSOutcome(false)` sets the reason and `noteTTSOutcome(true)` clears it
- `/health` reports the right `mode` block under each preset
- `runTurn` records the outcome on both the success and the failure branch

Client:

- `StatHeader` renders all five mode values
- the degraded pill carries its reason in the accessible name, not in color alone
- a `jest-axe` assertion in `__a11y__.test.jsx`
- `useConversation` re-fetches `/health` on the edge **and does not** re-fetch while the state is
  stable — both directions asserted

The 80% coverage gate adds `server/src/config/**`, consistent with the existing `feedback/**` and
`metrics/**` entries.

## 11. What can honestly be claimed

**`web` mode is not a browser-only mode.** The Node server, Prisma and SQLite are required in all
three modes; `/turn`, `/feedback` and the ledger live there. `web` means "no API key and nothing to
install beyond Node" — not "no server".

**No mode makes the audio local.** In all three, speech recognition is the browser's Web Speech API,
which on Chrome means Google's servers. The server-side path exists but is not reachable from the UI:
`postTurnAudio` is exported at `client/src/lib/api.js:35` and has no callers anywhere in the client.
Local STT is M6's claim to make, not this spec's.

**`effective` is a claim about configuration and last-observed reachability, not about health.** A
`hybrid` that reports undegraded has synthesized successfully at least once, or has not yet tried. It
is not a promise that the next call will succeed.

## 12. Deferred to the implementation plan

- The exact ordering of `resolveMode()`'s memoization relative to the factories' first call
- Whether `README.md`'s provider table gains a modes section or a standalone one (the stale test
  count in its Tests section — 281, against ~397 test bodies in 41 files — is corrected in the same
  pass; nothing else in the README is touched)
- The pill's exact copy and placement within `StatHeader`
- Whether `server/.env.example` documents `SPEAKUP_MODE` as a supported alternative to `--mode`
