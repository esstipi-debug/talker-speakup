import * as local from "./local.js";

/**
 * Seed provider chain. Each provider returns a seed or null; the first
 * non-null wins. `local` is last and never returns null, so this function
 * cannot fail to produce an opening topic.
 *
 * Phase 2 inserts the RSS-backed `feeds` provider ahead of `local`. That is
 * the entire integration: no caller changes, and a dry or unreachable feed
 * degrades to `local` by falling through, not by an error path.
 */
const PROVIDERS = [local];

export async function nextSeed() {
  for (const provider of PROVIDERS) {
    try {
      const seed = await provider.nextSeed();
      if (seed) return seed;
    } catch (err) {
      console.warn("[seed] provider failed, falling through:", err.message);
    }
  }
  return null; // unreachable while `local` is terminal; kept so the contract is honest
}
