const MISTRAL_BASE = "https://api.mistral.ai/v1";
const TIMEOUT_MS = 8000;

/**
 * The pedagogical pass. Deliberately NOT built on brain/: they share a
 * provider and a key, not an interface. brain/ has a conversational contract
 * (evaluateTurn -> coach_reply); this has an analytical one (text -> JSON).
 *
 * Never throws. A failure here costs the upgrades channel, never the turn.
 */
export async function requestUpgrades({ utterance, history = [], harperFindings = [] }) {
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) return { status: "skipped", upgrades: [], extraCorrections: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${MISTRAL_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.MISTRAL_MODEL?.trim() || "mistral-small-latest",
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt(utterance, history, harperFindings) },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[feedback] upgrades pass HTTP ${res.status}`);
      return { status: "failed", upgrades: [], extraCorrections: [] };
    }

    const data = await res.json();
    const parsed = parseStrict(data?.choices?.[0]?.message?.content);
    if (!parsed) return { status: "failed", upgrades: [], extraCorrections: [] };

    return {
      status: "ok",
      // The quoting guard is the load-bearing validation here (spec §8).
      upgrades: (parsed.upgrades ?? []).filter((u) => quotesTheLearner(u, utterance)).map(cleanUpgrade),
      extraCorrections: (parsed.corrections ?? []).filter((c) => quotesTheLearner(c, utterance)).map(cleanCorrection),
    };
  } catch (err) {
    console.warn("[feedback] upgrades pass failed:", err.message);
    return { status: "failed", upgrades: [], extraCorrections: [] };
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM = `You are a C1–C2 English coach analysing one utterance from a Spanish-speaking adult learner.

Return ONLY JSON of this exact shape:
{"upgrades":[{"original":"...","upgraded":"...","why":"..."}],"corrections":[{"original":"...","suggestion":"...","message":"..."}]}

"upgrades" is the important channel: language that is already CORRECT but plain, and what a C1 speaker would have reached for instead — collocation, phrasal verb, register, naturalness. At most 2.
"corrections" is only for real errors that rule-based checking would miss (register, collocation, word choice). At most 2.

HARD RULE: every "original" MUST be copied verbatim, character for character, from the learner's utterance. Never paraphrase it, never correct it, never invent it. If you cannot quote it exactly, omit the item.
Do not comment on pronunciation. Do not add fields.`;

function userPrompt(utterance, history, harperFindings) {
  const context = history.slice(-4).map((m) => `${m.role}: ${m.text}`).join("\n") || "(none)";
  const covered = harperFindings.length
    ? harperFindings.map((f) => `- "${f.original}": ${f.message}`).join("\n")
    : "(none)";
  return `Recent conversation:\n${context}\n\nLearner's utterance:\n${utterance}\n\nAlready covered by rule-based checking — do NOT repeat these:\n${covered}`;
}

function parseStrict(content) {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.upgrades && !Array.isArray(parsed.upgrades)) return null;
    if (parsed.corrections && !Array.isArray(parsed.corrections)) return null;
    return parsed;
  } catch {
    // No retry: it doubles cost and latency for a panel nobody is blocked on.
    return null;
  }
}

/**
 * An item quoting words the learner never said destroys trust in the whole
 * panel, irrecoverably. Substring check against the exact utterance.
 */
function quotesTheLearner(item, utterance) {
  const original = item?.original;
  if (typeof original !== "string" || !original.trim()) return false;
  const kept = utterance.includes(original);
  if (!kept) console.warn(`[feedback] dropped hallucinated quote: ${JSON.stringify(original)}`);
  return kept;
}

function cleanUpgrade(u) {
  return { original: u.original, upgraded: String(u.upgraded ?? ""), why: String(u.why ?? "") };
}

function cleanCorrection(c) {
  return { original: c.original, suggestion: String(c.suggestion ?? ""), message: String(c.message ?? "") };
}
