import { useEffect, useRef } from "react";

/**
 * Editable review of the recognized utterance. Shown in the `review` state.
 * Enter sends, Shift+Enter inserts a newline, Esc cancels.
 */
export default function TranscriptReview({ draft, onEdit, onSend, onReRecord, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const canSend = draft.trim().length > 0;

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor="transcript-review" className="text-xs text-muted">
        Review what you said, edit if needed, then send:
      </label>
      <textarea
        id="transcript-review"
        ref={ref}
        value={draft}
        onChange={(e) => onEdit(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        className="w-full bg-ink-2 border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-coach/50 resize-none"
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 rounded-xl border border-line text-sm text-muted hover:text-ink transition"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onReRecord}
          className="px-3 py-2 rounded-xl border border-line text-sm hover:border-coach/60 hover:text-coach-soft transition"
        >
          Re-record
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="px-4 py-2 rounded-xl bg-coach text-white text-sm font-medium hover:shadow-[0_0_20px_-6px] hover:shadow-coach transition disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
