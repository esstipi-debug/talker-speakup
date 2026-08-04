/**
 * Pure: choose the newest unused item across all feeds. No per-channel
 * weighting — one line to change once there's evidence a prolific channel
 * dominating a quiet one is actually a problem (spec §5).
 */
function timeOf(item) {
  return item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
}

export function pickTopic(candidates) {
  if (!candidates || candidates.length === 0) return null;
  return candidates.reduce((newest, item) => (timeOf(item) > timeOf(newest) ? item : newest));
}
