/**
 * useSessionRecorder — React binding for SessionRecorder.
 *
 * Owns the recorder lifecycle and exposes just what the UI needs: a phase, live
 * duration + VU level, a silence flag, and start/stop/cancel controls. Designed
 * to drive MicButton (map `phase` → its `status`) with one recording per press.
 *
 * Render cadence: the raw power callback fires ~60fps, so it is stored in a ref
 * (no render) and published together with duration on a single throttled timer.
 *
 * Usage (container that renders MicButton):
 *
 *   const rec = useSessionRecorder();
 *   const status =
 *     rec.phase === "recording" || rec.phase === "preparing" ? "listening"
 *     : rec.phase === "processing" ? "thinking"
 *     : coachStatus; // "idle" | "thinking" | "speaking" from the turn flow
 *
 *   async function handleMic() {
 *     if (rec.phase === "idle") { await rec.start(problemId); return; }
 *     if (rec.phase === "recording") {
 *       const clip = await rec.stop();
 *       if (clip) await sendTurnAudio(clip.blob, clip.durationMilliseconds, clip.segments);
 *     }
 *   }
 *
 *   return <MicButton status={status} onClick={handleMic} disabled={rec.phase === "preparing"} />;
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SessionRecorder, type RecordingResult } from "./sessionRecorder";

export type RecorderPhase = "idle" | "preparing" | "recording" | "processing";

export interface UseSessionRecorder {
  phase: RecorderPhase;
  isRecording: boolean;
  /** Recorded (un-paused) time in ms, updated ~10×/s while recording. */
  durationMs: number;
  /** Live volume level, roughly 0..100. */
  vuLevel: number;
  /** True after ~20s below the active threshold. */
  isSilent: boolean;
  /** Short reason string on failure (mic denied, unsupported, no-data). */
  error: string | null;
  /** Requests the mic, warms up, and begins recording. Resolves true once recording, false on failure. */
  start: (problemId?: string) => Promise<boolean>;
  /** Stops, releases the mic, and resolves with the clip (or null if nothing was recorded). */
  stop: () => Promise<RecordingResult | null>;
  /** Aborts an in-progress recording and releases the mic without producing a clip. */
  cancel: () => void;
}

const METER_INTERVAL_MS = 100;

export function useSessionRecorder(): UseSessionRecorder {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [durationMs, setDurationMs] = useState(0);
  const [vuLevel, setVuLevel] = useState(0);
  const [isSilent, setIsSilent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<SessionRecorder | null>(null);
  const problemIdRef = useRef<string | null>(null);
  const latestPowerRef = useRef(0);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const stopMeter = useCallback(() => {
    if (meterTimerRef.current !== null) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
  }, []);

  const startMeter = useCallback(() => {
    stopMeter();
    meterTimerRef.current = setInterval(() => {
      const recorder = recorderRef.current;
      if (!recorder) return;
      setDurationMs(recorder.durationMs);
      setVuLevel(latestPowerRef.current);
    }, METER_INTERVAL_MS);
  }, [stopMeter]);

  const releaseRecorder = useCallback(() => {
    stopMeter();
    recorderRef.current?.dispose();
    recorderRef.current = null;
    problemIdRef.current = null;
    latestPowerRef.current = 0;
  }, [stopMeter]);

  const start = useCallback(
    async (problemId?: string): Promise<boolean> => {
      if (recorderRef.current) return true; // already active — treat as success
      setError(null);
      setDurationMs(0);
      setVuLevel(0);
      setIsSilent(false);
      setPhase("preparing");

      const recorder = await SessionRecorder.create({
        onError: (reason) => {
          if (!mountedRef.current) return;
          setError(reason);
        },
        onPower: (level) => {
          latestPowerRef.current = level;
        },
        onSilence: (silent) => {
          if (mountedRef.current) setIsSilent(silent);
        },
      });

      if (!recorder) {
        if (mountedRef.current) setPhase("idle");
        return false;
      }

      // Unmounted (or a second start raced in) while awaiting getUserMedia — don't leak the mic.
      if (!mountedRef.current || recorderRef.current) {
        recorder.dispose();
        return false;
      }

      recorderRef.current = recorder;
      await recorder.prime();

      if (!mountedRef.current) {
        releaseRecorder();
        return false;
      }

      if (problemId) {
        recorder.beginSegment(problemId);
        problemIdRef.current = problemId;
      }
      recorder.resume();
      startMeter();
      setPhase("recording");
      return true;
    },
    [releaseRecorder, startMeter],
  );

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;

    stopMeter();
    recorder.pause();
    if (problemIdRef.current) recorder.endSegment();
    setPhase("processing");

    try {
      return await recorder.stop();
    } catch {
      if (mountedRef.current) setError("no-data");
      return null;
    } finally {
      releaseRecorder();
      if (mountedRef.current) {
        setVuLevel(0);
        setIsSilent(false);
        setPhase("idle");
      }
    }
  }, [releaseRecorder, stopMeter]);

  const cancel = useCallback(() => {
    releaseRecorder();
    setPhase("idle");
    setDurationMs(0);
    setVuLevel(0);
    setIsSilent(false);
  }, [releaseRecorder]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseRecorder();
    };
  }, [releaseRecorder]);

  return {
    phase,
    isRecording: phase === "recording",
    durationMs,
    vuLevel,
    isSilent,
    error,
    start,
    stop,
    cancel,
  };
}
