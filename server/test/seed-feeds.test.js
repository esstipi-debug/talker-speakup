import { describe, it, expect } from "vitest";
import { parseFeed } from "../src/seed/rss.js";
import { pickTopic } from "../src/seed/select.js";
import { buildDigest, nextSeed as nextFeedSeed, configuredFeeds } from "../src/seed/feeds.js";
import { nextSeed } from "../src/seed/index.js";
import * as local from "../src/seed/local.js";
import { upsertItems } from "../src/repo/topics.js";
import { getPrisma } from "../src/db.js";

const YOUTUBE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <id>yt:channel:UCsXVk37bltHxD1rDPwtNM8Q</id>
  <title>Kurzgesagt – In a Nutshell</title>
  <author><name>Kurzgesagt – In a Nutshell</name></author>
  <entry>
    <id>yt:video:AbCdEfGhIjK</id>
    <title>Why Is It So Hard To Cure Aging?</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=AbCdEfGhIjK"/>
    <author><name>Kurzgesagt – In a Nutshell</name></author>
    <published>2026-07-30T15:00:03+00:00</published>
    <updated>2026-07-30T18:12:09+00:00</updated>
    <media:group>
      <media:description>Aging is the accumulation of damage in your cells over time.

This video is sponsored by nobody. Chapters below.

00:00 Intro</media:description>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:NoDescriptionHere</id>
    <title>A Video With No Description</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=NoDescriptionHere"/>
  </entry>
</feed>`;

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Podcast</title>
    <item>
      <title>Episode 42: The Meaning of Everything</title>
      <link>https://example.com/podcast/42</link>
      <guid isPermaLink="false">example-podcast-42</guid>
      <pubDate>Mon, 03 Aug 2026 09:00:00 GMT</pubDate>
      <description>We talk about the meaning of everything, and also lunch.</description>
    </item>
  </channel>
</rss>`;

describe("seed/rss — parseFeed", () => {
  it("parses a YouTube Atom feed", () => {
    const entries = parseFeed(YOUTUBE_ATOM);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      guid: "yt:video:AbCdEfGhIjK",
      title: "Why Is It So Hard To Cure Aging?",
      url: "https://www.youtube.com/watch?v=AbCdEfGhIjK",
      sourceLabel: "Kurzgesagt – In a Nutshell",
    });
    expect(entries[0].description).toMatch(/accumulation of damage/);
    expect(entries[0].publishedAt).toBeInstanceOf(Date);
  });

  it("parses a generic RSS 2.0 feed", () => {
    const entries = parseFeed(RSS2);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      guid: "example-podcast-42",
      title: "Episode 42: The Meaning of Everything",
      sourceLabel: "Example Podcast",
    });
    expect(entries[0].publishedAt).toBeInstanceOf(Date);
  });

  it("returns [] for a truncated or malformed document rather than throwing", () => {
    expect(parseFeed("<feed><entry><title>oops")).toEqual([]);
    expect(parseFeed("not xml at all")).toEqual([]);
  });

  it("handles entries missing description or published without throwing", () => {
    const bare = parseFeed(YOUTUBE_ATOM).find((e) => e.guid === "yt:video:NoDescriptionHere");
    expect(bare.description).toBeNull();
    expect(bare.publishedAt).toBeNull();
  });
});

describe("seed/select — pickTopic", () => {
  it("picks the newest-published candidate regardless of input order", () => {
    const older = { id: "a", publishedAt: new Date("2026-01-01") };
    const newer = { id: "b", publishedAt: new Date("2026-06-01") };
    expect(pickTopic([older, newer]).id).toBe("b");
    expect(pickTopic([newer, older]).id).toBe("b");
  });

  it("returns null for an empty or missing candidate set", () => {
    expect(pickTopic([])).toBeNull();
    expect(pickTopic(null)).toBeNull();
  });

  it("resolves ties deterministically", () => {
    const a = { id: "a", publishedAt: new Date("2026-01-01") };
    const b = { id: "b", publishedAt: new Date("2026-01-01") };
    expect(pickTopic([a, b]).id).toBe(pickTopic([a, b]).id);
  });
});

