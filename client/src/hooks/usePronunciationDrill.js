import { useEffect, useRef, useState } from "react";
import { getPronPrompts, postPronAssess } from "../lib/api.js";
import {
  isRecordingSupported,
  startRecording as startRecorder,
  MIN_DRILL_MS,
} from "../lib/recorder.js";
import { rankPronErrors } from "../lib/pronErrors.js";

const SCORING_TIMEOUT_MS = 35000; // client-side guard sitting above the server's PRON_TIMEOUT_MS
const NO_MIC_MSG = "No microphone available — the drill needs audio it can score.";
const NO_PROMPTS_MSG = "No drill prompts are available right now.";
const SIDECAR_DOWN_MSG = "Scoring is offline. Listen and repeat — no score this round.";
const TOO_SHORT_MSG = "That take was too short — read the whole sentence out loud.";
const MIC_DENIED_MSG = "Microphone access was refused. Allow it, then try again.";

/**
 * Owns the drill loop end to end: prompt selection, a single recorder handle,
 * the assess round-trip, and the ranked result. State machine:
 * prompt -> recording -> scoring -> result, with `unavailable` as the
 * listen-and-repeat degradation branch (design §7).
 *
 * `useConversation` is deliberately untouched — its machine has a review step
 * and a brain call, this one has neither.
 *
 * @param {{ focus?: string|null }} [opts]
 */
