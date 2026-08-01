import { usePronunciationDrill } from "../hooks/usePronunciationDrill.js";
import DrillCard from "./DrillCard.jsx";
import DrillResult from "./DrillResult.jsx";

/** Container for the pronunciation drill: owns nothing, composes everything. */
export default function DrillPanel({ focus = null }) {
  const d = usePronunciationDrill({ focus });

  if (d.status === "loading") {
    return <p className="px-5 py-6 text-sm text-muted">Loading drills…</p>;
  }

  // No mic, or the prompt set never arrived: there is no drill to show, only a reason.
  if (d.status === "unavailable" && !d.scoringUnavailable && !d.prompt) {
    return (
      <div className="px-5 py-6">
        <p
          role="status"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        >
          {d.error ?? "The pronunciation drill is unavailable right now."}
        </p>
      </div>
    );
  }

  const showResult = d.status === "result" || d.status === "unavailable";

  return (
    <div className="px-5 py-6 space-y-4">
      {d.error && !showResult && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          <span className="flex-1">{d.error}</span>
          <button
            type="button"
            onClick={d.clearError}
            aria-label="Dismiss error"
            className="text-red-300/70 hover:text-red-200 transition"
          >
            ✕
          </button>
        </p>
      )}

      {showResult ? (
        <DrillResult
          report={d.report}
          errors={d.errors}
          scoringUnavailable={d.scoringUnavailable}
          onRetry={d.retry}
          onNext={d.nextPrompt}
        />
      ) : (
        <DrillCard
          prompt={d.prompt}
          status={d.status}
          micSupported={d.micSupported}
          onStart={d.startRecording}
          onStop={d.stopRecording}
          onCancel={d.cancelRecording}
        />
      )}

      <p className="text-xs text-muted">
        Attempts this session: {d.attempts}
        {d.pronProvider ? ` · scorer: ${d.pronProvider}` : ""}
      </p>
    </div>
  );
}
