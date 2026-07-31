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

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pickSupportedMimeType() {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Requests the mic and starts a drill take. Resolves null (never throws) when
 * recording is unsupported or permission is refused — `onError` has already
 * fired in that case and the caller falls back to listen-and-repeat.
 *
 * @param {{ maxMs?: number, onError?: (code: string) => void, onAutoStop?: () => void }} [opts]
 * @returns {Promise<RecorderHandle|null>}
 */
export async function startRecording({ maxMs = MAX_DRILL_MS, onError, onAutoStop } = {}) {
  if (!isRecordingSupported()) {
    onError?.("unsupported");
    return null;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const startedAt = Date.now();

  let state = "recording";
  let handed = false; // a stop() result has already been handed to a caller
  let released = false;
  let maxTimer = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  function release() {
    if (released) return;
    released = true;
    if (maxTimer !== null) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
    stream.getTracks().forEach((track) => track.stop());
  }

  recorder.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => onError?.(e.error?.name || "recorder-error");
  recorder.onstop = () => {
    release();
    if (state === "cancelled") {
      resolveStopped(null);
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "" });
    if (blob.size === 0) {
      onError?.("empty-recording");
      resolveStopped(null);
      return;
    }
    resolveStopped({ blob, durationMs: Date.now() - startedAt });
  };

  recorder.start();
  maxTimer = setTimeout(() => {
    maxTimer = null;
    if (state !== "recording") return;
    state = "stopped";
    onAutoStop?.();
    recorder.stop();
  }, maxMs);

  return {
    mimeType: recorder.mimeType || mimeType || "",
    state: () => state,
    stop() {
      if (handed) return Promise.resolve(null);
      handed = true;
      if (state === "recording") {
        state = "stopped";
        recorder.stop();
      }
      return stopped;
    },
    cancel() {
      if (state === "cancelled") return;
      const wasRecording = state === "recording";
      state = "cancelled";
      chunks.length = 0;
      release();
      if (wasRecording) recorder.stop();
      resolveStopped(null);
    },
  };
}
