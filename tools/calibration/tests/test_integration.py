"""End-to-end test: record_transform's output driven through write_rows ->
load_rows -> judge together. Both test_record_transform.py and test_correlate.py
build isolated fixtures by hand -- exactly how the phoneme_rows() false-negative
and false-positive bugs (dropped human phones producing no row at all; one
multi-phone substitution duplicated onto every row it touches) stayed invisible.
This test wires the real pipeline end to end so a regression in either bug shows
up here even if the unit-level fixtures drift.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from correlate import load_rows, judge  # noqa: E402
from record_transform import build_utterance_rows  # noqa: E402
from run_calibration import write_rows  # noqa: E402


def _fanout_pair():
    """One utterance where a single espeak unit ("ɑːɹ") covers two human phones
    (AA + R) and only R is rater-flagged as mispronounced. The machine's one
    `substituted` event must land on exactly one row (R), never on AA too --
    that would manufacture a false positive out of a table artifact (BUG B).
    """
    human_record = {
        "utt_id": "fanout-00000",
        "accuracy": 6,
        "words": [
            {
                "phones": ["K", "AA1", "R"],
                "phones-accuracy": [2.0, 1.0, 0.0],
                "mispronunciations": [
                    {"index": 2, "canonical-phone": "R", "pronounced-phone": "L"}
                ],
            }
        ],
    }
    machine_report = {
        "overall": {"accuracy": 55},
        "words": [
            {
                "phones": [
                    {"ipa": "k", "score": 90},
                    {"ipa": "ɑːɹ", "score": 40, "substituted": "l"},
                ]
            }
        ],
    }
    return human_record, machine_report


def _dropped_phone_pair():
    """One utterance where the model drops a rater-flagged human phone (R)
    entirely -- no machine phone aligns to it. Must still produce a row (BUG A)
    so it is counted as a substitution false negative instead of vanishing.
    """
    human_record = {
        "utt_id": "drop-00000",
        "accuracy": 5,
        "words": [
            {
                "phones": ["S", "T", "R"],
                "phones-accuracy": [2.0, 2.0, 0.0],
                "mispronunciations": [
                    {"index": 2, "canonical-phone": "R", "pronounced-phone": "L"}
                ],
            }
        ],
    }
    machine_report = {
        "overall": {"accuracy": 60},
        "words": [{"phones": [{"ipa": "s", "score": 90}, {"ipa": "t", "score": 90}]}],
    }
    return human_record, machine_report


def _clean_pair(utt_id: str):
    """A plain, fully-matched utterance with no substitutions at all -- padding
    so the pipeline exercises a case with nothing noteworthy alongside the two
    bug-triggering ones."""
    human_record = {
        "utt_id": utt_id,
        "accuracy": 9,
        "words": [
            {"phones": ["P", "IY1"], "phones-accuracy": [2.0, 2.0], "mispronunciations": []}
        ],
    }
    machine_report = {
        "overall": {"accuracy": 90},
        "words": [{"phones": [{"ipa": "p", "score": 95}, {"ipa": "iː", "score": 92}]}],
    }
    return human_record, machine_report


def test_pipeline_counts_the_fanout_and_dropped_phone_cases_correctly(tmp_path):
    pairs = [_fanout_pair(), _dropped_phone_pair(), _clean_pair("clean-00000"), _clean_pair("clean-00001")]

    all_rows: list[dict] = []
    for human_record, machine_report in pairs:
        rows = build_utterance_rows("facebook", human_record["utt_id"], human_record, machine_report)
        all_rows.append(rows)

    out_path = tmp_path / "scores.csv"
    for index, rows in enumerate(all_rows):
        write_rows(out_path, rows, header=(index == 0))

    loaded = load_rows(out_path)
    verdict = judge(loaded, "facebook")

    # BUG B fixed: the fan-out's one `substituted` event lands on exactly one
    # row (R), so it is one true positive with the right identity, not also a
    # phantom false positive on the AA row that shares the same machine unit.
    assert verdict.substitutions.true_positives == 1
    assert verdict.substitutions.false_positives == 0
    assert verdict.substitutions.identity_matches == 1

    # BUG A fixed: the dropped, rater-flagged R phone now produces a row and is
    # counted as a false negative instead of silently vanishing.
    assert verdict.substitutions.false_negatives == 1
