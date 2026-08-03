# Sourced Proactivity (M8) — Design Spec

- **Date:** 2026-08-02 (reconciled against shipped M2 on 2026-08-03)
- **Status:** Design approved (six locked decisions). Implementation plan not written. **Unblocked** — M2 has shipped.
- **Owner:** SpeakUp (C:\talker)
- **Relates:** [`2026-08-02-roadmap-sequencing-design.md`](2026-08-02-roadmap-sequencing-design.md) §5 and §10 for the seam and why M8 sits after M2; [`2026-08-02-m2-structured-feedback-design.md`](2026-08-02-m2-structured-feedback-design.md) for the metrics that judge this milestone.

> **On file:line citations.** Paths below were verified against `main` at commit `ebbd732`.
> They are load-bearing for *what to change*, not for *what is true later* — re-verify before editing.

> **M8 owns more than originally planned.** This spec was written expecting M2 to build the seed seam
> and the measurement columns. Shipped M2 built neither: there is no `seed/` module, no
> `POST /turn/open`, and the client still opens from a hardcoded `GREETING` constant in
> `useConversation.js`. M8 therefore builds the whole seam, including the `local` provider it was
> going to inherit. See §5 and §11.

---

## 1. Context

Generic openers produce rehearsed answers. *"Tell me about your day"* has a three-word reply and you have given it a hundred times. The premise of this milestone is that a subject you hold an opinion about makes you produce more language, and harder language, because you have something to defend and you will run out of vocabulary trying.

The learner points the coach at RSS feeds — YouTube channels they already subscribe to. Those subscriptions are the payload: **they encode what the learner has opinions about**, which no generic topic list can.

### 1.1 This is a hypothesis, and M2 is the instrument

The claim above is falsifiable, and the signals that falsify it — words per turn, the hesitation index, the ratio of mid-phrase to clause-boundary pauses — are produced by M2 and M7 slice 1. M8 must therefore record *which sessions were sourced* so the comparison is possible at all (§6.3). Building M8 before M2 would mean building it with no way to know it helped.

### 1.2 Current state (verified against `main` at `ebbd732`)

- Every swappable capability is an env-var factory with a degraded default: `brain/` (mock|mistral), `tts/`, `stt/`, `pronunciation/`. `GET /health` reports which came up.
- `app.js` builds the app and never listens; `index.js` owns the listener. **The server test suite imports `app.js`** — so anything with a network side effect at boot must be triggered from `index.js`, not `app.js` (§4.4).
- `repo/session.js` is the only module touching Prisma's `Session` and `Turn`; `repo/ledger.js` owns `ErrorLedger`. Both own their JSON encode/decode boundary.
- **M2 has shipped:** `feedback/{harper,index,pattern,upgrades}.js`, `metrics/delivery.js`, `routes/feedback.js`, the client `FeedbackPanel`, and a rewritten C1–C2 `prompts/coach-system.js` with the pressure policy. The metrics this milestone will be judged by therefore exist.
- **The seed seam does not exist.** No `seed/` module, no `POST /turn/open`, and `Session` has neither `seedProvider` nor `topicId`. `useConversation.js` opens every session from a hardcoded `GREETING` string.
- No router and no settings screen exist on the client. `App.jsx` is one conversation view.

---

## 2. Goal & Non-Goals

### Goal

A session opens with the coach raising a subject the learner actually cares about, and stays on it under pressure for the whole session — with no network in the critical path, no API key, and no UI to configure.

### Non-Goals

- **Transcripts.** No official API exists; scraper libraries break when YouTube changes its frontend. Locked out in D1.
- **Discussing the video's actual content.** Metadata only. The coach discusses the *subject*, never the artefact (D2).
- **Any assumption that the learner watched anything** (D2).
- **A settings UI** (D5).
- **Recommending or discovering channels.** The learner supplies feed URLs.
- **Topic spaced repetition.** Resurfacing a subject you struggled with is a real idea and it is M4's, not this milestone's.
- **Per-turn topic rotation.** One topic per session (D3).

---

