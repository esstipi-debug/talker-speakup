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

/**
 * The system prompt for the coach's FIRST turn, when the learner has not
 * spoken yet.
 *
 * The topic is a SUBJECT, never an artefact: the coach discusses the thing
 * itself and never mentions a video, a channel, or that anything is recent.
 * That is what lets the same prompt work whether the topic came from a fixed
 * rotation or from a feed the learner may not have watched — see the M8 spec's
 * D2. It also means a stale topic is indistinguishable from a fresh one, which
 * is why phase 2 needs no expiry logic at all.
 *
 * The topic is delimited because in phase 2 it is untrusted text lifted from a
 * feed. Splicing it into the instruction text would let a title read as an
 * instruction.
 *
 * `topic` may be null (the seed chain failed, or — in phase 2 — a provider
 * legitimately returned nothing). There is no subject to hand the model in
 * that case, so no <topic> block is emitted at all: interpolating a missing
 * topic would put the literal string "null" in front of the model instead.
 */
export function buildOpeningPrompt(topic) {
  const opening = topic
    ? `Open by raising the subject inside the <topic> block below and asking for their opinion on it. Be concrete and specific — never "what would you like to talk about?", which hands the work back to them.

NEVER assume the learner has seen, read, heard or watched anything. Do not mention a video, a channel, an article, or that the subject is recent or new. Discuss the subject itself.

If they steer the conversation elsewhere, follow them. The topic is a starting point, not a rail.

<topic>
${topic}
</topic>`
    : `There is no topic to open with. Ask a concrete, specific opening question of your own to get them talking — never "what would you like to talk about?", which hands the work back to them.`;

  return `${selectCoachPrompt()}

THIS IS YOUR OPENING LINE. The learner has not said anything yet.

${opening}`;
}
