import { basicXp } from "./scoring.js";
import { selectCoachPrompt } from "../prompts/coach-system.js";

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

  async evaluateTurn({ userUtterance, history = [] }) {
    const messages = [
      { role: "system", content: selectCoachPrompt() },
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
}
