import { Fragment, useEffect, useRef, useState } from "react";
import StatHeader from "./components/StatHeader.jsx";
import MessageBubble from "./components/MessageBubble.jsx";
import MicButton from "./components/MicButton.jsx";
import TranscriptReview from "./components/TranscriptReview.jsx";
import VoiceStatus from "./components/VoiceStatus.jsx";
import PauseNote from "./components/PauseNote.jsx";
import FeedbackPanel from "./components/FeedbackPanel.jsx";
import PatternsPanel from "./components/PatternsPanel.jsx";
import { useConversation } from "./hooks/useConversation.js";

export default function App() {
  const c = useConversation();
  const [textInput, setTextInput] = useState("");
  const [showPatterns, setShowPatterns] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [c.messages, c.status, c.liveTranscript]);

  const busy = c.status === "thinking";
  const lastUserIndex = c.messages.findLastIndex((m) => m.role === "user");
  const micButtonRef = useRef(null);
  const prevStatusRef = useRef(c.status);
  const pendingMicFocusRef = useRef(false);

  // Return focus to the mic button when leaving review (cancel/reRecord land on
  // an enabled button immediately; send -> thinking leaves it disabled, so the
  // focus is deferred via a pending flag until the mic is focusable again).
  // Satisfies the spec's focus-return requirement.
  useEffect(() => {
    if (prevStatusRef.current === "review" && c.status !== "review") {
      pendingMicFocusRef.current = true;
    }
    prevStatusRef.current = c.status;
    // Focus the mic as soon as it's rendered and enabled (it's disabled only in `thinking`).
    if (pendingMicFocusRef.current && c.status !== "review" && c.status !== "thinking") {
      micButtonRef.current?.focus();
      pendingMicFocusRef.current = false;
    }
  }, [c.status]);

  function handleMicClick() {
    if (c.status === "listening") c.stopListening();
    else if (c.status === "speaking") c.interrupt();
    else if (c.status === "idle") c.startListening();
  }

  function handleTextSubmit(e) {
    e.preventDefault();
    if (c.status !== "idle" || !textInput.trim()) return;
    const text = textInput;
    setTextInput("");
    c.submitText(text);
  }

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      <StatHeader
        totalXp={c.totalXp}
        turns={c.turns}
        sessionFluency={c.sessionFluency}
        brain={c.providers.brain}
        tts={c.providers.tts}
        stt={c.providers.stt}
        mode={c.providers.mode}
        onTogglePatterns={() => setShowPatterns((v) => !v)}
        patternsOpen={showPatterns}
      />

      <PatternsPanel open={showPatterns} />

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        {c.messages.map((m, i) => (
          <Fragment key={m.id}>
            <MessageBubble
              role={m.role}
              text={m.text}
              onReplay={m.role === "coach" && c.status === "idle" ? () => c.replay(m) : undefined}
            />
            {m.role === "user" && <FeedbackPanel feedback={m.feedback} />}
            {i === lastUserIndex && <PauseNote note={c.pauseNote} />}
          </Fragment>
        ))}
        {c.status === "thinking" && (
          <p className="text-xs text-muted pl-1">coach is composing a reply…</p>
        )}
      </main>

      <footer className="px-5 pt-3 pb-5 border-t border-line/70 space-y-4">
        <VoiceStatus
          status={c.status}
          liveTranscript={c.liveTranscript}
          error={c.error}
          ttsFallbackActive={c.ttsFallbackActive}
          sttSupported={c.sttSupported}
          pauseNote={c.pauseNote}
          onDismissError={c.clearError}
        />

        {c.status === "review" ? (
          <TranscriptReview
            draft={c.draft}
            onEdit={c.editDraft}
            onSend={c.send}
            onReRecord={c.reRecord}
            onCancel={c.cancel}
          />
        ) : (
          <>
            <div className="flex justify-center">
              <MicButton ref={micButtonRef} status={c.status} onClick={handleMicClick} />
            </div>

            <form onSubmit={handleTextSubmit} className="flex gap-2">
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                disabled={busy}
                placeholder={c.sttSupported ? "…or type your reply" : "Type your reply (no mic detected)"}
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
          </>
        )}
      </footer>
    </div>
  );
}
