/** Mic capture for server-side STT (Ruta B). Records raw audio via MediaRecorder
 *  instead of transcribing in-browser — see lib/speech.js for the Web Speech path. */

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export function isAudioRecordingSupported() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickSupportedMimeType() {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Requests the mic and starts recording. Resolves to null if unsupported or
 * permission is denied (onError already called in that case) — caller should
 * fall back to the text input.
 *
 * @returns {Promise<{ stop: () => Promise<Blob> } | null>}
 */
export async function startAudioRecording({ onError } = {}) {
  if (!isAudioRecordingSupported()) return null;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    onError?.(err.name || "mic-error");
    return null;
  }

  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => onError?.(e.error?.name || "recorder-error");

  recorder.start();

  return {
    /** Stops recording, releases the mic, and resolves with the recorded clip. */
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.stop();
      }),
  };
}
