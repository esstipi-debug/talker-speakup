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

  /**
   * The $0 opener. It cannot reason about a topic, so it states it and asks
   * for an opinion — which is structurally the right move even when the
   * wording is wooden. The loop is demonstrable with no key; the pedagogy is
   * the real brain's job.
   */
  async openTurn({ topic }) {
    const subject = topic ? `Here's something I've been chewing on: ${topic}. Where do you land on it?`
                          : "Let's get straight into it — tell me about something that annoyed you this week, and why.";
    return { coach_reply: subject, xp: 0 };
  }
}
