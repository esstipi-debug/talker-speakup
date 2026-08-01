/**
 * Wraps a metered provider (Azure) with a monthly spend guard. Before
 * delegating, refuses to spend further once the guard reports over cap and
 * serves `fallback` instead — silently, from the caller's point of view, per
 * principle #3 ("degrade, never break"). This is a spending policy, not an
 * outage: unlike a real provider failure (which still 502s per design §7 /
 * Task 14), falling back to a legitimate, documented provider is honest — the
 * returned report's own `pronProvider` field says so, because `fallback`
 * stamps that field on itself rather than trusting a caller to relabel it.
 * After a successful metered call, records the provider's own reported
 * `durationSec` as actual usage, avoiding the need to probe audio duration
 * before sending. Two failure modes are treated as non-fatal to the
 * already-obtained report: a metered report with no numeric `durationSec`
 * (logged loudly — the spend cap silently stops tracking usage otherwise)
 * and a `recordUsage()` write that throws (logged and swallowed — the
 * metered call already succeeded and was already billed by the provider, so
 * losing the bookkeeping write must never discard it).
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
      try {
        this.guard.recordUsage(report.durationSec);
      } catch (err) {
        // The metered call already succeeded (and was already billed by the
        // provider) — a bookkeeping write failure (disk full, permissions)
        // must never destroy an already-correct, already-paid-for report.
        console.error(
          "[pron] failed to record azure usage after a successful metered call — returning the report anyway:",
          err,
        );
      }
    } else {
      // Without a numeric durationSec the guard has nothing to meter for
      // this call — the monthly spend cap silently stops functioning from
      // here on. An inert cap is worse than a noisy log line.
      console.warn(
        "[pron] metered provider report has no numeric durationSec — the spend cap cannot track usage for this call.",
      );
    }
    return report;
  }

  async health() {
    return this.metered.health();
  }
}
