/**
 * M1 placeholder XP: rewards saying more, bounded.
 * Real scoring (fluency/confidence-driven) arrives in M2.
 */
export function basicXp(utterance = "") {
  const words = String(utterance).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.min(50, 8 + words * 2));
}
