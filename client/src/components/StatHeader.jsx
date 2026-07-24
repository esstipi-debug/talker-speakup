const XP_PER_LEVEL = 100;

export default function StatHeader({ totalXp = 0, turns = 0, brain, tts, stt }) {
  const level = Math.floor(totalXp / XP_PER_LEVEL) + 1;
  const xpInLevel = totalXp % XP_PER_LEVEL;
  const pct = Math.round((xpInLevel / XP_PER_LEVEL) * 100);

  return (
    <header className="flex items-center gap-4 px-5 py-4 border-b border-line/70">
      <div className="flex items-center gap-3">
        <div className="grid place-items-center w-10 h-10 rounded-2xl bg-coach/20 text-coach text-xl shadow-inner">
          🎙️
        </div>
        <div>
          <h1 className="text-lg font-bold leading-none tracking-tight">SpeakUp</h1>
          <p className="text-[11px] text-muted mt-1">your personal English coach</p>
        </div>
      </div>

      {/* XP / level */}
      <div className="flex-1 max-w-sm mx-auto">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-xs font-semibold text-coach-soft">Level {level}</span>
          <span className="text-[11px] text-muted">{xpInLevel} / {XP_PER_LEVEL} XP</span>
        </div>
        <div className="h-2 rounded-full bg-ink-2 overflow-hidden ring-1 ring-line/60">
          <div
            className="h-full rounded-full bg-gradient-to-r from-coach to-accent transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center gap-4 text-right">
        <Stat label="turns" value={turns} />
        <div className="flex flex-col items-end gap-1">
          {brain && (
            <span
              title="active LLM brain"
              className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border ${
                brain === "mistral"
                  ? "border-accent/50 text-accent"
                  : "border-line text-muted"
              }`}
            >
              {brain}
            </span>
          )}
          {tts && (
            <span
              title="active coach voice"
              className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border ${
                tts === "kokoro"
                  ? "border-coach/50 text-coach-soft"
                  : "border-line text-muted"
              }`}
            >
              🔊 {tts}
            </span>
          )}
          {stt && stt !== "none" && (
            <span
              title="server-side speech-to-text"
              className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-accent/50 text-accent"
            >
              🎙️ {stt}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value }) {
  return (
    <div className="leading-none">
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted mt-1">{label}</div>
    </div>
  );
}
