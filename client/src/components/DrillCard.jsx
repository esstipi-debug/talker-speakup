const STATUS_HINT = {
  prompt: "Read the sentence out loud, then stop the take.",
  recording: "Recording — say the whole sentence, then stop.",
  scoring: "Scoring your pronunciation…",
};

/**
 * Reference sentence + capture controls. `status` is the drill machine's state
 * narrowed to the three this card can be in; anything else renders `prompt`.
 */
export default function DrillCard({ prompt, status, micSupported, onStart, onStop, onCancel }) {
  if (!micSupported) {
    return (
      <p
        role="status"
        className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
      >
        The drill needs a microphone — there is nothing to score without one. It cannot fall back to
        typing. Allow mic access and reload.
      </p>
    );
  }

  const isRecording = status === "recording";
  const isScoring = status === "scoring";
  const hint = STATUS_HINT[status] ?? STATUS_HINT.prompt;

  return (
    <section
      aria-labelledby="drill-heading"
      className="rounded-2xl border border-line bg-surface-2/60 px-5 py-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="drill-heading" className="text-xs uppercase tracking-wide text-muted">
          Read aloud
        </h2>
        <div className="flex items-center gap-2">
          <span
            data-testid="drill-focus"
            className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-accent/50 text-accent"
          >
            {prompt?.focus ?? "—"}
          </span>
          <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-line text-muted">
            {prompt?.level ?? "—"}
          </span>
        </div>
      </div>

      <p data-testid="drill-reference" className="text-xl leading-snug">
        {prompt?.text ?? ""}
      </p>
      <p className="text-xs text-muted">{prompt?.contrast ?? ""}</p>

      <div className="flex items-center gap-3">
        {isRecording ? (
          <>
            <button
              type="button"
              onClick={onStop}
              className="px-4 py-2.5 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition"
            >
              Stop and score
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 rounded-xl border border-line text-sm text-muted hover:text-coach-soft transition"
            >
              Cancel take
            </button>
            <span className="ml-auto inline-flex items-center gap-2 text-xs text-user">
              <span className="w-2.5 h-2.5 rounded-full bg-user animate-pulse" />
              Recording
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={isScoring || !prompt}
            className="px-4 py-2.5 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition disabled:opacity-40"
          >
            {isScoring ? "Scoring…" : "Record your take"}
          </button>
        )}
      </div>

      <p aria-live="polite" className="text-xs text-muted">
        {hint}
      </p>
    </section>
  );
}
