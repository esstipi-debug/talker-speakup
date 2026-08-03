/**
 * Placeholder XP: rewards saying more, bounded.
 * M2 shipped the real delivery metrics (session fluency + a hesitation band,
 * from objective signals — see metrics/delivery.js). They are reported to the
 * learner directly rather than folded into this number.
 */
export function basicXp(utterance = "") {
  const words = String(utterance).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.min(50, 8 + words * 2));
}
