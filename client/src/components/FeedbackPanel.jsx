/**
 * The M2 feedback panel: at most 2 corrections and 1 upgrade (the cap is
 * enforced server-side; this component renders whatever it is given).
 *
 * The two channels are visually distinct on purpose. `corrections` is "you
 * said something wrong". `upgrades` is "you said something correct and grey" —
 * conflating them teaches the learner that plain English is an error.
 *
 * The hesitation band is NEVER labelled "confidence": it measures pausing and
 * self-repair, and the copy says only what the signal supports.
 */
const BAND_COPY = {
  steady: "Steady delivery",
  some: "Some hesitation",
  effortful: "Effortful delivery",
};

/** "1 filler" vs "2 fillers" — no dependency needed for a single plural rule. */
function pluralize(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Builds the visible hesitation detail string, e.g.
 * "3 mid-phrase pauses, 2 fillers, 1 self-repair". Zero counts are omitted
 * entirely — a learner who did not hesitate should not see a list of zeroes.
 * Returns "" when all three counts are zero.
 */
function hesitationDetail(hesitation) {
  const parts = [];
  if (hesitation.midPhrasePauses > 0) parts.push(pluralize(hesitation.midPhrasePauses, "mid-phrase pause"));
  if (hesitation.fillers > 0) parts.push(pluralize(hesitation.fillers, "filler"));
  if (hesitation.selfRepairs > 0) parts.push(pluralize(hesitation.selfRepairs, "self-repair"));
  return parts.join(", ");
}

export default function FeedbackPanel({ feedback }) {
  if (!feedback) return null;
  const { corrections = [], upgrades = [], hesitation, passes } = feedback;

  return (
    <section
      aria-label="Feedback on your last turn"
      className="mt-2 ml-auto max-w-lg rounded-2xl border border-line/70 bg-ink-2/60 p-3 text-sm"
    >
      {corrections.map((c) => (
        <div key={c.pattern} className="mb-2 last:mb-0">
          <p className="leading-snug">
            <span className="line-through text-muted">{c.original}</span>
            <span aria-hidden="true" className="mx-2 text-muted">→</span>
            <span className="font-semibold text-user">{c.suggestion}</span>
          </p>
          <p className="text-[12px] text-muted mt-0.5">{c.message}</p>
        </div>
      ))}

      {upgrades.map((u) => (
        <div key={u.pattern} className="mb-2 last:mb-0 border-l-2 border-accent/60 pl-2">
          <p className="text-[11px] uppercase tracking-wide text-accent">Say it like a native</p>
          <p className="leading-snug">
            <span className="text-muted">{u.original}</span>
            <span aria-hidden="true" className="mx-2 text-muted">→</span>
            <span className="font-semibold text-accent">{u.upgraded}</span>
          </p>
          <p className="text-[12px] text-muted mt-0.5">{u.why}</p>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-muted">
        {hesitation && (
          <span>
            {BAND_COPY[hesitation.band]}
            {hesitationDetail(hesitation) && ` · ${hesitationDetail(hesitation)}`}
          </span>
        )}
        {hesitation?.basis === "text-only" && <span>· measured from typed text only</span>}
        {passes?.pedagogical === "skipped" && <span>· no API key, so no upgrades this turn</span>}
        {passes?.pedagogical === "failed" && <span>· the upgrade pass failed this turn</span>}
        {passes?.mechanical === "unavailable" && <span>· the grammar checker did not load</span>}
        {passes?.mechanical === "failed" && <span>· the grammar checker failed on this turn</span>}
      </div>
    </section>
  );
}