## 3. Locked decisions

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| D1 | Ingestion depth | **RSS metadata only, no transcripts** | Feed URLs need no key and no quota, matching $0-by-default. Transcripts have no official API and would put a self-breaking dependency in the critical path. |
| D2 | Relation to the video | **Topic source, not shared reference** | "Did you see X?" has a one-word answer that collapses the conversation at turn one, and recovering from it needs content the system does not have. Discussing the *subject* works identically whether or not the learner watched, and works with metadata alone. |
| D3 | Topic scope | **Governs the whole session**, fixed at session start | An opener-only topic is abandoned at turn two and buys one sentence. The thesis requires the coach to stay and push. Cost is the same string in the same prompt. |
| D4 | Who writes the opener | **The coach, in its own first turn** | A separate generation step is an extra call, an extra prompt, an extra fallback and an extra place for tone to drift — and buys nothing the system prompt cannot do. Collapses `seed.opener` out of the interface entirely. |
| D5 | Configuration | **`SOURCE_FEEDS` env var, feed URLs, zero UI** | A settings screen means the project's first router and first config-write path, for an action performed twice a year. Every other capability is already an env knob. Taking feed *URLs* rather than channel IDs avoids resolving `@handle` → `UC…`, which without a key means scraping — the exact fragility D1 removed. |
| D6 | Freshness | **Cache-first, refresh in the background** | The network is never in the critical path. Offline needs no error path: the cache still has topics. D2 means the coach never claims a video is recent, so **staleness is invisible and needs no logic at all**. |

### 3.1 Two consequences worth stating explicitly

**D2 pays for D6.** Because the coach never says "new" or "recent", a topic cached three months ago is indistinguishable from one cached yesterday. There is no expiry threshold, no freshness check, and no decision about what to do with a stale item. That is not an oversight; it is the second decision cashing in the first.

**D5 makes non-YouTube sources free.** The parser handles Atom/RSS and never learns that YouTube exists. A blog or podcast feed works the day M8 ships, with no code. The "maybe other sources" part of the original request costs nothing rather than being a milestone.

---

## 4. Architecture

### 4.1 Modules

```
server/src/seed/
  index.js     factory: feeds | local — mirrors brain/index.js exactly
  local.js     no network: a topic from the ErrorLedger or the last session summary
  feeds.js     cache-first topic from stored feed items, builds the digest
  rss.js       the ONLY file that fetches or parses a feed
  select.js    pure: choose a topic from candidates
server/src/repo/
  topics.js    the ONLY module that reads or writes FeedItem
```

`local.js` was originally M2's to build; M2 shipped without it, so it is M8's. That is a small addition — it is a database read and a template — but it must be built **first**, because it is the fallback every degraded row in §7 falls back to.

`rss.js` is a hard boundary, the same rule `micStream.js` has for Web Audio and `feedback/harper.js` has for Harper: **no feed-shaped type escapes it.** Everything downstream sees plain `{ guid, title, description, url, publishedAt, sourceLabel }` objects. When YouTube changes its Atom output, exactly one file changes.

Inside `rss.js` the split is by testability, not by topic:

```js
export function parseFeed(xml)   // pure — fixtures, no network, unit-tested
export async function fetchFeed(url)  // I/O — thin, not unit-tested
```

### 4.2 The seed contract (from the roadmap spec §5)

```js
seed = {
  topic: string,        // the digest injected into the system prompt
  sourceLabel?: string, // e.g. "Veritasium" — from the feed's <author><name>
  sourceUrl?: string,   // the video URL — unused by M8, exists for a possible M9
}
```

`getSeedProvider().nextSeed()` returns a seed or `null`. Returning `null` is not an error: it means *nothing to offer*, and the factory falls through to `local`.

### 4.3 The factory

Mirrors `brain/index.js` including its auto-detect shape:

```
SOURCE_FEEDS present and non-empty  → feeds  (falls through to local when dry)
otherwise                           → local
```

There is deliberately **no health probe** of the feed URLs, exactly as `pronunciation/` has none: reachability is whatever the next background refresh returns. Adding a feed and restarting simply works on the following session.

### 4.4 Where the refresh is triggered

**`index.js`, not `app.js`.** The server test suite imports `app.js` to bind an ephemeral port; a boot-time fetch there would put the whole suite on the network. `index.js` calls `refreshFeeds()` once at boot, unawaited, errors swallowed to a log line.

