"""The assembled report must satisfy the frozen v1 JSON Schema plus the
invariants the schema cannot express (contract section 5.1).
"""

import jsonschema
import pytest

from app.align import PhoneSpan
from app.fluency import Prosody
from app.report import build_report, strip_phones

PRONUNCIATION_REPORT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://speakup.local/schemas/pronunciation-report-v1.json",
    "title": "PronunciationReport",
    "type": "object",
    "additionalProperties": False,
    "required": ["version", "mode", "model", "overall", "prosody", "words"],
    "properties": {
        "version": {"type": "integer", "const": 1},
        "mode": {"type": "string", "enum": ["scripted", "unscripted"]},
        "pronProvider": {"type": "string", "enum": ["local", "mock", "azure"]},
        "model": {"type": "string", "minLength": 1},
        "durationSec": {"type": "number", "minimum": 0},
        "sampleRate": {"type": "integer", "const": 16000},
        "overall": {
            "type": "object",
            "additionalProperties": False,
            "required": ["accuracy", "fluency", "completeness"],
            "properties": {
                "accuracy": {"type": "integer", "minimum": 0, "maximum": 100},
                "fluency": {"type": "integer", "minimum": 0, "maximum": 100},
                "completeness": {"type": "integer", "minimum": 0, "maximum": 100},
            },
        },
        "prosody": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "speechRateWpm",
                "articulationRateSyllPerSec",
                "pauseCount",
                "pauseTotalSec",
                "f0MinHz",
                "f0MaxHz",
                "f0RangeSemitones",
            ],
            "properties": {
                "speechRateWpm": {"type": "number", "minimum": 0},
                "articulationRateSyllPerSec": {"type": "number", "minimum": 0},
                "pauseCount": {"type": "integer", "minimum": 0},
                "pauseTotalSec": {"type": "number", "minimum": 0},
                "f0MinHz": {"type": ["number", "null"], "minimum": 0},
                "f0MaxHz": {"type": ["number", "null"], "minimum": 0},
                "f0RangeSemitones": {"type": ["number", "null"], "minimum": 0},
            },
        },
        "words": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["word", "start", "end", "accuracy"],
                "properties": {
                    "word": {"type": "string", "minLength": 1},
                    "start": {"type": "number", "minimum": 0},
                    "end": {"type": "number", "minimum": 0},
                    "accuracy": {"type": "integer", "minimum": 0, "maximum": 100},
                    "phones": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["ipa", "score", "start", "end"],
                            "properties": {
                                "ipa": {"type": "string", "minLength": 1},
                                "score": {"type": "integer", "minimum": 0, "maximum": 100},
                                "start": {"type": "number", "minimum": 0},
                                "end": {"type": "number", "minimum": 0},
                                "substituted": {"type": "string", "minLength": 1},
                            },
                        },
                    },
                },
            },
        },
    },
}

WORDS = ["the", "sheep"]
PHONE_LISTS = [["ð", "ə"], ["ʃ", "iː", "p"]]
FRAMES = [(0, 5), (5, 10), (10, 15), (15, 25), (25, 33)]
IPA_FLAT = ["ð", "ə", "ʃ", "iː", "p"]
GOPS = [0.0, -0.51, -0.1, -3.0, -0.2]
SUBS = [None, None, None, "ɪ", None]

PROSODY = Prosody(
    speech_rate_wpm=132.5,
    articulation_rate_syll_per_sec=4.2,
    pause_count=1,
    pause_total_sec=0.31,
    f0_min_hz=None,
    f0_max_hz=None,
    f0_range_semitones=None,
)


def _spans():
    return [
        PhoneSpan(
            token_id=index,
            ipa=ipa,
            raw_start=start,
            raw_end=start + 1,
            start=start,
            end=end,
            ctc_score=0.9,
        )
        for index, (ipa, (start, end)) in enumerate(zip(IPA_FLAT, FRAMES))
    ]


def _report(mode: str = "scripted"):
    return build_report(
        words=WORDS,
        phone_lists=PHONE_LISTS,
        phone_spans=_spans(),
        phone_gops=GOPS,
        phone_subs=SUBS,
        sec_per_frame=0.02,
        prosody=PROSODY,
        fluency=84,
        model_id="facebook/wav2vec2-lv-60-espeak-cv-ft",
        mode=mode,
        tau=1.0,
        detect_gop=-5.0,
    )


def test_report_validates_against_the_frozen_v1_schema():
    jsonschema.validate(_report(), PRONUNCIATION_REPORT_SCHEMA)


def test_envelope_carries_the_sidecar_only_fields_and_no_pron_provider():
    report = _report()
    assert report["version"] == 1
    assert report["mode"] == "scripted"
    assert report["model"] == "facebook/wav2vec2-lv-60-espeak-cv-ft"
    assert report["sampleRate"] == 16000
    assert report["durationSec"] == 0.66
    assert "pronProvider" not in report  # invariant I7: the Node layer adds it


def test_scores_are_the_gop_mapping_aggregated_by_phone_count():
    report = _report()
    assert [p["score"] for p in report["words"][0]["phones"]] == [100, 60]
    assert [p["score"] for p in report["words"][1]["phones"]] == [90, 5, 82]
    assert report["words"][0]["accuracy"] == 80
    assert report["words"][1]["accuracy"] == 59
    assert report["overall"]["accuracy"] == 67
    assert report["overall"]["fluency"] == 84
    assert report["overall"]["completeness"] == 100


def test_substituted_is_absent_never_null_when_the_phone_was_correct():
    phones = [p for word in _report()["words"] for p in word["phones"]]
    correct = [p for p in phones if p["ipa"] != "iː"]
    assert all("substituted" not in p for p in correct)
    heard = [p for p in phones if p["ipa"] == "iː"][0]
    assert heard["substituted"] == "ɪ"


def test_word_bounds_match_their_first_and_last_phone():
    for word in _report()["words"]:
        assert word["start"] == word["phones"][0]["start"]
        assert word["end"] == word["phones"][-1]["end"]
        assert word["end"] >= word["start"]


def test_phone_spans_are_contiguous_and_ascending():
    phones = [p for word in _report()["words"] for p in word["phones"]]
    for current, following in zip(phones, phones[1:]):
        assert current["end"] == following["start"]


def test_prosody_is_copied_across_with_null_f0():
    prosody = _report()["prosody"]
    assert prosody["speechRateWpm"] == 132.5
    assert prosody["articulationRateSyllPerSec"] == 4.2
    assert prosody["pauseCount"] == 1
    assert prosody["pauseTotalSec"] == 0.31
    assert prosody["f0MinHz"] is None
    assert prosody["f0MaxHz"] is None
    assert prosody["f0RangeSemitones"] is None


def test_strip_phones_removes_every_phone_row_without_mutating_the_input():
    report = _report()
    stripped = strip_phones(report)

    assert all("phones" not in word for word in stripped["words"])
    assert all("phones" in word for word in report["words"])
    jsonschema.validate(stripped, PRONUNCIATION_REPORT_SCHEMA)


def test_build_report_refuses_misaligned_inputs():
    with pytest.raises(ValueError):
        build_report(
            words=WORDS,
            phone_lists=PHONE_LISTS,
            phone_spans=_spans()[:4],
            phone_gops=GOPS,
            phone_subs=SUBS,
            sec_per_frame=0.02,
            prosody=PROSODY,
            fluency=84,
            model_id="m",
            mode="scripted",
            tau=1.0,
            detect_gop=-5.0,
        )
