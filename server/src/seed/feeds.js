import { fetchFeed, parseFeed } from "./rss.js";
import { pickTopic } from "./select.js";
import { listUnused, markUsed, upsertItems } from "../repo/topics.js";

const DIGEST_CAP = 400;

export function configuredFeeds() {
  return (process.env.SOURCE_FEEDS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * `<title> — <first paragraph of description>`, hard-capped. YouTube
 * descriptions run to thousands of characters of links, sponsor copy and
 * chapter timestamps — the whole tail after the first blank line is dropped
 * before truncation (spec §4.5).
 */
export function buildDigest(item) {
  const firstParagraph = (item.description ?? "").split(/\r?\n\s*\r?\n/)[0].trim();
  const base = firstParagraph ? `${item.title} — ${firstParagraph}` : item.title;
  return base.length > DIGEST_CAP ? `${base.slice(0, DIGEST_CAP - 1)}…` : base;
}

/**
 * Cache-first: no network here. Returns null when nothing is unused (empty
 * cache, or everything already served) — the factory falls through to
 * `local` on null, not on a throw.
 */
export async function nextSeed() {
  const item = pickTopic(await listUnused());
  if (!item) return null;

  try {
    await markUsed(item.id);
  } catch (err) {
    // A failed markUsed risks serving this topic again later — strictly
    // better than a failed session (spec §6.4), so no retry.
    console.warn("[seed/feeds] markUsed failed, topic may repeat:", err.message);
  }

  return {
    provider: "feeds",
    topic: buildDigest(item),
    sourceLabel: item.sourceLabel ?? null,
    sourceUrl: item.url ?? null,
    topicId: item.id,
  };
}

/**
 * Fetches every configured feed and caches its items. Never throws — a dead
 * feed is skipped, the others still refresh (spec §7). Called once at boot,
 * unawaited: a session started later just reads whatever the cache holds.
 */
export async function refreshFeeds(feedUrls = configuredFeeds()) {
  for (const feedUrl of feedUrls) {
    try {
      const xml = await fetchFeed(feedUrl);
      const entries = parseFeed(xml).map((entry) => ({ ...entry, feedUrl }));
      await upsertItems(entries);
    } catch (err) {
      console.warn(`[seed/feeds] refresh failed for ${feedUrl}:`, err.message);
    }
  }
}