That is the only trigger. A session started later reads the cache that boot filled. Since the server is started when the learner sits down to practise, boot and session start are minutes apart in practice — and by D6 it would not matter if they were weeks apart.

### 4.5 The digest and the token budget

`feeds.js` builds `topic` as a bounded string:

```
<title> — <first paragraph of description, truncated>
```

Hard cap: **400 characters.** YouTube descriptions run to thousands of characters of links, sponsor copy and chapter timestamps; the whole tail after the first blank line is dropped before truncation. M2 is already growing the system prompt, and an unbounded description would dominate it.

### 4.6 The prompt

Owned by `prompts/coach-system.js`, which M2 rewrites. M8 adds one conditional block:

- Open with a concrete, opinion-seeking question about the underlying subject.
- **Never assume the learner has seen, read or heard anything.** Never mention a video, a channel, or that the subject is recent.
- Stay on the subject for the session — but **follow the learner if they move.** The topic is gravity, not a rail.

Without a seed the block is absent and the prompt is M2's unchanged.

---

## 5. Data flow

```
boot ──► refreshFeeds() ──► rss.fetchFeed ──► rss.parseFeed ──► repo/topics.upsertItems
                                                                        │
session start ──► seed/index ──► feeds.nextSeed ──► repo/topics.listUnused
                                          │                             │
                                          └──► select.pickTopic ────────┘
                                                     │
                                          repo/topics.markUsed
                                                     │
                                        digest ──► coach-system prompt ──► coach's first turn
```

Selection (`select.js`, pure): **the newest unused item across all feeds.** No channel round-robin. A prolific channel will dominate a quiet one, which may or may not be a problem; it is one line to change once there is evidence, and inventing the weighting now is guessing.

When nothing is unused — roughly six weeks of daily sessions on three feeds, since an Atom feed carries ~15 entries — `nextSeed()` returns `null` and `local` opens the session. Nothing is reused and nothing is announced.

---

## 6. Persistence

### 6.1 New model

```prisma
model FeedItem {
  id          String    @id @default(cuid())
  guid        String    @unique   // Atom <id>; the upsert key, so a refresh is idempotent
  feedUrl     String
  sourceLabel String?             // <author><name>
  title       String
  description String?
  url         String?
  publishedAt DateTime?
  usedAt      DateTime?           // null = never served as a topic
  createdAt   DateTime  @default(now())
}
```

One table serves as both cache and used-ledger; `usedAt IS NULL` is the entire unused query. No second model, no join.

### 6.2 Retention

Items are never deleted. A used item is ~1 KB and the whole table after a year of three feeds is a few hundred rows. A cleanup job would be more code than the problem.

### 6.3 The measurement hook — the reason the ordering works

`Session` gains two nullable columns:

```prisma
seedProvider String?   // "feeds" | "local" | null
topicId      String?   // FeedItem.id when seedProvider = "feeds"
```

Without these, §1.1 is unanswerable: there is no way to compare words-per-turn and hesitation on sourced sessions against unsourced ones, and M8 becomes a feature that feels smarter with no evidence that it teaches better. **These columns are not optional polish; they are why M8 was sequenced after M2.**

Both are written by `repo/session.js`, which stays the only module that touches `Session`.

### 6.4 Failure posture

Unchanged from the rest of the project: a persistence failure costs a row, never the turn. If `markUsed` fails, the topic may be served twice. That is a strictly better outcome than a failed session, and no retry logic is warranted.

---

## 7. Degraded states

| Condition | Behaviour |
|---|---|
| `SOURCE_FEEDS` unset | Provider is `local`. M8 is inert. |
| No network at boot | Refresh logs and gives up. Cache serves. Session is identical. |
| A feed 404s or returns garbage | That feed is skipped; the others still refresh. |
| Cold start, empty cache | `nextSeed()` → `null` → `local` opens. Warm by the second session. |
| All items used | Same as cold start. |
| Mock brain (no API key) | The mock's opener, ignoring the topic. Worse conversation, same structure, nothing broken. |

Every row degrades to a working session. None of them shows the learner an error.

---

## 8. Health

