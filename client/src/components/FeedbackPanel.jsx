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
          <span title={`${hesitation.midPhrasePauses} mid-phrase pauses · ${hesitation.fillers} fillers · ${hesitation.selfRepairs} self-repairs`}>
            {BAND_COPY[hesitation.band]}
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
