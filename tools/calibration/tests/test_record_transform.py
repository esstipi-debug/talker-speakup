"""record_transform tests. Every fixture below is hand-built, matching
speechocean762's real schema (verified via the HuggingFace dataset viewer for
mispeech/speechocean762) and the sidecar's real PronunciationReport shape
(verified against docs/superpowers/plans/2026-07-27-pronunciation-1-sidecar.md).
No network, no corpus download.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from correlate import REQUIRED_COLUMNS  # noqa: E402
from record_transform import (  # noqa: E402
    BLANK_ROW,
    build_utterance_rows,
    error_row,
    phoneme_rows,
    utterance_row,
)


def test_blank_row_has_every_required_column_set_to_empty_string():
    assert set(BLANK_ROW) == set(REQUIRED_COLUMNS)
    assert all(value == "" for value in BLANK_ROW.values())


def test_utterance_row_carries_the_human_and_machine_accuracy():
    row = utterance_row("facebook", "test-00001", 8, 74)
    assert row["model"] == "facebook"
    assert row["level"] == "utterance"
    assert row["utt_id"] == "test-00001"
    assert row["human"] == "8"
    assert row["machine"] == "74"


def test_error_row_carries_only_the_error_code():
    row = error_row("facebook", "test-00002", "NO_SPEECH")
    assert row["level"] == "error"
    assert row["error_code"] == "NO_SPEECH"
    assert row["human"] == ""
    assert row["machine"] == ""


def test_phoneme_rows_pairs_one_to_one_when_lengths_agree():
    human_word = {
        "phones": ["DH", "AH0"],
        "phones-accuracy": [2.0, 1.5],
        "mispronunciations": [],
    }
    machine_word = {"phones": [{"ipa": "ð", "score": 95}, {"ipa": "ə", "score": 70}]}
    rows = phoneme_rows("facebook", "test-00001", 0, human_word, machine_word)
    assert len(rows) == 2
    assert rows[0]["ipa"] == "ð"
    assert rows[0]["arpabet"] == "DH"
    assert rows[0]["human"] == "2.0"
    assert rows[0]["machine"] == "95"
    assert rows[1]["arpabet"] == "AH"  # stress digit stripped
    assert all(r["level"] == "phoneme" and r["word_index"] == "0" for r in rows)
    assert rows[0]["phone_index"] == "0"
    assert rows[1]["phone_index"] == "1"


def test_phoneme_rows_gives_a_multi_phone_machine_unit_one_row_per_human_phone():
    # espeak's "ɑːɹ" covers the corpus's AA + R as two separate scored phones.
    human_word = {"phones": ["K", "AA1", "R"], "phones-accuracy": [2.0, 1.0, 2.0], "mispronunciations": []}
    machine_word = {"phones": [{"ipa": "k", "score": 90}, {"ipa": "ɑːɹ", "score": 60}]}
    rows = phoneme_rows("facebook", "test-00003", 0, human_word, machine_word)
    assert len(rows) == 3
    assert rows[0]["ipa"] == "k"
    assert rows[0]["arpabet"] == "K"
    assert rows[0]["human"] == "2.0"
    assert rows[0]["machine"] == "90"
    # phone_index 1 and 2 both come from the SAME machine phone ("ɑːɹ"), so they
    # share its machine score but keep their own distinct human ground truth.
    shared = [r for r in rows if r["ipa"] == "ɑːɹ"]
    assert len(shared) == 2
    assert {r["phone_index"] for r in shared} == {"1", "2"}
    assert {r["human"] for r in shared} == {"1.0", "2.0"}
    assert all(r["machine"] == "60" for r in shared)


def test_phoneme_rows_carries_the_pronounced_phone_as_human_sub_not_the_canonical_one():
    human_word = {
        "phones": ["IH1"],
        "phones-accuracy": [0.0],
        "mispronunciations": [{"index": 0, "canonical-phone": "IH1", "pronounced-phone": "IY0"}],
    }
    machine_word = {"phones": [{"ipa": "ɪ", "score": 20, "substituted": "iː"}]}
    row = phoneme_rows("facebook", "test-00004", 0, human_word, machine_word)[0]
    assert row["human_sub"] == "IY"  # pronounced-phone, stress stripped -- NOT "IH" (the canonical one)
    assert row["machine_sub"] == "iː"
    assert row["machine_sub_arpabet"] == "IY"


def test_phoneme_rows_leaves_human_sub_and_machine_sub_blank_when_correct():
    human_word = {"phones": ["P"], "phones-accuracy": [2.0], "mispronunciations": []}
    machine_word = {"phones": [{"ipa": "p", "score": 95}]}
    row = phoneme_rows("facebook", "test-00005", 0, human_word, machine_word)[0]
    assert row["human_sub"] == ""
    assert row["machine_sub"] == ""
    assert row["machine_sub_arpabet"] == ""


def test_phoneme_rows_skips_a_machine_phone_that_aligns_to_nothing():
    # The machine hears an extra phone the corpus transcription does not have.
    human_word = {"phones": ["S", "T"], "phones-accuracy": [2.0, 2.0], "mispronunciations": []}
    machine_word = {
        "phones": [
            {"ipa": "s", "score": 90},
            {"ipa": "t", "score": 90},
            {"ipa": "t", "score": 10},  # extra, aligns to nothing per align_ipa_to_arpabet
        ]
    }
    rows = phoneme_rows("facebook", "test-00006", 0, human_word, machine_word)
    assert len(rows) == 2


def test_build_utterance_rows_combines_the_utterance_row_and_every_words_phoneme_rows():
    human_record = {
        "accuracy": 8,
        "words": [
            {"phones": ["DH"], "phones-accuracy": [2.0], "mispronunciations": []},
            {"phones": ["P"], "phones-accuracy": [1.0], "mispronunciations": []},
        ],
    }
    machine_report = {
        "overall": {"accuracy": 82},
        "words": [
            {"phones": [{"ipa": "ð", "score": 90}]},
            {"phones": [{"ipa": "p", "score": 40}]},
        ],
    }
    rows = build_utterance_rows("facebook", "test-00007", human_record, machine_report)
    assert sum(1 for r in rows if r["level"] == "utterance") == 1
    assert sum(1 for r in rows if r["level"] == "phoneme") == 2


def test_build_utterance_rows_raises_on_a_word_count_mismatch():
    human_record = {"accuracy": 8, "words": [{}, {}]}
    machine_report = {"overall": {"accuracy": 80}, "words": [{}]}
    with pytest.raises(ValueError, match="word count"):
        build_utterance_rows("facebook", "test-00008", human_record, machine_report)
