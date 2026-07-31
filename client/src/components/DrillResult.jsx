import PhonemeScore from "./PhonemeScore.jsx";

/**
 * Overall scores plus the actionable errors. The list is already capped and
 * ranked by `rankPronErrors` (design §6) — this component never re-orders or
 * re-slices it.
 */
export default function DrillResult({ report, errors, scoringUnavailable, onRetry, onNext }) {
  if (scoringUnavailable) {
    return (
      <div className="space-y-4">
        <p
          role="status"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        >
          Scoring is offline — this round is listen-and-repeat. Say the sentence back, then keep
          going. No score this time.
        </p>
        <Actions onRetry={onRetry} onNext={onNext} />
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-2">
        <Score label="Accuracy" value={report.overall.accuracy} />
        <Score label="Fluency" value={report.overall.fluency} />
        <Score label="Completeness" value={report.overall.completeness} />
      </dl>

      {errors.length > 0 ? (
        <ol className="space-y-1.5">
          {errors.map((e) => (
            <li
              key={`${e.wordIndex}-${e.phoneIndex}`}
              className="text-sm rounded-xl border border-line bg-ink-2 px-3 py-2"
            >
              <strong className="text-coach-soft">{e.word}</strong>{" "}
              {e.substituted
                ? `— you said /${e.substituted}/ where /${e.ipa}/ was expected`
                : `— /${e.ipa}/ came out unclear`}
              {e.impact === 2 && (
                <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-red-500/30 text-red-300">
                  changes the word
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-accent">Nothing to fix on that one — it came through clearly.</p>
      )}

      <PhonemeScore words={report.words} />
      <Actions onRetry={onRetry} onNext={onNext} />
    </div>
  );
}

function Score({ label, value }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-2xl font-semibold text-coach-soft">{value}</dd>
    </div>
  );
}

function Actions({ onRetry, onNext }) {
  return (
    <div className="flex gap-2 justify-end">
      <button
        type="button"
        onClick={onRetry}
        className="px-3 py-2 rounded-xl border border-line text-sm hover:border-coach/60 hover:text-coach-soft transition"
      >
        Try again
      </button>
      <button
        type="button"
        onClick={onNext}
        className="px-4 py-2 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition"
      >
        Next sentence
      </button>
    </div>
  );
}
