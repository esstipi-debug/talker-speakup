/**
 * Classify each silent pause as clause-internal or clause-boundary (spec §5.2, M1).
 *
 * Placement — not duration — is the C1-C2 tell. We have no word timings
 * (Chrome exposes none), so the recognizer's own finalization events are the
 * boundary evidence: it finalizes when it decides an utterance ended.
 */

const CLAUSE_END = /[.,;:!?…]\s*$/;

/**
 * @param {Array<{startMs:number,endMs:number,durationMs:number}>} pauses
 * @param {Array<{tMs:number,text:string}>} finalizations worklet-clock timestamps
 */
export function classifyPauses(pauses, finalizations) {
  const marks = [...finalizations].sort((a, b) => a.tMs - b.tMs);

  return pauses.map((p) => ({ ...p, placement: placementFor(p, marks) }));
}

function placementFor(p, marks) {
  const inside = marks.some((m) => m.tMs >= p.startMs && m.tMs <= p.endMs);
  if (inside) return "boundary";

  const before = marks.filter((m) => m.tMs < p.startMs).pop();
  if (before && CLAUSE_END.test(before.text)) return "boundary";

  const after = marks.some((m) => m.tMs > p.endMs);
  return after ? "internal" : "unknown";
}

/** `unknown` is reported but never counted toward the actionable total. */
export function summarise(classified) {
  const internal = classified.filter((c) => c.placement === "internal").length;
  const boundary = classified.filter((c) => c.placement === "boundary").length;
  const unknown = classified.filter((c) => c.placement === "unknown").length;
  return { total: internal + boundary, internal, boundary, unknown };
}
