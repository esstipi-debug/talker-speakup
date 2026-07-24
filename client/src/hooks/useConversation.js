import { useEffect, useRef, useState } from "react";
import { postTurn, getHealth } from "../lib/api.js";
import {
  isSTTSupported,
  playAudio,
  speak,
  stopSpeaking,
  warmUpVoices,
} from "../lib/speech.js";

const GREETING =
  "Hi! I'm your SpeakUp coach. Tap the mic and tell me about your day — let's practice some English.";

/**
 * Owns the whole conversation loop: providers, the turn round-trip, and a
 * single playback controller for the coach voice. Speech capture + the review
 * state machine are added in a later slice.
 */
export function useConversation() {
  const [messages, setMessages] = useState([{ role: "coach", text: GREETING }]);
  const [status, setStatus] = useState("idle"); // idle|listening|review|thinking|speaking
  const [totalXp, setTotalXp] = useState(0);
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState({ brain: null, tts: null, stt: null });
  const [ttsFallbackActive, setTtsFallbackActive] = useState(false);
  const [draft, setDraft] = useState(""); // repopulated on error so the user can retry

  const currentAudioRef = useRef(null);
  const speakTimerRef = useRef(null);
  const statusRef = useRef("idle");
  const messagesRef = useRef(messages);
  const providersRef = useRef(providers);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);

  useEffect(() => {
    warmUpVoices();
    getHealth().then((h) => {
      if (h) setProviders({ brain: h.brain, tts: h.tts, stt: h.stt });
    });
  }, []);

  // --- playback controller: sole owner of currentAudioRef + speakTimerRef + speaking status ---
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

  // --- turn engine (shared by text + speech paths) ---
  async function runTurn(utterance) {
    setError(null);
    const userMsg = { role: "user", text: utterance };
    const historyBefore = messagesRef.current;
    setMessages((prev) => [...prev, userMsg]); // optimistic user bubble
    setStatus("thinking");
    try {
      const { coach_reply, xp, audio, audioFormat } = await postTurn({
        utterance,
        history: [...historyBefore, userMsg],
      });
      setMessages((prev) => [...prev, { role: "coach", text: coach_reply, audio, audioFormat }]);
      if (typeof xp === "number") setTotalXp((v) => v + xp);

      const expectedServerVoice = providersRef.current.tts && providersRef.current.tts !== "browser";
      if (!audio && expectedServerVoice) setTtsFallbackActive(true);
      else if (audio) setTtsFallbackActive(false);
      playCoach(coach_reply, audio, audioFormat);
    } catch (err) {
      // Optimistic rollback: drop the just-pushed user bubble, then drop into
      // review with the text repopulated so the retry re-adds exactly one turn.
      setMessages(historyBefore);
      setError(err.message || "The coach brain failed to respond.");
      setDraft(utterance);
      setStatus("review");
    }
  }

  function submitText(text) {
    const t = text?.trim();
    if (statusRef.current !== "idle" || !t) return;
    runTurn(t);
  }

  const sttSupported = isSTTSupported();

  return {
    messages,
    status,
    totalXp,
    error,
    providers,
    ttsFallbackActive,
    sttSupported,
    draft,
    turns: messages.filter((m) => m.role === "user").length,
    submitText,
    clearError: () => setError(null),
  };
}
