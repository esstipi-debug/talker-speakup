"""GOP arithmetic. Recon measured gop == 0.000 for a correctly produced phone
and -2.147 for a substituted one, with the span argmax naming the substitute --
that argmax is the only producer of the report's `substituted` field.
"""

import pytest
import torch

from app.align import PhoneSpan
from app.gop import (
    completeness,
    detect_substitution,
    gop_to_score,
    phone_gop,
    sentence_accuracy,
    span_argmax_token,
    word_accuracy,
    word_detected,
)


class FakeTokenizer:
    pad_token_id = 0
    _ids = {0: "<pad>", 1: "ʃ", 2: "iː", 3: "ɪ", 4: "p"}

    def convert_ids_to_tokens(self, index):
        return self._ids[index]


def _log_probs(path: list[int], classes: int = 5) -> torch.Tensor:
    logits = torch.full((1, len(path), classes), -10.0)
    for frame, token in enumerate(path):
        logits[0, frame, token] = 10.0
    return torch.log_softmax(logits, dim=-1)


def _span(token_id: int, ipa: str, raw_start: int, raw_end: int) -> PhoneSpan:
    return PhoneSpan(
        token_id=token_id,
        ipa=ipa,
        raw_start=raw_start,
        raw_end=raw_end,
        start=0,
        end=raw_end,
        ctc_score=1.0,
    )


def test_phone_gop_is_zero_when_the_expected_phone_dominates_its_span():
    log_probs = _log_probs([0, 1, 0])
    assert phone_gop(log_probs, _span(1, "ʃ", 1, 2)) == pytest.approx(0.0, abs=1e-6)


def test_phone_gop_is_strongly_negative_when_another_phone_dominates():
    log_probs = _log_probs([0, 3, 0])  # the learner produced token 3, we expected token 2
    assert phone_gop(log_probs, _span(2, "iː", 1, 2)) < -15.0


def test_phone_gop_uses_the_raw_span_not_the_expanded_one():
    log_probs = _log_probs([0, 2, 0, 0])
    good = PhoneSpan(token_id=2, ipa="iː", raw_start=1, raw_end=2, start=0, end=4, ctc_score=1.0)
    assert phone_gop(log_probs, good) == pytest.approx(0.0, abs=1e-6)


def test_span_argmax_token_names_what_was_actually_produced():
    log_probs = _log_probs([0, 3, 0])
    heard = span_argmax_token(log_probs, _span(2, "iː", 1, 2), FakeTokenizer())
    assert heard == "ɪ"


def test_span_argmax_token_never_returns_the_blank():
    log_probs = _log_probs([0, 0, 0])
    heard = span_argmax_token(log_probs, _span(2, "iː", 1, 2), FakeTokenizer())
    assert heard != "<pad>"


def test_gop_to_score_maps_zero_to_one_hundred_and_clamps():
    assert gop_to_score(0.0, 1.0) == 100
    assert gop_to_score(-1.0, 1.0) == 37
    assert gop_to_score(-20.0, 1.0) == 0
    assert gop_to_score(5.0, 1.0) == 100  # never above 100


def test_gop_to_score_is_monotone_and_tau_scales_it():
    assert gop_to_score(-0.5, 1.0) > gop_to_score(-2.0, 1.0)
    assert gop_to_score(-2.0, 2.0) == gop_to_score(-1.0, 1.0)


def test_detect_substitution_only_fires_on_a_difference():
    assert detect_substitution("iː", "ɪ") == "ɪ"
    assert detect_substitution("p", "p") is None


def test_word_accuracy_is_the_mean_phone_score():
    assert word_accuracy([100, 60]) == 80
    assert word_accuracy([90, 5, 82]) == 59
    assert word_accuracy([]) == 0


def test_sentence_accuracy_weights_words_by_phone_count():
    assert sentence_accuracy([80, 59], [2, 3]) == 67
    assert sentence_accuracy([], []) == 0


def test_word_detected_thresholds_on_the_mean_gop():
    assert word_detected([-0.1, -0.2], -5.0) is True
    assert word_detected([-9.0, -8.0], -5.0) is False


def test_completeness_is_the_share_of_detected_words():
    assert completeness([True, True, False]) == 67
    assert completeness([True, True]) == 100
    assert completeness([]) == 0


def test_gop_and_substitution_reflect_same_evidence():
    """GOP score and substitution label must be coherent evidence from the same tensor.

    A confidently-WRONG frame (probability mass on a phone other than expected)
    should yield BOTH a LOW gop AND a non-None substitution naming that same
    competing phone. A confidently-RIGHT frame should yield HIGH gop (~0) AND None.
    """
    # WRONG case: learner produced token 3 (ɪ), we expected token 2 (iː)
    log_probs_wrong = _log_probs([0, 3, 0])
    wrong_span = _span(2, "iː", 1, 2)
    gop_wrong = phone_gop(log_probs_wrong, wrong_span)
    heard_wrong = span_argmax_token(log_probs_wrong, wrong_span, FakeTokenizer())
    substitution_wrong = detect_substitution("iː", heard_wrong)

    assert gop_wrong < -15.0, "Expected low GOP for substitution case"
    assert heard_wrong == "ɪ", "Argmax should pick the dominating token"
    assert substitution_wrong == "ɪ", "Substitution should flag the mismatched token"

    # RIGHT case: learner produced token 1 (ʃ), we expected token 1 (ʃ)
    log_probs_right = _log_probs([0, 1, 0])
    right_span = _span(1, "ʃ", 1, 2)
    gop_right = phone_gop(log_probs_right, right_span)
    heard_right = span_argmax_token(log_probs_right, right_span, FakeTokenizer())
    substitution_right = detect_substitution("ʃ", heard_right)

    assert gop_right == pytest.approx(0.0, abs=1e-6), "Expected high GOP for correct case"
    assert heard_right == "ʃ", "Argmax should pick the expected token"
    assert substitution_right is None, "No substitution when expected matches heard"


def test_span_argmax_token_resolves_ties_deterministically():
    """When two tokens have identical mean log-probs, argmax pick must be deterministic.

    This test pins the current behavior against future regression.
    We construct a tensor where token 1 and token 3 have equal mean log-probs.
    """
    # Frame 0: token 1 dominates → high log-prob for token 1, low for others
    # Frame 1: token 3 dominates → high log-prob for token 3, low for others
    # After log_softmax and mean across frames, token 1 and token 3 have equal means.
    logits = torch.full((1, 2, 5), -10.0)
    logits[0, 0, 1] = 10.0  # frame 0: token 1
    logits[0, 1, 3] = 10.0  # frame 1: token 3
    log_probs_tie = torch.log_softmax(logits, dim=-1)

    # Span covers both frames: raw_start=0, raw_end=2 means frames 0–1 (inclusive of 0, exclusive of 2)
    tie_span = _span(1, "ʃ", 0, 2)

    # Run argmax on this tie
    heard = span_argmax_token(log_probs_tie, tie_span, FakeTokenizer())

    # PyTorch argmax returns the lower index on ties.
    # Token 1 (index 1) < Token 3 (index 3), so argmax should pick token 1 ("ʃ").
    assert heard == "ʃ", "Tied argmax must resolve to lower token index deterministically"
