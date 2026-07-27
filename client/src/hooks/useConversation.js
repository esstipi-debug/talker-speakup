import { useEffect, useRef, useState } from "react";
import { postTurn, getHealth } from "../lib/api.js";
import {
  createRecognizer,
  isSTTSupported,
  playAudio,
  speak,
  stopSpeaking,
  warmUpVoices,
} from "../lib/speech.js";
import {
  getMicStream,
  micNowMs,
  resetFrames,
  getFrames,
  getHopMs,
  stopFrames,
  getCaptureSettings,
} from "../lib/micStream.js";
import { detectPauses } from "../lib/prosody/pauses.js";
import { classifyPauses, summarise } from "../lib/prosody/placement.js";
import { pauseSentence } from "../lib/prosody/summary.js";

const GREETING =
  "Hi! I'm your SpeakUp coach. Tap the mic and tell me about your day — let's practice some English.";

const MAX_LISTEN_MS = 120000; // hard cap so a stuck session can't listen forever
const MAX_EMPTY_RESTARTS = 6; // guard against tight restart loops on a silent/broken mic
const NO_SPEECH_MSG = "Didn't catch that — try again or type.";
/** UNCALIBRATED — spec §7.4: at most one pause note per this many turns. */
const PAUSE_NOTE_TURN_INTERVAL = 3;

/**
 * Owns the whole conversation loop: providers, the turn round-trip, a single
 * playback controller for the coach voice, and the speech capture state
 * machine (idle -> listening -> review -> thinking -> speaking -> idle).
 */
