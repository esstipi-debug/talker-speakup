const XP_PER_LEVEL = 100;

const REASON_TEXT = {
  "missing-mistral-key": "no Mistral API key",
  "tts-unreachable": "TTS unreachable",
};

/**
 * The whole story in one string, because it is also the accessible name:
 * colour alone must never be the thing that says "degraded".
 */
function modeLabel(mode) {
  let label = `mode ${mode.effective}`;
  if (mode.requested !== mode.effective) label += `, requested ${mode.requested}`;
  if (mode.degraded && mode.reasons.length > 0) {
    label += `, degraded: ${mode.reasons.map((r) => REASON_TEXT[r] ?? r).join(", ")}`;
  }
  return label;
}

export default function StatHeader({ totalXp = 0, turns = 0, sessionFluency = null, brain, tts, stt, mode, onTogglePatterns, patternsOpen = false }) {
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
        {sessionFluency !== null && (
          <div className="w-20" aria-label="delivery pace this session">
            <div className="h-1.5 rounded-full bg-ink-2 overflow-hidden ring-1 ring-line/60">
              <div
                className="h-full rounded-full bg-user transition-all duration-500"
                style={{ width: `${sessionFluency}%` }}
              />
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted mt-1">pace</div>
          </div>
        )}
        {onTogglePatterns && (
          <button
            type="button"
            onClick={onTogglePatterns}
            aria-pressed={patternsOpen}
            className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border transition ${
              patternsOpen ? "border-accent/60 text-accent" : "border-line text-muted hover:text-coach-soft hover:border-coach/50"
            }`}
          >
            📋 Patterns
          </button>
        )}
        <Stat label="turns" value={turns} />
        <div className="flex flex-col items-end gap-1">
          {mode && (
            <span
              aria-label={modeLabel(mode)}
              title={modeLabel(mode)}
              className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border ${
                mode.degraded
                  ? "border-user/60 text-user"
                  : "border-coach/50 text-coach-soft"
              }`}
            >
              {mode.degraded ? `${mode.effective} !` : mode.effective}
            </span>
          )}
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
              title="configured coach voice"
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
