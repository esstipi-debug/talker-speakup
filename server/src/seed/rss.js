/**
 * The only file that fetches or parses a feed. Everything downstream sees
 * plain { guid, title, description, url, publishedAt, sourceLabel } objects —
 * when YouTube changes its Atom output, exactly one file changes.
 */
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

const FETCH_TIMEOUT_MS = 5000;
// Checked after the body is fully read rather than mid-stream — cheap and
// enough for an operator's own feed URLs (§9). A malicious server could still
// force the full read; that ceiling is fine for a single-user localhost tool.
const MAX_RESPONSE_CHARS = 2_000_000;

/** I/O — thin, not unit-tested. */
export async function fetchFeed(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported feed URL scheme: ${parsed.protocol}`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error("feed response too large");
  return body;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(node) {
  if (node == null) return null;
  if (typeof node === "string") return node || null;
  if (typeof node === "object") return node["#text"] ?? null;
  return String(node);
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseAtom(feed) {
  const channelAuthor = text(feed.author?.name);
  return asArray(feed.entry).map((entry) => {
    const link = asArray(entry.link).find((l) => !l?.["@_rel"] || l["@_rel"] === "alternate");
    return {
      guid: text(entry.id) ?? link?.["@_href"] ?? null,
      title: text(entry.title) ?? "",
      description: text(entry["media:group"]?.["media:description"]) ?? text(entry.summary) ?? null,
      url: link?.["@_href"] ?? null,
      publishedAt: parseDate(text(entry.published) ?? text(entry.updated)),
      sourceLabel: text(entry.author?.name) ?? channelAuthor,
    };
  });
}

function parseRss(channel) {
  const channelTitle = text(channel.title);
  return asArray(channel.item).map((item) => ({
    guid: text(item.guid) ?? text(item.link) ?? null,
    title: text(item.title) ?? "",
    description: text(item.description) ?? null,
    url: text(item.link) ?? null,
    publishedAt: parseDate(text(item.pubDate)),
    sourceLabel: channelTitle,
  }));
}

/**
 * Pure — fixtures, no network, unit-tested. A truncated or malformed document
 * returns [] rather than throwing: one dead feed must not break the others
 * (spec §7).
 */
export function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const entries = doc?.feed ? parseAtom(doc.feed) : doc?.rss?.channel ? parseRss(doc.rss.channel) : [];
  return entries.filter((entry) => entry.guid && entry.title);
}
