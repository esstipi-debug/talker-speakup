import fs from "node:fs";

/**
 * Tracks cumulative audio-seconds submitted to a metered pronunciation
 * provider (Azure) during the current calendar month, backed by a small
 * JSON file — not the database, which M3 owns. Deliberately lock-free: a
 * personal, single-process app accepts a few seconds of overshoot under a
 * race rather than the locking scheme a multi-tenant billing system would
 * need. See design spec §13.2.
 */
export class BudgetGuard {
  /**
   * @param {{statePath: string, capUsd: number, ratePerHourUsd: number, now?: () => Date}} opts
   */
  constructor({ statePath, capUsd, ratePerHourUsd, now = () => new Date() }) {
    this.statePath = statePath;
    this.capUsd = capUsd;
    this.ratePerHourUsd = ratePerHourUsd;
    this.now = now;
  }

  _monthKey() {
    const d = this.now();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  _readState() {
    const month = this._monthKey();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (parsed.month === month && typeof parsed.audioSecondsUsed === "number") {
        return { month, audioSecondsUsed: parsed.audioSecondsUsed };
      }
    } catch {
      // missing file, corrupt JSON, or a prior month — start this month fresh.
    }
    return { month, audioSecondsUsed: 0 };
  }

  _writeState(state) {
    fs.writeFileSync(this.statePath, JSON.stringify(state), "utf8");
  }

  /** Estimated dollars spent so far this calendar month, at the configured rate. */
  spentUsd() {
    const { audioSecondsUsed } = this._readState();
    return (audioSecondsUsed / 3600) * this.ratePerHourUsd;
  }

  /** True once this month's estimated spend has met or passed the cap. */
  isOverCap() {
    // Add small tolerance to handle floating-point precision (e.g., 1/0.66*3600 → 0.9999...)
    return this.spentUsd() + 1e-10 >= this.capUsd;
  }

  /** Record actual audio seconds billed for one completed metered call. */
  recordUsage(audioSeconds) {
    const state = this._readState();
    state.audioSecondsUsed += Math.max(0, Number(audioSeconds) || 0);
    this._writeState(state);
  }
}
