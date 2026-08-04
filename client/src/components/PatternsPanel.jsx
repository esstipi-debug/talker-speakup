import { useEffect, useState } from "react";
import { getPatterns } from "../lib/api.js";

/** "1 day ago" vs "3 days ago" — no dependency needed for a single plural rule. */
function daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

/**
 * Status shown with its evidence beside it, as visible text (spec §7) —
 * never a bare label, never in a title attribute. `pattern` (the mangled
 * lexical key) is never part of this string; `example` is what the learner
 * recognises.
 */
function evidenceLine(row) {
  const parts = [];
  if (row.status === "resolved") parts.push("clean");
  else if (row.status === "improving") parts.push(`passed ${row.probesPassed} check${row.probesPassed === 1 ? "" : "s"}`);
  else parts.push("still slipping");

  const days = daysAgo(row.lastSeenAt);
  if (days !== null) parts.push(`last slip ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`);

  return parts.join(" · ");
}

/**
 * Read-only patterns view (spec D4). Fetches lazily on the closed->open
 * transition rather than on every mount, so the header affordance costs
 * nothing until the learner actually opens it.
 */
export default function PatternsPanel({ open }) {
  const [patterns, setPatterns] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getPatterns().then((data) => {
      if (!cancelled) setPatterns(data?.patterns ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <section
      aria-label="Your recurring patterns"
      className="mx-5 mb-4 rounded-2xl border border-line/70 bg-ink-2/60 p-3 text-sm"
    >
      {patterns === null && <p className="text-muted text-[12px]">Loading…</p>}
      {/* Empty state reads as "nothing yet", never as failure — covers both a genuinely empty ledger and a failed fetch (getPatterns never throws). */}
      {patterns?.length === 0 && <p className="text-muted text-[12px]">Nothing recorded yet — keep talking.</p>}
      {patterns?.map((row) => (
        <div key={row.pattern} className="mb-2 last:mb-0">
          <p className="leading-snug">{row.example}</p>
          <p className="text-[12px] text-muted mt-0.5">{evidenceLine(row)}</p>
        </div>
      ))}
    </section>
  );
}
