const LABELS = {
  idle: "Tap to speak",
  listening: "Stop recording",
  thinking: "Coach is thinking",
  speaking: "Interrupt coach and speak",
};

export default function MicButton({ status = "idle", onClick, disabled, ref }) {
  const isListening = status === "listening";
  const isSpeaking = status === "speaking";
  // Only `thinking` blocks the button; `speaking` is the barge-in control.
  const blocked = status === "thinking";

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <div className="relative grid place-items-center">
        {isListening && (
          <span className="absolute w-20 h-20 rounded-full bg-user/40 animate-pulse-ring" />
        )}
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          disabled={disabled || blocked}
          aria-label={LABELS[status]}
          className={`relative grid place-items-center w-20 h-20 rounded-full text-3xl transition-all duration-200 ring-1
            ${
              isListening
                ? "bg-user text-ink ring-user/60 scale-105"
                : isSpeaking
                ? "bg-coach/70 text-white ring-coach/50 hover:scale-105"
                : blocked
                ? "bg-surface-2 text-muted ring-line cursor-not-allowed"
                : "bg-coach text-white ring-coach/50 hover:scale-105 hover:shadow-[0_0_30px_-4px] hover:shadow-coach active:scale-95"
            }`}
        >
          {blocked ? <ThinkingDots /> : isListening ? "■" : isSpeaking ? "✋" : "🎤"}
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
