import { basicXp } from "./scoring.js";
import { selectCoachPrompt, buildOpeningPrompt } from "../prompts/coach-system.js";

const MISTRAL_BASE = "https://api.mistral.ai/v1";

/**
 * Mistral brain (OpenAI-compatible chat endpoint).
 * M1: returns only the next coach line + basic XP (plain text, no JSON mode yet).
 * Structured BrainFeedback + JSON validation arrive in M2.
 */
export class MistralBrain {
  constructor() {
    this.apiKey = process.env.MISTRAL_API_KEY;
    this.model = process.env.MISTRAL_MODEL?.trim() || "mistral-small-latest";
  }

  async evaluateTurn({ userUtterance, history = [], probeDirective = null }) {
    const messages = [
      { role: "system", content: selectCoachPrompt() },
      // M4: a second system message, never concatenated into the base prompt
      // (spec §4.1) — coachSystemM2 stays a single freezable artifact, and
      // the directive is the ephemeral per-turn context it actually is.
      ...(probeDirective ? [{ role: "system", content: probeDirective }] : []),
      ...history.map((m) => ({
        role: m.role === "coach" ? "assistant" : "user",
        content: m.text,
      })),
      { role: "user", content: userUtterance },
    ];

    const res = await fetch(`${MISTRAL_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 200,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mistral API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Mistral returned an empty reply.");

    return { coach_reply: reply, xp: basicXp(userUtterance) };
  }

  async openTurn({ topic }) {
    const messages = [
      { role: "system", content: buildOpeningPrompt(topic) },
      // A stage cue, not learner speech. It never enters the transcript and is
      // never shown. Present because a chat completion with no user message is
      // rejected by some providers — unverified here: no MISTRAL_API_KEY is
      // configured in this worktree, so the step 7 probe could not run.
      { role: "user", content: "Begin." },
    ];

    const res = await fetch(`${MISTRAL_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.8, max_tokens: 200 }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mistral API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Mistral returned an empty opening line.");
    return { coach_reply: reply, xp: 0 };
  }
}
