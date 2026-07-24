const LABELS = {
  idle: "Tap to speak",
  listening: "Listening…",
  thinking: "Coach is thinking",
  speaking: "Coach is speaking",
};

export default function MicButton({ status = "idle", onClick, disabled }) {
  const isListening = status === "listening";
  const busy = status === "thinking" || status === "speaking";

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <div className="relative grid place-items-center">
        {isListening && (
          <span className="absolute w-20 h-20 rounded-full bg-user/40 animate-pulse-ring" />
        )}
        <button
          onClick={onClick}
          disabled={disabled || busy}
          aria-label={LABELS[status]}
          className={`relative grid place-items-center w-20 h-20 rounded-full text-3xl transition-all duration-200 ring-1
            ${
              isListening
                ? "bg-user text-ink ring-user/60 scale-105"
                : busy
                ? "bg-surface-2 text-muted ring-line cursor-not-allowed"
                : "bg-coach text-white ring-coach/50 hover:scale-105 hover:shadow-[0_0_30px_-4px] hover:shadow-coach active:scale-95"
            }`}
        >
          {busy ? <ThinkingDots /> : isListening ? "■" : "🎤"}
        </button>
      </div>
      <span className="text-xs text-muted h-4">{LABELS[status]}</span>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="flex items-end gap-1 text-coach-soft text-lg leading-none">
      <span className="dot">•</span>
      <span className="dot">•</span>
      <span className="dot">•</span>
    </span>
  );
}
