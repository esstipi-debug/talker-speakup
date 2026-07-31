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
