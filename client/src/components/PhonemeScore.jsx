const SCORE_BUCKETS = [
  { min: 80, cls: "text-accent border-accent/50" },
  { min: 60, cls: "text-coach-soft border-coach/50" },
  { min: 0, cls: "text-red-300 border-red-500/30" },
];

function bucketFor(score) {
  return SCORE_BUCKETS.find((b) => score >= b.min) ?? SCORE_BUCKETS[SCORE_BUCKETS.length - 1];
}

/**
 * Per-word / per-phoneme rendering of a scored report. A word whose `phones`
 * key is absent is the unscripted case (design §3) — it renders the word and
 * its accuracy only, and must not throw.
 */
export default function PhonemeScore({ words }) {
  return (
    <ul className="flex flex-wrap gap-2" data-testid="phoneme-score">
      {words.map((word, i) => (
        <li
          key={`${word.word}-${i}`}
          className="rounded-xl border border-line bg-ink-2 px-3 py-2 space-y-1.5"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{word.word}</span>
            <span
              className={`text-[11px] px-1.5 rounded-full border ${bucketFor(word.accuracy).cls}`}
            >
              {word.accuracy}
            </span>
          </div>
          {Array.isArray(word.phones) && (
            <div className="flex flex-wrap gap-1">
              {word.phones.map((phone, j) => (
                <span
                  key={j}
                  title={
                    phone.substituted
                      ? `expected ${phone.ipa}, heard ${phone.substituted}`
                      : `expected ${phone.ipa}`
                  }
                  className={`inline-flex items-baseline gap-1 text-[11px] px-1.5 py-0.5 rounded-md border ${bucketFor(phone.score).cls}`}
                >
                  <span>
                    {phone.ipa}
                    {phone.substituted ? (
                      <>
                        <span aria-hidden="true"> → </span>
                        {phone.substituted}
                      </>
                    ) : null}
                  </span>
                  <span className="opacity-70">{phone.score}</span>
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
