"""Goodness of Pronunciation and its aggregation.

gop = mean over the RAW span of (log p(expected phone) - log p(best phone)).
Range (-inf, 0], 0 = the model agrees the expected phone is the best
explanation of those frames. The raw span matters: the expanded span from
expand_spans is mostly CTC blanks and would push every phone's GOP down.
"""

from __future__ import annotations

import math

from .align import PhoneSpan


def _segment(log_probs, span: PhoneSpan):
    start = int(span.raw_start)
    end = int(span.raw_end)
    if end <= start:
        end = start + 1
    return log_probs[0, start:end]


def phone_gop(log_probs, span: PhoneSpan) -> float:
    segment = _segment(log_probs, span)
    if segment.shape[0] == 0:
        return 0.0
    best = segment.max(dim=-1).values
    return float((segment[:, int(span.token_id)] - best).mean())


def span_argmax_token(log_probs, span: PhoneSpan, tokenizer) -> str:
    segment = _segment(log_probs, span)
    mean = segment.mean(dim=0).clone()
    mean[int(tokenizer.pad_token_id)] = float("-inf")
    return str(tokenizer.convert_ids_to_tokens(int(mean.argmax())))


def gop_to_score(gop: float, tau: float) -> int:
    temperature = tau if tau and tau > 0 else 1.0
    return max(0, min(100, round(100.0 * math.exp(float(gop) / temperature))))


def detect_substitution(expected_ipa: str, argmax_ipa: str) -> str | None:
    if argmax_ipa and argmax_ipa != expected_ipa:
        return argmax_ipa
    return None


def word_accuracy(phone_scores: list[int]) -> int:
    if not phone_scores:
        return 0
    return round(sum(phone_scores) / len(phone_scores))


def sentence_accuracy(word_scores: list[int], phone_counts: list[int]) -> int:
    total = sum(phone_counts)
    if total == 0:
        return 0
    weighted = sum(score * count for score, count in zip(word_scores, phone_counts))
    return round(weighted / total)


def word_detected(phone_gops: list[float], detect_gop: float) -> bool:
    if not phone_gops:
        return False
    return (sum(phone_gops) / len(phone_gops)) > detect_gop


def completeness(detected: list[bool]) -> int:
    if not detected:
        return 0
    return round(100 * sum(1 for flag in detected if flag) / len(detected))
