"""Forced alignment and blank attribution.

Verified by execution during recon: with facebook/wav2vec2-lv-60-espeak-cv-ft
every merge_tokens span is exactly one 20 ms frame wide and ~91 % of frames are
CTC blanks. Those raw spans are the right input for GOP (they are where the
model actually committed) and the wrong output for a report (they are not
durations). expand_spans reconciles the two by splitting each blank run at its
midpoint, so the reported phones tile the utterance with no gaps.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PhoneSpan:
    token_id: int
    ipa: str
    raw_start: int  # inclusive emission frame, straight from merge_tokens
    raw_end: int  # exclusive emission frame, straight from merge_tokens
    start: int  # inclusive frame after blank attribution
    end: int  # exclusive frame after blank attribution
    ctc_score: float  # merge_tokens mean score, already exp()'d to a probability


def frames_to_seconds(frame: int, sec_per_frame: float) -> float:
    return round(int(frame) * float(sec_per_frame), 3)


def unflatten(items: list, lengths: list[int]) -> list[list]:
    if sum(lengths) != len(items):
        raise ValueError(f"unflatten: lengths sum to {sum(lengths)} but got {len(items)} items")
    out: list[list] = []
    cursor = 0
    for length in lengths:
        out.append(list(items[cursor : cursor + length]))
        cursor += length
    return out


def expand_spans(spans, total_frames: int) -> list[tuple[int, int]]:
    """Attribute the blank runs between raw CTC spans to their neighbours."""
    if total_frames <= 0 or not spans:
        return []

    count = len(spans)
    starts = [int(span.start) for span in spans]
    ends = [int(span.end) for span in spans]

    starts[0] = 0
    for index in range(count - 1):
        gap_lo = int(spans[index].end)
        gap_hi = int(spans[index + 1].start)
        midpoint = gap_lo + (gap_hi - gap_lo) // 2
        ends[index] = max(gap_lo, midpoint)
        starts[index + 1] = ends[index]
    ends[count - 1] = total_frames

    return [(starts[i], ends[i]) for i in range(count)]


def align_sequence(log_probs, token_ids: list[int], blank: int):
    """Run CTC forced alignment on the phoneme model's own log-probs.

    No second model: torchaudio's MMS_FA bundle is character-level and CC-BY-NC,
    so it cannot produce per-phoneme spans and must not be used here.
    """
    import torch
    import torchaudio.functional as AF

    from .errors import PronError

    if not token_ids:
        raise PronError(
            "UNPRONOUNCEABLE_TEXT",
            "Couldn't turn that sentence into phonemes. Try plain English words.",
            status=400,
        )

    if int(log_probs.shape[1]) < len(token_ids):
        raise PronError(
            "NO_SPEECH",
            "Couldn't make out any speech in that recording.",
            status=422,
        )

    targets = torch.tensor([list(token_ids)], dtype=torch.int32, device=log_probs.device)

    try:
        alignments, scores = AF.forced_align(log_probs, targets, blank=int(blank))
        spans = AF.merge_tokens(alignments[0], scores[0].exp(), blank=int(blank))
    except RuntimeError as exc:
        if "too long" in str(exc).lower():
            raise PronError(
                "NO_SPEECH", "Couldn't make out any speech in that recording.", status=422
            ) from exc
        raise PronError("INTERNAL", "Alignment failed for that recording.", status=500) from exc
    except ValueError as exc:
        raise PronError("INTERNAL", "Alignment failed for that recording.", status=500) from exc

    if len(spans) != len(token_ids):
        raise PronError("INTERNAL", "Alignment failed for that recording.", status=500)

    return spans


def to_phone_spans(spans, ipa_tokens: list[str], total_frames: int) -> list[PhoneSpan]:
    if len(spans) != len(ipa_tokens):
        raise ValueError(f"to_phone_spans: {len(spans)} spans but {len(ipa_tokens)} IPA tokens")

    expanded = expand_spans(spans, total_frames)
    return [
        PhoneSpan(
            token_id=int(span.token),
            ipa=ipa,
            raw_start=int(span.start),
            raw_end=int(span.end),
            start=int(start),
            end=int(end),
            ctc_score=float(span.score),
        )
        for span, ipa, (start, end) in zip(spans, ipa_tokens, expanded)
    ]
