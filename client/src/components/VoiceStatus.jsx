const STATUS_LABEL = {
  idle: "",
  listening: "Listening… tap stop when you're done",
  review: "Review and send",
  thinking: "Coach is composing a reply…",
  speaking: "Coach is speaking",
};

/**
 * Status line (aria-live) + banners. The single `error` string is a transient
 * per-turn failure; the TTS fallback is an event notice; no-Web-Speech is a
 * derived capability warning. There is no client-observable synthesis phase.
 */
export default function VoiceStatus({
  status,
  liveTranscript,
  error,
  ttsFallbackActive,
  sttSupported,
  onDismissError,
}) {
  return (
    <div className="space-y-2">
      <div aria-live="polite" className="min-h-4 text-xs text-muted">
        {status === "listening" && liveTranscript
          ? liveTranscript
          : STATUS_LABEL[status] || ""}
      </div>

      {!sttSupported && (
        <p className="text-xs text-muted">
          This browser lacks speech recognition — use the text box (Chrome/Edge work best).
        </p>
      )}

      {ttsFallbackActive && (
        <div
          role="alert"
          className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2"
        >
          Coach voice unavailable — using browser voice.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            className="text-red-300/70 hover:text-red-200"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
