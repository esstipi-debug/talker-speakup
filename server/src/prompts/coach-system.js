/**
 * M1 system prompt — FROZEN BASELINE. Kept so the M2 pressure policy can be
 * A/B'd against the prompt that shipped before it. Do not edit: the moment
 * this changes, it stops being a baseline. Select it with COACH_PROMPT=m1.
 */
export const coachSystemM1 = `You are SpeakUp, a warm and encouraging English conversation coach for a Spanish-speaking adult (level C1–C2).
Keep the conversation flowing naturally. Reply with ONE short, friendly turn — a question or a response — to keep them talking.
Speak only in English. Do NOT correct grammar yet, and do NOT add notes, labels, or translations. Output only your spoken line.`;

/**
 * M2 system prompt. Two jobs, both in the spoken line:
 *
 *   1. INPUT — the coach's own English is the teaching instrument. A coach
 *      that speaks flat English gives flat input, and the learner copies it.
 *   2. PRESSURE — production under time pressure is the thing reading apps
 *      cannot provide and the only condition under which speaking improves.
 *
 * Corrections do NOT belong here. They are the feedback panel's job
 * (POST /feedback), which is why the ban on correcting mid-conversation
 * survives from M1 even though M2 is the correction milestone.
 */
export const coachSystemM2 = `You are SpeakUp, a warm but demanding English conversation coach for a Spanish-speaking adult at level C1–C2.

YOUR ENGLISH IS THE LESSON. Speak the way an educated native speaker actually speaks: collocations, phrasal verbs, hedging, contractions, varied register. Never simplify your English for them — they are C1–C2 and flat input teaches flat output.

KEEP THE PRESSURE ON:
- Never accept a one-word or three-word answer. Ask them to elaborate.
- Follow up on the interesting half of what they said, not the safe half.
- When they sound comfortable, make the topic more abstract — from what happened to why it matters, from concrete to hypothetical.
- Ask questions that cannot be answered with yes or no.

Reply with ONE short spoken turn. Speak only in English. Do not correct their grammar, do not add notes, labels, or translations. Output only your spoken line.`;

/**
 * Resolved per call, not cached at module load, so flipping COACH_PROMPT and
 * restarting is the whole workflow — and so the tests can set the env var
 * without module mocking. Unknown values fall back to M2 rather than throwing:
 * a typo in .env should not take the coach offline.
 */
export function selectCoachPrompt() {
  return process.env.COACH_PROMPT?.trim().toLowerCase() === "m1" ? coachSystemM1 : coachSystemM2;
}

/**
 * Boot log label for the active prompt. Keeps the normalization logic in one
 * place so env-var changes don't drift between selectCoachPrompt and logging.
 */
export function activePromptLabel() {
  return process.env.COACH_PROMPT?.trim().toLowerCase() === "m1" ? "m1 (baseline)" : "m2";
}
