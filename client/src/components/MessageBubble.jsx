export default function MessageBubble({ role, text, onReplay }) {
  const isCoach = role === "coach";

  return (
    <div className={`flex ${isCoach ? "justify-start" : "justify-end"}`}>
      <div
        className={`group relative max-w-[78%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed shadow-lg ${
          isCoach
            ? "bg-surface-2 border border-line/70 rounded-tl-sm"
            : "bg-gradient-to-br from-user/90 to-user text-ink font-medium rounded-tr-sm"
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`text-[10px] uppercase tracking-wider ${
              isCoach ? "text-coach-soft" : "text-ink/70"
            }`}
          >
            {isCoach ? "Coach" : "You"}
          </span>
          {isCoach && onReplay && (
            <button
              onClick={() => onReplay(text)}
              title="Play again"
              className="opacity-0 group-hover:opacity-100 transition text-muted hover:text-coach-soft text-xs"
            >
              🔊
            </button>
          )}
        </div>
        <p>{text}</p>
      </div>
    </div>
  );
}
