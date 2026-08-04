import { getPrisma } from "../db.js";

/**
 * The only module that reads or writes FeedItem. `guid` is the upsert key —
 * a second refresh of the same feed must be idempotent and must never reset
 * `usedAt`, or topics would silently start repeating with nothing to show it.
 */

export async function upsertItems(items) {
  const prisma = getPrisma();
  for (const item of items) {
    const data = {
      feedUrl: item.feedUrl,
      sourceLabel: item.sourceLabel ?? null,
      title: item.title,
      description: item.description ?? null,
      url: item.url ?? null,
      publishedAt: item.publishedAt ?? null,
    };
    await prisma.feedItem.upsert({ where: { guid: item.guid }, update: data, create: { guid: item.guid, ...data } });
  }
}

export async function listUnused() {
  return getPrisma().feedItem.findMany({ where: { usedAt: null } });
}

export async function markUsed(id) {
  await getPrisma().feedItem.update({ where: { id }, data: { usedAt: new Date() } });
}

export async function stats() {
  const prisma = getPrisma();
  const [cached, unused] = await Promise.all([
    prisma.feedItem.count(),
    prisma.feedItem.count({ where: { usedAt: null } }),
  ]);
  return { cached, unused };
}
