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


import torch

from app.align import align_sequence, to_phone_spans
from app.errors import PronError


def _peaky_log_probs(frames: int, classes: int, path: list[int]) -> torch.Tensor:
    logits = torch.full((1, frames, classes), -10.0)
    for frame, token in enumerate(path):
        logits[0, frame, token] = 10.0
    return torch.log_softmax(logits, dim=-1)


def test_align_sequence_returns_one_span_per_target_token():
    log_probs = _peaky_log_probs(6, 5, [0, 1, 0, 2, 0, 0])
    spans = align_sequence(log_probs, [1, 2], blank=0)
    assert [span.token for span in spans] == [1, 2]
    assert (spans[0].start, spans[0].end) == (1, 2)
    assert (spans[1].start, spans[1].end) == (3, 4)
    assert 0.0 < spans[0].score <= 1.0  # already exp()'d to a probability


def test_align_sequence_raises_no_speech_when_the_audio_is_shorter_than_the_transcript():
    log_probs = _peaky_log_probs(2, 5, [0, 0])
    with pytest.raises(PronError) as excinfo:
        align_sequence(log_probs, [1, 2, 3, 4], blank=0)
    assert excinfo.value.code == "NO_SPEECH"
    assert excinfo.value.status == 422


def test_align_sequence_rejects_an_empty_target():
    with pytest.raises(PronError) as excinfo:
        align_sequence(_peaky_log_probs(4, 5, [0, 0, 0, 0]), [], blank=0)
    assert excinfo.value.code == "UNPRONOUNCEABLE_TEXT"


def test_to_phone_spans_keeps_raw_frames_and_adds_expanded_contiguous_ones():
    log_probs = _peaky_log_probs(6, 5, [0, 1, 0, 2, 0, 0])
    spans = align_sequence(log_probs, [1, 2], blank=0)

    phones = to_phone_spans(spans, ["ʃ", "p"], total_frames=6)

    assert [p.ipa for p in phones] == ["ʃ", "p"]
    assert [(p.raw_start, p.raw_end) for p in phones] == [(1, 2), (3, 4)]
    assert [(p.start, p.end) for p in phones] == [(0, 2), (2, 6)]
    assert [p.token_id for p in phones] == [1, 2]


def test_to_phone_spans_refuses_a_token_count_mismatch():
    log_probs = _peaky_log_probs(6, 5, [0, 1, 0, 2, 0, 0])
    spans = align_sequence(log_probs, [1, 2], blank=0)
    with pytest.raises(ValueError):
        to_phone_spans(spans, ["ʃ"], total_frames=6)
