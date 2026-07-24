import { useEffect, useRef, useState } from "react";
import StatHeader from "./components/StatHeader.jsx";
import MessageBubble from "./components/MessageBubble.jsx";
import MicButton from "./components/MicButton.jsx";
import { postTurn, postTurnAudio, getHealth } from "./lib/api.js";
import {
  createRecognizer,
  speak,
  stopSpeaking,
  playAudio,
  isSTTSupported,
  warmUpVoices,
} from "./lib/speech.js";
import { startAudioRecording, isAudioRecordingSupported } from "./lib/audio.js";

const GREETING =
  "Hi! I'm your SpeakUp coach. Tap the mic and tell me about your day — let's practice some English.";

export default function App() {
  const [messages, setMessages] = useState([{ role: "coach", text: GREETING }]);
  const [status, setStatus] = useState("idle"); // idle | listening | thinking | speaking
  const [totalXp, setTotalXp] = useState(0);
  const [error, setError] = useState(null);
  const [brain, setBrain] = useState(null);
  const [tts, setTts] = useState(null);
  const [sttProvider, setSttProvider] = useState(null);
  const [textInput, setTextInput] = useState("");

  // Ruta B: when the server has STT_PROVIDER configured, record raw audio and
  // let the server transcribe it (handoff §7.2 / M6). Otherwise fall back to
  // Ruta A, the in-browser Web Speech transcript.
  const useServerSTT = !!sttProvider && sttProvider !== "none";
  const micSupported = useServerSTT ? isAudioRecordingSupported() : isSTTSupported();
  const recognizerRef = useRef(null);
  const audioRecorderRef = useRef(null);
  const scrollRef = useRef(null);
  const speakTimerRef = useRef(null);
  const currentAudioRef = useRef(null);

  // Setup: warm voices, probe server for the active brain/voice/STT.
  useEffect(() => {
    warmUpVoices();
    getHealth().then((h) => {
      if (!h) return;
      setBrain(h.brain);
      setTts(h.tts);
      setSttProvider(h.stt);
    });
  }, []);

  // Auto-scroll to newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  function pushMessage(role, text, extra = {}) {
    setMessages((prev) => [...prev, { role, text, ...extra }]);
  }

  // Stop any in-flight coach audio (Kokoro <audio> element or browser speech).
  function stopPlayback() {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    stopSpeaking();
  }

  // Speak the coach reply. Prefer the server's audio (Kokoro); fall back to the
  // browser voice when there's no audio or playback fails. A safety timer makes
  // sure a missing `onend` can never strand us on "speaking".
  function speakReply(text, audio, audioFormat) {
    setStatus("speaking");
    clearTimeout(speakTimerRef.current);
    const fallbackMs = Math.max(4000, text.split(/\s+/).length * 450 + 2500);
    const toIdle = () => setStatus((s) => (s === "speaking" ? "idle" : s));
    speakTimerRef.current = setTimeout(toIdle, fallbackMs);
    const done = () => {
      clearTimeout(speakTimerRef.current);
      toIdle();
    };

    if (audio) {
      currentAudioRef.current = playAudio(audio, {
        format: audioFormat,
        onEnd: done,
        onError: () => speak(text, { onEnd: done }), // graceful browser fallback
      });
    } else {
      speak(text, { onEnd: done });
    }
  }

  // Replay a coach line — reuse its Kokoro audio if we have it, else browser voice.
  function replayMessage(m) {
    stopPlayback();
    if (m.audio) {
      currentAudioRef.current = playAudio(m.audio, { format: m.audioFormat });
    } else {
      speak(m.text);
    }
  }

  async function handleUtterance(rawText) {
    const text = rawText?.trim();
    if (!text) {
      setStatus("idle");
      return;
    }
    setError(null);
    pushMessage("user", text);

    // Build history from what we have so far (this user turn included).
    const history = [...messages, { role: "user", text }];

    setStatus("thinking");
    try {
      const { coach_reply, xp, audio, audioFormat } = await postTurn({ utterance: text, history });
      pushMessage("coach", coach_reply, { audio, audioFormat });
      if (typeof xp === "number") setTotalXp((v) => v + xp);

      speakReply(coach_reply, audio, audioFormat);
    } catch (err) {
      setError(err.message || "Something went wrong talking to the coach.");
      setStatus("idle");
    }
  }

  // Ruta B: audio was recorded server-side (STT_PROVIDER) — the transcript
  // only exists once the whole turn round-trips, so the user bubble goes up
  // together with the coach's reply instead of the instant we heard it.
  async function handleAudioTurn(blob) {
    setError(null);
    const history = [...messages];

    setStatus("thinking");
    try {
      const { transcript, coach_reply, xp, audio, audioFormat } = await postTurnAudio({ blob, history });
      if (!transcript) {
        setError("Didn't catch that — try again or use the text box.");
        setStatus("idle");
        return;
      }

      pushMessage("user", transcript);
      pushMessage("coach", coach_reply, { audio, audioFormat });
      if (typeof xp === "number") setTotalXp((v) => v + xp);

      speakReply(coach_reply, audio, audioFormat);
    } catch (err) {
      setError(err.message || "Something went wrong talking to the coach.");
      setStatus("idle");
    }
  }

  // Ruta A: in-browser Web Speech transcript, handed straight to handleUtterance.
  function startListeningBrowser() {
    const rec = createRecognizer({
      onResult: (transcript) => handleUtterance(transcript),
      onError: (code) => {
        if (code !== "no-speech" && code !== "aborted") {
          setError(`Microphone error: ${code}`);
        }
        setStatus("idle");
      },
      onEnd: () => {
        // If recognition ended without a result, fall back to idle.
        setStatus((s) => (s === "listening" ? "idle" : s));
      },
    });

    if (!rec) {
      setError("Speech recognition isn't supported here — use the text box below (Chrome/Edge work best).");
      return;
    }

    recognizerRef.current = rec;
    setStatus("listening");
    try {
      rec.start();
    } catch {
      setStatus("idle");
    }
  }

  async function startListeningServer() {
    if (!isAudioRecordingSupported()) {
      setError("Microphone recording isn't supported here — use the text box below.");
      return;
    }

    const rec = await startAudioRecording({
      onError: (code) => {
        setError(`Microphone error: ${code}`);
        setStatus("idle");
      },
    });
    if (!rec) return; // onError already reported why (permission denied, no device, ...)

    audioRecorderRef.current = rec;
    setStatus("listening");
  }

  async function handleMicClick() {
    if (status === "listening") {
      if (useServerSTT) {
        const rec = audioRecorderRef.current;
        audioRecorderRef.current = null;
        if (!rec) {
          setStatus("idle");
          return;
        }
        const blob = await rec.stop();
        handleAudioTurn(blob);
      } else {
        recognizerRef.current?.stop();
        setStatus("idle");
      }
      return;
    }

    if (status !== "idle") return;
    setError(null);
    stopPlayback();

    if (useServerSTT) {
      startListeningServer();
    } else {
      startListeningBrowser();
    }
  }

  function handleTextSubmit(e) {
    e.preventDefault();
    if (status !== "idle" || !textInput.trim()) return;
    const text = textInput;
    setTextInput("");
    handleUtterance(text);
  }

  const turns = messages.filter((m) => m.role === "user").length;
  const busy = status === "thinking" || status === "speaking";

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      <StatHeader totalXp={totalXp} turns={turns} brain={brain} tts={tts} stt={sttProvider} />

      {/* Conversation */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        {messages.map((m, i) => (
          <MessageBubble
            key={i}
            role={m.role}
            text={m.text}
            onReplay={() => replayMessage(m)}
          />
        ))}
        {status === "thinking" && (
          <p className="text-xs text-muted pl-1">coach is composing a reply…</p>
        )}
      </main>

      {/* Controls */}
      <footer className="px-5 pt-3 pb-5 border-t border-line/70 space-y-4">
        {error && (
          <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-center">
          <MicButton status={status} onClick={handleMicClick} disabled={busy} />
        </div>

        {/* Text fallback — works without a mic / in any browser */}
        <form onSubmit={handleTextSubmit} className="flex gap-2">
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            disabled={busy}
            placeholder={
              micSupported ? "…or type your reply" : "Type your reply (no mic detected)"
            }
            className="flex-1 bg-ink-2 border border-line rounded-xl px-4 py-2.5 text-sm placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-coach/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !textInput.trim()}
            className="px-4 py-2.5 rounded-xl bg-surface-2 border border-line text-sm font-medium hover:border-coach/60 hover:text-coach-soft transition disabled:opacity-40"
          >
            Send
          </button>
        </form>

        <p className="text-center text-[11px] text-muted">
          {micSupported
            ? "Tap the mic, speak, then listen to your coach. Repeat for 3 turns."
            : useServerSTT
              ? "This browser can't record audio — the text box drives the same loop."
              : "Your browser lacks speech recognition — the text box drives the same loop."}
        </p>
      </footer>
    </div>
  );
}
