import { basicXp } from "./scoring.js";

/**
 * Offline, zero-key brain. Keeps the loop demonstrable without an LLM.
 * It echoes a bit of what you said and asks a rotating follow-up so a
 * 3-turn conversation feels alive. Real coaching = MistralBrain.
 */
const FOLLOWUPS = [
  "Tell me more — what happened next?",
  "Nice. And how did that make you feel?",
  "Interesting! Why do you think that is?",
  "Cool — can you give me an example?",
  "I see. What would you do differently next time?",
];

export class MockBrain {
  async evaluateTurn({ userUtterance, history = [] }) {
    const turnIndex = history.filter((m) => m?.role === "user").length;
    const followup = FOLLOWUPS[turnIndex % FOLLOWUPS.length];
    const echo =
      userUtterance.length > 60 ? `${userUtterance.slice(0, 57)}…` : userUtterance;

    return {
      coach_reply: `You said: "${echo}". ${followup}`,
      xp: basicXp(userUtterance),
    };
  }
}
