/**
 * One plain sentence about where the learner breathed. No chart, no number
 * badge, no colour coding — "move the breath to the comma" is a tomorrow
 * instruction, not a three-seconds-from-now one (spec §7.4).
 *
 * Deliberately NOT a live region: VoiceStatus already owns the single polite
 * announcement, and aria-live is inherited by descendants (spec §8.1).
 */
export default function PauseNote({ note }) {
  if (!note) return null;
  return (
    <p className="text-xs text-muted pl-1 italic border-l-2 border-line/60 ml-1">
      {note}
    </p>
  );
}
