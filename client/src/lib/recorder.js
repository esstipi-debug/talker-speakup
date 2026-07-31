/** Isolated MediaRecorder wrapper for the pronunciation drill. Rebuilt from
 *  scratch (design §10) — deliberately NOT restored from the removed Ruta B
 *  orchestration. lib/audio.js is untouched and stays dead. */

export const MAX_DRILL_MS = 15000; // hard cap so a stuck drill take can't record forever
export const MIN_DRILL_MS = 300; // shorter than this is a mis-tap, not an attempt

export function isRecordingSupported() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}
