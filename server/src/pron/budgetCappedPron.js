/**
 * Wraps a metered provider (Azure) with a monthly spend guard. Before
 * delegating, refuses to spend further once the guard reports over cap and
 * serves `fallback` instead — silently, from the caller's point of view, per
 * principle #3 ("degrade, never break"). This is a spending policy, not an
 * outage: unlike a real provider failure (which still 502s per design §7 /
 * Task 14), falling back to a legitimate, documented provider is honest — the
 * returned report's own `pronProvider` field says so. After a successful
 * metered call, records the provider's own reported `durationSec` as actual
 * usage, avoiding the need to probe audio duration before sending.
 */
export class BudgetCappedPron {
  constructor(metered, fallback, guard) {
    this.metered = metered;
    this.fallback = fallback;
    this.guard = guard;
  }

  async assess(audioBuffer, opts) {
    if (this.guard.isOverCap()) {
      return this.fallback.assess(audioBuffer, opts);
    }
    const report = await this.metered.assess(audioBuffer, opts);
    if (typeof report?.durationSec === "number") {
      this.guard.recordUsage(report.durationSec);
    }
    return report;
  }

  async health() {
    return this.metered.health();
  }
}
