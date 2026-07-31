"""Assembles the frozen PronunciationReport v1 (interface contract section 5).

Invariant I1: "substituted" is ABSENT when the phone was produced as expected.
Emitting "substituted": null is a contract violation -- the client's ranking
rule treats presence as evidence, so a null would fabricate an error.
"""

from __future__ import annotations

from .align import PhoneSpan, frames_to_seconds, unflatten
from .fluency import Prosody
from .gop import completeness, gop_to_score, sentence_accuracy, word_accuracy, word_detected

REPORT_VERSION = 1
SAMPLE_RATE = 16000


def build_report(
    *,
    words: list[str],
    phone_lists: list[list[str]],
    phone_spans: list[PhoneSpan],
    phone_gops: list[float],
    phone_subs: list[str | None],
    sec_per_frame: float,
    prosody: Prosody,
    fluency: int,
    model_id: str,
    mode: str,
    tau: float,
    detect_gop: float,
) -> dict:
    if not words:
        raise ValueError("build_report: at least one word is required")
    if len(words) != len(phone_lists):
        raise ValueError(
            f"build_report: {len(words)} words but {len(phone_lists)} phone lists"
        )

    counts = [len(tokens) for tokens in phone_lists]
    if not (len(phone_spans) == len(phone_gops) == len(phone_subs) == sum(counts)):
        raise ValueError(
            "build_report: spans/gops/subs must line up with the per-word phone counts"
        )

    span_groups = unflatten(list(phone_spans), counts)
    gop_groups = unflatten(list(phone_gops), counts)
    sub_groups = unflatten(list(phone_subs), counts)

    out_words: list[dict] = []
    word_scores: list[int] = []
    detected: list[bool] = []

    for word, spans, gops, subs in zip(words, span_groups, gop_groups, sub_groups):
        phones: list[dict] = []
        scores: list[int] = []
        for span, gop, substituted in zip(spans, gops, subs):
            score = gop_to_score(gop, tau)
            phone = {
                "ipa": span.ipa,
                "score": score,
                "start": frames_to_seconds(span.start, sec_per_frame),
                "end": frames_to_seconds(span.end, sec_per_frame),
            }
            if substituted:
                phone["substituted"] = substituted
            phones.append(phone)
            scores.append(score)

        accuracy = word_accuracy(scores)
        out_words.append(
            {
                "word": word,
                "start": phones[0]["start"],
                "end": phones[-1]["end"],
                "accuracy": accuracy,
                "phones": phones,
            }
        )
        word_scores.append(accuracy)
        detected.append(word_detected(list(gops), detect_gop))

    duration_sec = frames_to_seconds(phone_spans[-1].end, sec_per_frame)

    return {
        "version": REPORT_VERSION,
        "mode": mode,
        "model": model_id,
        "durationSec": duration_sec,
        "sampleRate": SAMPLE_RATE,
        "overall": {
            "accuracy": sentence_accuracy(word_scores, counts),
            "fluency": int(fluency),
            "completeness": completeness(detected),
        },
        "prosody": {
            "speechRateWpm": prosody.speech_rate_wpm,
            "articulationRateSyllPerSec": prosody.articulation_rate_syll_per_sec,
            "pauseCount": prosody.pause_count,
            "pauseTotalSec": prosody.pause_total_sec,
            "f0MinHz": prosody.f0_min_hz,
            "f0MaxHz": prosody.f0_max_hz,
            "f0RangeSemitones": prosody.f0_range_semitones,
        },
        "words": out_words,
    }


def strip_phones(report: dict) -> dict:
    """Defence in depth -- the Node route strips too, for every provider."""
    out = dict(report)
    out["words"] = [
        {key: value for key, value in word.items() if key != "phones"}
        for word in report.get("words", [])
    ]
    return out
