import * as local from "./local.js";
import * as feeds from "./feeds.js";

/**
 * Seed provider chain. Each provider returns a seed or null; the first
 * non-null wins. `local` is last and never returns null, so this function
 * cannot fail to produce an opening topic.
 *
 * `feeds` only joins the chain when SOURCE_FEEDS is configured — mirrors
 * brain/index.js's auto-detect shape. A dry or unreachable feed degrades to
 * `local` by falling through, not by an error path.
 *
 * `providers` is a parameter rather than a module-level const so tests can
 * inject a stub chain (e.g. a provider that throws or returns null) without
 * reaching into module internals.
 */
function defaultProviders() {
  return feeds.configuredFeeds().length > 0 ? [feeds, local] : [local];
}

export async function nextSeed(providers = defaultProviders()) {
  for (const provider of providers) {
    try {
      const seed = await provider.nextSeed();
      if (seed) return seed;
    } catch (err) {
      console.warn("[seed] provider failed, falling through:", err.message);
    }
  }
  return null; // unreachable while `local` is terminal; kept so the contract is honest
}
