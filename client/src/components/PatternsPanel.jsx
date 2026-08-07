import { useEffect, useState } from "react";
import { getPatterns } from "../lib/api.js";

const MS_PER_DAY = 86_400_000;

/** "1 day ago" vs "3 days ago" — no dependency needed for a single plural rule. */
function daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / MS_PER_DAY));
}

/**
 * Status shown with its evidence beside it, as visible text (spec §7) —
 * never a bare label, never in a title attribute. `pattern` (the mangled
 * lexical key) is never part of this string; `example` is what the learner
 * recognises.
 *
 * `type === "vocab"` rows are upgrades — correct-but-plain language, never a
 * mistake (M2's whole reason for a separate upgrades channel). Calling one
 * "still slipping" would teach that plain English is an error, exactly what
 * M2 exists to avoid — so vocab rows get their own, non-mistake framing.
 */
function evidenceLine(row) {
  const parts = [];
  const isUpgrade = row.type === "vocab";
  if (row.status === "resolved") parts.push(isUpgrade ? "reaching for it naturally" : "clean");
  else if (row.status === "improving") {
    const n = row.probesPassed;
    parts.push(isUpgrade ? `used it well ${n} time${n === 1 ? "" : "s"}` : `passed ${n} check${n === 1 ? "" : "s"}`);
  } else parts.push(isUpgrade ? "worth reaching for" : "still slipping");

  const days = daysAgo(row.lastSeenAt);
  if (days !== null) parts.push(`last seen ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`);

  return parts.join(" · ");
}

/**
 * Read-only patterns view (spec D4). Fetches lazily on the closed->open
 * transition rather than on every mount, so the header affordance costs
 * nothing until the learner actually opens it.
 *
 * A failed fetch is its own state, distinct from a genuinely empty ledger
 * (spec §8: "GET /patterns fails → the panel shows its own error"). Never
 * throws itself — `getPatterns()` resolves `null` on any failure, which is
 * exactly what distinguishes "failed" from "empty" here.
 */
export default function PatternsPanel({ open }) {
  const [status, setStatus] = useState("loading"); // "loading" | "error" | "ready"
  const [patterns, setPatterns] = useState([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    getPatterns().then((data) => {
      if (cancelled) return;
      if (data === null) {
        setStatus("error");
        return;
      }
      setPatterns(data.patterns ?? []);
      setStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <section
      aria-label="Your recurring patterns"
      className="mx-5 mb-4 rounded-2xl border border-line/70 bg-ink-2/60 p-3 text-sm max-h-64 overflow-y-auto"
    >
      {status === "loading" && <p className="text-muted text-[12px]">Loading…</p>}
      {status === "error" && (
        <p className="text-muted text-[12px]">Couldn't load your patterns — try again in a moment.</p>
      )}
      {status === "ready" && patterns.length === 0 && (
        <p className="text-muted text-[12px]">Nothing recorded yet — keep talking.</p>
      )}
      {status === "ready" &&
        patterns.map((row) => (
          <div key={row.pattern} className="mb-2 last:mb-0">
            <p className="leading-snug">{row.example}</p>
            <p className="text-[12px] text-muted mt-0.5">{evidenceLine(row)}</p>
          </div>
        ))}
    </section>
  );
}