export function useConversation() {
  const [messages, setMessages] = useState([{ role: "coach", text: GREETING }]);
  const [status, setStatus] = useState("idle");
  const [draft, setDraft] = useState(""); // finalized text, then editable in review
  const [interim, setInterim] = useState(""); // live non-final tail during listening
  const [totalXp, setTotalXp] = useState(0);
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState({ brain: null, tts: null, stt: null });
  const [ttsFallbackActive, setTtsFallbackActive] = useState(false);
  const [pauseNote, setPauseNote] = useState(null);
  const [sessionPauseCounts, setSessionPauseCounts] = useState({ total: 0, internal: 0, boundary: 0, unknown: 0 });
  const finalizationsRef = useRef([]);

  const recognizerRef = useRef(null);
  const userStoppedRef = useRef(false);
  const fatalRef = useRef(false);
  const listenStartRef = useRef(0);
  const emptyRestartsRef = useRef(0);
  const currentAudioRef = useRef(null);
  const speakTimerRef = useRef(null);
  const sessionIdRef = useRef(null);
  const lastTurnProsodyRef = useRef(null);
  const turnIndexRef = useRef(0); // counts completed recordings, for pause-note throttling
  const lastNoteTurnRef = useRef(-Infinity); // turnIndexRef value when a note was last shown

  const statusRef = useRef("idle");
  const draftRef = useRef("");
  const interimRef = useRef("");
  const messagesRef = useRef(messages);
  const providersRef = useRef(providers);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { interimRef.current = interim; }, [interim]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { providersRef.current = providers; }, [providers]);

  useEffect(() => {
    warmUpVoices();
    getHealth().then((h) => {
      if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt });
    });
  }, []);

  // ---------------- playback controller ----------------
  function stopPlayback() {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    stopSpeaking();
    clearTimeout(speakTimerRef.current);
  }

  function playCoach(text, audio, audioFormat) {
    clearTimeout(speakTimerRef.current);
    setStatus("speaking");
    const toIdle = () => setStatus((s) => (s === "speaking" ? "idle" : s));
    const fallbackMs = Math.max(4000, text.split(/\s+/).length * 450 + 2500);
    speakTimerRef.current = setTimeout(toIdle, fallbackMs);
    const done = () => {
      clearTimeout(speakTimerRef.current);
      toIdle();
    };
    if (audio) {
      currentAudioRef.current = playAudio(audio, {
        format: audioFormat,
        onEnd: done,
        onError: () => speak(text, { onEnd: done }),
      });
    } else {
      speak(text, { onEnd: done });
    }
  }

  // ---------------- turn engine ----------------
  async function runTurn(utterance) {
    setError(null);
    const userMsg = { role: "user", text: utterance };
    const historyBefore = messagesRef.current;
    setMessages((prev) => [...prev, userMsg]);
    setStatus("thinking");
    // Read at the moment the turn is actually sent — not when it was merely
    // recorded — so a re-recorded or cancelled take never reaches here at all.
    const prosody = lastTurnProsodyRef.current;
    const captureSettings = getCaptureSettings();
    try {
      const { coach_reply, xp, audio, audioFormat, sessionId } = await postTurn({
        utterance,
        history: [...historyBefore, userMsg],
        sessionId: sessionIdRef.current,
        prosody,
        captureSettings,
      });
      // A dead id comes back as null (server-side fix): keep it null so the
      // client opens a fresh session next turn instead of retrying forever.
      sessionIdRef.current = sessionId ?? null;
      lastTurnProsodyRef.current = null;
      // Only accumulate once the send has actually succeeded: a failed
      // request can be retried from the same review state without the same
      // take being counted twice.
      if (prosody) {
        setSessionPauseCounts((prev) => ({
          total: prev.total + prosody.total,
          internal: prev.internal + prosody.internal,
          boundary: prev.boundary + prosody.boundary,
          unknown: prev.unknown + prosody.unknown,
        }));
      }
      setMessages((prev) => [...prev, { role: "coach", text: coach_reply, audio, audioFormat }]);
      if (typeof xp === "number") setTotalXp((v) => v + xp);

      const expectedServerVoice = providersRef.current.tts && providersRef.current.tts !== "browser";
      if (!audio && expectedServerVoice) setTtsFallbackActive(true);
      else if (audio) setTtsFallbackActive(false);
      playCoach(coach_reply, audio, audioFormat);
    } catch (err) {
      setMessages(historyBefore); // optimistic rollback (retry re-adds exactly one turn)
      setError(err.message || "The coach brain failed to respond.");
      setDraft(utterance);
      setStatus("review");
    }
  }

  // ---------------- speech capture ----------------
  /**
   * Runs once at end of turn, on the main thread, over the buffered contour.
   * It cannot stream: the silence floor is a global statistic over the whole
   * utterance (spec §5.2, M1).
   */
  function computePauseProfile() {
    const frames = getFrames();
    stopFrames(); // measurement window is over — stop the worklet handler from growing the buffer further
    const pauses = detectPauses(frames, { hopMs: getHopMs() });
    const classified = classifyPauses(pauses, finalizationsRef.current);
    const counts = summarise(classified);
    // The session tally is NOT touched here: it only accumulates once the
    // learner actually sends the turn (see runTurn) — otherwise a re-recorded
    // or cancelled take would be counted before the learner ever decided.
    lastTurnProsodyRef.current = counts;

    turnIndexRef.current += 1;
    const sentence = pauseSentence(counts);
    const turnsSinceLastNote = turnIndexRef.current - lastNoteTurnRef.current;
    if (sentence && turnsSinceLastNote >= PAUSE_NOTE_TURN_INTERVAL) {
      lastNoteTurnRef.current = turnIndexRef.current;
      setPauseNote(sentence);
    } else {
      setPauseNote(null);
    }
  }

  function finishListening(announceEmpty) {
    computePauseProfile();
    const combined = `${draftRef.current} ${interimRef.current}`.trim();
    setInterim("");
    if (combined) {
      setDraft(combined);
      setStatus("review");
    } else {
      setStatus("idle");
      if (announceEmpty) setError(NO_SPEECH_MSG);
    }
  }

  function handleSpeechError(code) {
    if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
      fatalRef.current = true;
      setError("Microphone permission denied — allow the mic or use the text box.");
    } else if (code === "network") {
      fatalRef.current = true;
      setError("Speech service unavailable — try again or type.");
    } else if (code === "no-speech" || code === "aborted") {
      // non-fatal (paused) / self-initiated (barge-in, reRecord) — handled by onend
    } else {
      setError(`Speech error: ${code}`);
    }
  }

  function handleRecognizerEnd() {
    if (statusRef.current !== "listening") return;
    if (fatalRef.current) {
      fatalRef.current = false;
      setInterim("");
      setStatus("idle");
      return;
    }
    const overTime = Date.now() - listenStartRef.current > MAX_LISTEN_MS;
    const tooManyRestarts = emptyRestartsRef.current >= MAX_EMPTY_RESTARTS;
    if (userStoppedRef.current || overTime || tooManyRestarts) {
      finishListening(userStoppedRef.current || tooManyRestarts);
      return;
    }
    // silence self-termination: keep listening (continuity), preserving the draft.
    // Deferred to the next tick: restarting the same recognizer synchronously
    // inside its own onend can throw InvalidStateError in Chrome mid-teardown.
    emptyRestartsRef.current += 1;
    finalizationsRef.current.push({ tMs: micNowMs(), text: "" });
    setTimeout(() => {
      if (statusRef.current !== "listening") return; // a stop()/cancel() may have raced the deferred restart
      try {
        recognizerRef.current?.start();
      } catch {
        finishListening(false);
      }
    }, 0);
  }

  function startListening() {
    if (statusRef.current === "listening" || statusRef.current === "thinking") return;
    stopPlayback();
    setError(null);
    setDraft("");
    setInterim("");
    userStoppedRef.current = false;
    fatalRef.current = false;
    emptyRestartsRef.current = 0;
    listenStartRef.current = Date.now();
    finalizationsRef.current = [];
    setPauseNote(null);
    resetFrames();
    getMicStream().catch(() => { /* capture is optional; the turn still works */ });
    const rec = createRecognizer({
      onStart: () => setStatus("listening"),
      onResult: (chunk) => {
        emptyRestartsRef.current = 0;
        finalizationsRef.current.push({ tMs: micNowMs(), text: chunk });
        setDraft((d) => `${d} ${chunk}`.trim());
      },
      onInterim: (tail) => setInterim(tail),
      onError: (code) => handleSpeechError(code),
      onEnd: () => handleRecognizerEnd(),
    });
    if (!rec) {
      setError("Speech recognition isn't supported here — use the text box (Chrome/Edge work best).");
      setStatus("idle");
      return;
    }
    recognizerRef.current = rec;
    try {
      rec.start();
    } catch {
      setStatus("idle");
    }
  }

  function stopListening() {
    if (statusRef.current !== "listening") return;
    userStoppedRef.current = true;
    try {
      recognizerRef.current?.stop();
    } catch {
      finishListening(true);
    }
  }

  function editDraft(text) {
    setDraft(text);
  }

  function send() {
    if (statusRef.current !== "review") return;
    const t = draftRef.current.trim();
    if (!t) {
      setStatus("idle");
      return;
    }
    setDraft("");
    runTurn(t);
  }

  function reRecord() {
    if (statusRef.current !== "review") return;
    setDraft("");
    setInterim("");
    startListening();
  }

  function cancel() {
    if (statusRef.current !== "review") return;
    recognizerRef.current?.abort?.();
    setDraft("");
    setInterim("");
    setError(null);
    setStatus("idle");
    // This take is discarded forever — never let it surface as the prosody
    // for some later, unrelated turn (e.g. one typed instead of recorded).
    lastTurnProsodyRef.current = null;
  }

  function interrupt() {
    if (statusRef.current !== "speaking") return;
    stopPlayback();
    startListening();
  }

  function submitText(text) {
    const t = text?.trim();
    if (statusRef.current !== "idle" || !t) return;
    runTurn(t);
  }

  function replay(message) {
    if (statusRef.current !== "idle" || !message) return;
    stopPlayback();
    if (message.audio) {
      currentAudioRef.current = playAudio(message.audio, { format: message.audioFormat });
    } else {
      speak(message.text);
    }
  }

  return {
    messages,
    status,
    draft,
    interim,
    liveTranscript: `${draft} ${interim}`.trim(),
    totalXp,
    error,
    providers,
    ttsFallbackActive,
    pauseNote,
    sessionPauseCounts,
    sttSupported: isSTTSupported(),
    turns: messages.filter((m) => m.role === "user").length,
    startListening,
    stopListening,
    editDraft,
    send,
    reRecord,
    cancel,
    interrupt,
    submitText,
    replay,
    clearError: () => setError(null),
  };
}
