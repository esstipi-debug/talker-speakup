/**
 * The preset table is the single definition of what a mode means. A mode
 * controls exactly two slots (spec D1); `auto` controls neither, which is
 * what makes it identical to the pre-modes resolution (spec D2).
 */
const MODES = {
  auto: {},
  web: { brain: "mock", tts: "browser" },
  cloud: { brain: "mistral", tts: "browser" },
  hybrid: { brain: "mistral", tts: "kokoro" },
};

const SERVER_SIDE_TTS = ["kokoro", "voicebox"];

let _mode = null;

/**
 * The only mutable state in this module. null means "no turn has tried to
 * synthesize yet" and never counts as degraded (spec D6) — which is what
 * lets a Kokoro started mid-session recover on the next successful turn.
 */
let _ttsReachable = null;

function parseMode() {
  const flag = process.argv.find((arg) => arg.startsWith("--mode="));
  const raw = (flag ? flag.slice("--mode=".length) : process.env.SPEAKUP_MODE ?? "").trim().toLowerCase();

  if (!raw) return "auto";
  if (!Object.hasOwn(MODES, raw)) {
    console.warn(`[mode] unknown mode "${raw}" → falling back to auto.`);
    return "auto";
  }
  return raw;
}

export function resolveMode() {
  if (_mode) return _mode;
  _mode = parseMode();
  console.log(`[mode] requested = ${_mode}`);
  return _mode;
}

/** The requested mode's default for one slot, or null to defer to the legacy chain. */
export function slotDefault(slot) {
  return MODES[resolveMode()][slot] ?? null;
}

/** Called by the turn route on both the success and the failure branch. Never throws. */
export function noteTTSOutcome(ok) {
  _ttsReachable = !!ok;
}

function nameFor(brain, tts) {
  for (const [name, slots] of Object.entries(MODES)) {
    if (name === "auto") continue;
    if (slots.brain === brain && slots.tts === tts) return name;
  }
  return "custom";
}

/**
 * Takes the providers as arguments rather than importing the factories: they
 * import this module for their defaults, so importing them back would close a
 * cycle. app.js already holds both and is the caller.
 */
export function modeStatus({ brain, tts }) {
  const requested = resolveMode();
  const wanted = MODES[requested];
  const reasons = [];

  if (wanted.brain === "mistral" && brain !== "mistral") reasons.push("missing-mistral-key");

  // The fact, independent of what was asked for: is the configured server
  // voice actually dead right now? This must hold under auto exactly as
  // under hybrid — the pill must never claim a voice is speaking when the
  // browser is the one actually doing it.
  const serverVoiceDead = SERVER_SIDE_TTS.includes(tts) && _ttsReachable === false;

  // Whether that fact is a broken promise depends on what was requested:
  // auto asked for nothing, so it cannot be disappointed (same rule the
  // brain check gets for free from MODES.auto having no brain key). This
  // gate applies only to the *reason*, never to effectiveTts below.
  if (requested !== "auto" && serverVoiceDead) reasons.push("tts-unreachable");

  // What the learner actually gets: a dead server voice means the client is
  // speaking, so the effective voice is the browser's — unconditionally.
  const effectiveTts = serverVoiceDead ? "browser" : tts;

  return {
    requested,
    effective: nameFor(brain, effectiveTts),
    degraded: reasons.length > 0,
    reasons,
  };
}

export function __resetForTests() {
  _mode = null;
  _ttsReachable = null;
}
