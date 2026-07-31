"""Blank attribution. Raw CTC spans are ~1 frame wide with long blank runs
between them; expand_spans splits each gap at its midpoint so the phones tile
the utterance contiguously (invariant I5).
"""

from dataclasses import dataclass

import pytest

from app.align import PhoneSpan, expand_spans, frames_to_seconds, unflatten


@dataclass
class FakeSpan:
    start: int
    end: int


def test_expand_spans_tiles_the_whole_utterance():
    spans = [FakeSpan(2, 3), FakeSpan(10, 11), FakeSpan(20, 21)]
    assert expand_spans(spans, total_frames=33) == [(0, 6), (6, 15), (15, 33)]


def test_expand_spans_of_a_single_span_covers_everything():
    assert expand_spans([FakeSpan(5, 6)], total_frames=33) == [(0, 33)]


def test_expand_spans_handles_adjacent_spans_without_collapsing_them():
    out = expand_spans([FakeSpan(2, 3), FakeSpan(3, 4)], total_frames=8)
    assert out == [(0, 3), (3, 8)]
    for start, end in out:
        assert end > start


def test_expand_spans_output_is_contiguous_and_conserves_every_frame():
    spans = [FakeSpan(1, 2), FakeSpan(4, 5), FakeSpan(9, 10), FakeSpan(14, 15)]
    out = expand_spans(spans, total_frames=20)
    assert out[0][0] == 0
    assert out[-1][1] == 20
    assert sum(end - start for start, end in out) == 20
    for (_, prev_end), (next_start, _) in zip(out, out[1:]):
        assert prev_end == next_start


def test_expand_spans_is_empty_for_degenerate_input():
    assert expand_spans([], total_frames=33) == []
    assert expand_spans([FakeSpan(0, 1)], total_frames=0) == []


def test_frames_to_seconds_rounds_to_milliseconds():
    assert frames_to_seconds(33, 0.02015) == 0.665
    assert frames_to_seconds(0, 0.02) == 0.0


def test_unflatten_splits_by_per_word_phone_counts():
    assert unflatten(["a", "b", "c", "d", "e"], [2, 3]) == [["a", "b"], ["c", "d", "e"]]
    assert unflatten([], []) == []


def test_unflatten_refuses_mismatched_lengths():
    with pytest.raises(ValueError):
        unflatten(["a", "b"], [3])


def test_phone_span_is_frozen_and_carries_both_raw_and_expanded_frames():
    span = PhoneSpan(token_id=4, ipa="iː", raw_start=10, raw_end=11, start=6, end=15, ctc_score=0.9)
    assert (span.raw_start, span.raw_end) == (10, 11)
    assert (span.start, span.end) == (6, 15)
    with pytest.raises(Exception):
        span.start = 0  # type: ignore[misc]