`GET /health` gains one field, reporting configuration and cache state — never reachability:

```json
"sources": { "provider": "feeds", "feeds": 3, "cached": 41, "unused": 12 }
```

`unused: 0` is the honest signal that sourced sessions have run dry.

---

## 9. Security & dependencies

- `SOURCE_FEEDS` URLs come from the operator's own `.env` on localhost. Still, `fetchFeed` accepts **`http:` and `https:` only** and does not follow redirects to other schemes — cheap, and it keeps a typo from turning into a file read.
- The fetch is bounded by a timeout and a response-size cap. Nothing waits on it, so the timeout can be short.
- **XML parsing uses a maintained parser** (`fast-xml-parser` — zero dependencies, actively maintained). Hand-rolled regex extraction of Atom entries is the kind of code that appears to work on three feeds and silently mangles the fourth. This is the milestone's only new runtime dependency.
- Feed content is untrusted text that ends up inside the coach's system prompt. It is bounded (§4.5) and it is the learner's own subscriptions, but the digest must be inserted as data in a delimited block, never concatenated into instruction text.

---

## 10. Testing

Server suite, node environment, no network.

| Unit | Tests |
|---|---|
| `rss.parseFeed` | A real YouTube Atom fixture; a generic RSS 2.0 fixture; a truncated/malformed document returns `[]` rather than throwing; entries missing `description` or `published`. |
| `select.pickTopic` | Newest-unused ordering; empty candidate set → `null`; ties. |
| `feeds.nextSeed` | Digest truncation at the 400-char cap; description tail after a blank line dropped; dry cache → `null`. |
| `seed/index` | `SOURCE_FEEDS` present → `feeds`; absent → `local`; `feeds` returning `null` falls through to `local`. |
| `seed/local` | Produces a seed with no network and no feeds configured; produces one on an empty database (the fixed rotation). |
| `POST /turn/open` | Returns a coach turn with no `utterance` in the request; persists it as a coach turn; records `seedProvider` on the session. |
| `repo/topics` | `upsertItems` is idempotent on `guid` — a second refresh of the same feed creates no duplicates and does not clear `usedAt`. |

The last one is the bug most likely to actually happen: a refresh that resets `usedAt` would silently start repeating topics, and nothing in the UI would show it.

No coverage gate is proposed for these files. The existing 80% gate covers the client's timing-critical voice code, where the failure modes are unreproducible on demand; this milestone is ordinary I/O and pure functions, and gating it would be cargo-culting the number rather than the reason.

---

## 11. Build order

Shipped M2 did not build the seam, so steps 1 and 4 below are larger than this spec originally assumed.

1. Prisma migration: `FeedItem`, plus `Session.seedProvider` / `Session.topicId`.
2. `seed/index.js` factory + `seed/local.js` + `POST /turn/open`, and the client opening from that instead of the hardcoded `GREETING`. **This is the seam M2 was expected to provide.** It is independently valuable: it replaces a constant greeting with a concrete opening question, which is the owner's stated requirement regardless of where topics come from. Ship it on its own.
3. `rss.js` (`parseFeed` first, against fixtures) + `repo/topics.js`.
4. `select.js`.
5. `seed/feeds.js`, registered in the factory.
6. Refresh trigger in `index.js`; `sources` block in `/health`.
7. Topic block in `prompts/coach-system.js` — M2's rewritten C1 prompt is the thing being extended, not replaced.
8. `.env.example` documentation and the README provider table row.

**Step 2 is a shipping point.** After it, the coach opens with something concrete and the seed interface exists with one provider behind it; steps 3–8 add a second provider. Landing step 2 alone is a real improvement and it de-risks everything after it.

The measurement columns in step 1 are not optional instrumentation — they are the reason this milestone was sequenced after M2 (§1.1). If they get cut, §12 becomes unanswerable.

---

## 12. What would make this milestone a mistake

Stated up front so it can be checked rather than rationalised later.

If sourced sessions show no improvement in words per turn or hesitation against unsourced ones after a few weeks of §6.3 data, then M8 is a topic generator that makes the app feel smarter without making the practice harder. The correct response then is to delete it, not to add channel weighting and a settings screen to rescue it.