export function usePronunciationDrill({ focus = null } = {}) {
  const [status, setStatus] = useState("loading");
  const [prompts, setPrompts] = useState([]);
  const [promptIndex, setPromptIndex] = useState(-1);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [scoringUnavailable, setScoringUnavailable] = useState(false);
  const [pronProvider, setPronProvider] = useState(null);
  const [attempts, setAttempts] = useState(0);

  const prompt = promptIndex >= 0 ? (prompts[promptIndex] ?? null) : null;
  const micSupported = isRecordingSupported();

  // imperative refs
  const recorderRef = useRef(null);
  const mountedRef = useRef(true);
  const attemptSeqRef = useRef(0);

  // state mirrors — read from callbacks that outlive their render
  const statusRef = useRef("loading");
  const promptRef = useRef(null);
  const promptsRef = useRef([]);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  useEffect(() => { promptsRef.current = prompts; }, [prompts]);

  // Mirrors `status` into `statusRef` synchronously, at the same call site as
  // the state update. The useEffect mirror above runs after a render commits,
  // which is too late for imperative guards that fire twice in the same tick
  // (e.g. a fast double-tap invoking two hook calls back-to-back inside one
  // `act()`): the second call would otherwise read a stale ref.
  function updateStatus(next) {
    statusRef.current = next;
    setStatus(next);
  }

  useEffect(() => {
    mountedRef.current = true;
    if (!isRecordingSupported()) {
      // Nothing to fetch: without a mic there is no audio to score, and the
      // drill cannot fall back to the text input.
      setError(NO_MIC_MSG);
      updateStatus("unavailable");
      return () => {
        mountedRef.current = false;
      };
    }
    getPronPrompts({ focus })
      .then((set) => {
        if (!mountedRef.current) return;
        const list = set?.prompts ?? [];
        setPrompts(list);
        setPromptIndex(list.length > 0 ? 0 : -1);
        if (list.length === 0) {
          setError(NO_PROMPTS_MSG);
          updateStatus("unavailable");
          return;
        }
        updateStatus("prompt");
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(err.message);
        updateStatus("unavailable");
      });
    return () => {
      mountedRef.current = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, [focus]);

  // ---------------- scoring ----------------

  async function scoreTake(blob, seq) {
    let guard = null;
    try {
      const scored = await Promise.race([
        postPronAssess({ blob, text: promptRef.current.text, mode: "scripted" }),
        new Promise((_, reject) => {
          guard = setTimeout(() => {
            const err = new Error(SIDECAR_DOWN_MSG);
            err.code = "PRON_UNAVAILABLE";
            reject(err);
          }, SCORING_TIMEOUT_MS);
        }),
      ]);
      if (!mountedRef.current || attemptSeqRef.current !== seq) return;
      setReport(scored);
      setPronProvider(scored.pronProvider ?? null);
      setAttempts((n) => n + 1);
      updateStatus("result");
    } catch (err) {
      if (!mountedRef.current || attemptSeqRef.current !== seq) return;
      if (err.code === "PRON_UNAVAILABLE") {
        setScoringUnavailable(true);
        setError(SIDECAR_DOWN_MSG);
        updateStatus("unavailable");
        return;
      }
      setError(err.message);
      updateStatus("prompt");
    } finally {
      if (guard !== null) clearTimeout(guard);
    }
  }

  // ---------------- capture ----------------

  function handleRecorderError(code) {
    if (!mountedRef.current) return;
    setError(code === "NotAllowedError" ? MIC_DENIED_MSG : `Recording failed (${code}).`);
  }

  async function startRecording() {
    if (statusRef.current !== "prompt") return;
    setError(null);
    attemptSeqRef.current += 1;
    updateStatus("recording");

    const handle = await startRecorder({
      onError: handleRecorderError,
      onAutoStop: () => stopRecording(),
    });

    if (!mountedRef.current) {
      handle?.cancel();
      return;
    }
    if (!handle) {
      updateStatus("prompt");
      return;
    }
    // The learner may have cancelled while the permission prompt was open.
    if (statusRef.current !== "recording") {
      handle.cancel();
      return;
    }
    recorderRef.current = handle;
  }

  async function stopRecording() {
    if (statusRef.current !== "recording") return;
    const handle = recorderRef.current;
    if (!handle) {
      updateStatus("prompt");
      return;
    }
    const seq = attemptSeqRef.current;
    updateStatus("scoring"); // also the re-entrancy guard against a double tap

    const take = await handle.stop();
    recorderRef.current = null;
    if (!mountedRef.current || attemptSeqRef.current !== seq) return;
    if (!take) {
      updateStatus("prompt"); // the recorder already reported why via onError
      return;
    }
    if (take.durationMs < MIN_DRILL_MS) {
      setError(TOO_SHORT_MSG);
      updateStatus("prompt");
      return;
    }
    await scoreTake(take.blob, seq);
  }

  function cancelRecording() {
    if (statusRef.current !== "recording") return;
    attemptSeqRef.current += 1; // invalidate anything already in flight for this take
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setError(null);
    updateStatus("prompt");
  }

  // ---------------- navigation ----------------

  function retry() {
    if (statusRef.current !== "result" && statusRef.current !== "unavailable") return;
    if (!promptRef.current) return; // no-mic / no-prompts has nothing to retry
    setReport(null);
    setError(null);
    updateStatus("prompt");
  }

  function nextPrompt() {
    if (statusRef.current === "recording") return;
    // Switching prompts mid-scoring abandons the in-flight attempt rather than
    // blocking on it: bump the sequence so scoreTake's stale-response guard
    // discards whatever answer eventually arrives for the abandoned take.
    if (statusRef.current === "scoring") attemptSeqRef.current += 1;
    const list = promptsRef.current;
    if (list.length === 0) return;
    setPromptIndex((i) => (i + 1) % list.length);
    setReport(null);
    setError(null);
    updateStatus("prompt");
  }

  function selectPrompt(id) {
    if (statusRef.current === "recording") return;
    // Same invalidation as nextPrompt: `scoring` is a passive async wait, so
    // switching prompts here is allowed and must invalidate the stale attempt.
    if (statusRef.current === "scoring") attemptSeqRef.current += 1;
    const index = promptsRef.current.findIndex((p) => p.id === id);
    if (index === -1) return;
    setPromptIndex(index);
    setReport(null);
    setError(null);
    updateStatus("prompt");
  }

  return {
    status,
    prompt,
    prompts,
    promptIndex,
    report,
    errors: rankPronErrors(report),
    error,
    micSupported,
    scoringUnavailable,
    pronProvider,
    attempts,
    startRecording,
    stopRecording,
    cancelRecording,
    retry,
    nextPrompt,
    selectPrompt,
    clearError: () => setError(null),
  };
}