describe("seed/feeds — buildDigest", () => {
  it("caps the digest at 400 characters", () => {
    const digest = buildDigest({ title: "T", description: "x".repeat(1000) });
    expect(digest.length).toBeLessThanOrEqual(400);
  });

  it("drops everything after the first blank line before truncating", () => {
    const digest = buildDigest({
      title: "Title",
      description: "First paragraph.\n\nSponsor copy, chapters, links...",
    });
    expect(digest).toBe("Title — First paragraph.");
  });

  it("falls back to just the title with no description", () => {
    expect(buildDigest({ title: "Just a title", description: null })).toBe("Just a title");
  });
});

describe("seed/feeds — nextSeed (DB-backed)", () => {
  it("serves the cached item and marks it used so it cannot repeat", async () => {
    const guid = `test-feed-item-${Math.random().toString(36).slice(2)}`;
    await upsertItems([
      {
        guid,
        feedUrl: "https://example.com/feed.xml",
        sourceLabel: "Test Channel",
        title: "A guaranteed-newest test topic",
        description: "Its publishedAt is decades in the future, so it always wins pickTopic.",
        url: "https://example.com/video",
        publishedAt: new Date("2099-01-01"),
      },
    ]);

    const seed = await nextFeedSeed();
    expect(seed.provider).toBe("feeds");
    expect(seed.topic).toMatch(/guaranteed-newest test topic/);
    expect(seed.sourceLabel).toBe("Test Channel");

    const row = await getPrisma().feedItem.findUnique({ where: { guid } });
    expect(row.usedAt).not.toBeNull();
  });
});

describe("repo/topics — upsertItems", () => {
  it("is idempotent on guid and never clears usedAt on a refresh", async () => {
    const guid = `test-topics-${Math.random().toString(36).slice(2)}`;
    await upsertItems([{ guid, feedUrl: "https://example.com/feed.xml", title: "v1" }]);
    await getPrisma().feedItem.update({ where: { guid }, data: { usedAt: new Date() } });

    // A second refresh of the same feed must update the row, not duplicate it,
    // and must not reset usedAt — that would silently start repeating topics.
    await upsertItems([{ guid, feedUrl: "https://example.com/feed.xml", title: "v2 (refreshed)" }]);

    const row = await getPrisma().feedItem.findUnique({ where: { guid } });
    expect(row.title).toBe("v2 (refreshed)");
    expect(row.usedAt).not.toBeNull();
    expect(await getPrisma().feedItem.count({ where: { guid } })).toBe(1);
  });
});

describe("seed/index — provider fall-through (injectable chain)", () => {
  it("falls through to local when a provider returns null", async () => {
    const dead = { nextSeed: async () => null };
    const seed = await nextSeed([dead, local]);
    expect(seed.provider).toBe("local");
  });

  it("falls through to local when a provider throws", async () => {
    const broken = {
      nextSeed: async () => {
        throw new Error("feed unreachable");
      },
    };
    const seed = await nextSeed([broken, local]);
    expect(seed.provider).toBe("local");
  });

  it("configuredFeeds parses SOURCE_FEEDS into a trimmed, non-empty list", () => {
    const original = process.env.SOURCE_FEEDS;
    try {
      delete process.env.SOURCE_FEEDS;
      expect(configuredFeeds()).toEqual([]);
      process.env.SOURCE_FEEDS = "https://a.example/feed.xml, https://b.example/feed.xml ,,";
      expect(configuredFeeds()).toEqual(["https://a.example/feed.xml", "https://b.example/feed.xml"]);
    } finally {
      if (original === undefined) delete process.env.SOURCE_FEEDS;
      else process.env.SOURCE_FEEDS = original;
    }
  });
});
