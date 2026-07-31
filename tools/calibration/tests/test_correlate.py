"""Correlation, verdict and model-selection tests for the calibration harness."""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import csv  # noqa: E402

import pytest  # noqa: E402

from correlate import Correlation, correlate  # noqa: E402

from correlate import (  # noqa: E402
    REQUIRED_COLUMNS,
    SubstitutionAgreement,
    coverage,
    load_rows,
    models,
    pairs,
    substitution_agreement,
    ModelVerdict,
    judge,
    select_model,
)


def test_perfectly_linear_data_correlates_at_one():
    result = correlate([1.0, 2.0, 3.0, 4.0], [10.0, 20.0, 30.0, 40.0])
    assert isinstance(result, Correlation)
    assert result.n == 4
    assert result.pearson_r == pytest.approx(1.0)
    assert result.spearman_rho == pytest.approx(1.0)


def test_perfectly_inverted_data_correlates_at_minus_one():
    result = correlate([1.0, 2.0, 3.0, 4.0], [40.0, 30.0, 20.0, 10.0])
    assert result.pearson_r == pytest.approx(-1.0)
    assert result.spearman_rho == pytest.approx(-1.0)


def test_monotone_but_curved_data_ranks_higher_than_it_lines_up():
    # Spearman sees the perfect ordering; Pearson is dragged down by the curve.
    xs = [1.0, 2.0, 3.0, 4.0, 5.0]
    ys = [1.0, 4.0, 9.0, 16.0, 100.0]
    result = correlate(xs, ys)
    assert result.spearman_rho == pytest.approx(1.0)
    assert result.pearson_r < 0.95


def test_constant_input_yields_nan_rather_than_a_crash():
    result = correlate([5.0, 5.0, 5.0, 5.0], [1.0, 2.0, 3.0, 4.0])
    assert result.n == 4
    assert math.isnan(result.pearson_r)
    assert math.isnan(result.spearman_rho)


def test_too_few_samples_yields_nan():
    result = correlate([1.0, 2.0], [1.0, 2.0])
    assert result.n == 2
    assert math.isnan(result.pearson_r)


def test_mismatched_lengths_are_a_programming_error():
    with pytest.raises(ValueError, match="same length"):
        correlate([1.0, 2.0], [1.0])


def _write_csv(tmp_path, rows):
    path = tmp_path / "scores.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(REQUIRED_COLUMNS))
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in REQUIRED_COLUMNS})
    return path


def _row(**overrides):
    base = {
        "model": "facebook",
        "level": "utterance",
        "utt_id": "test-00000",
        "word_index": "",
        "phone_index": "",
        "ipa": "",
        "arpabet": "",
        "human": "80",
        "machine": "70",
        "human_sub": "",
        "machine_sub": "",
        "machine_sub_arpabet": "",
        "error_code": "",
    }
    base.update(overrides)
    return base


def test_load_rows_reads_every_data_row(tmp_path):
    path = _write_csv(tmp_path, [_row(), _row(utt_id="test-00001", human="60")])
    rows = load_rows(path)
    assert len(rows) == 2
    assert rows[1]["human"] == "60"


def test_load_rows_rejects_a_csv_missing_a_required_column(tmp_path):
    path = tmp_path / "bad.csv"
    path.write_text("model,level\nfacebook,utterance\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing column"):
        load_rows(path)


def test_models_are_sorted_and_deduplicated():
    rows = [_row(model="mrrubino"), _row(model="facebook"), _row(model="facebook")]
    assert models(rows) == ["facebook", "mrrubino"]


def test_coverage_is_scored_utterances_over_attempted_utterances():
    rows = [
        _row(),
        _row(utt_id="test-00001"),
        _row(utt_id="test-00002", level="error", human="", machine="", error_code="NO_SPEECH"),
        _row(model="mrrubino", level="error", human="", machine="", error_code="UNPRONOUNCEABLE_TEXT"),
    ]
    assert coverage(rows, "facebook") == pytest.approx(2 / 3)
    assert coverage(rows, "mrrubino") == 0.0
    assert coverage(rows, "absent") == 0.0


def test_pairs_selects_one_level_of_one_model_and_skips_blanks():
    rows = [
        _row(human="80", machine="70"),
        _row(level="phoneme", human="100", machine="90"),
        _row(model="mrrubino", human="10", machine="10"),
        _row(human="", machine="55"),
    ]
    assert pairs(rows, "facebook", "utterance") == ([80.0], [70.0])
    assert pairs(rows, "facebook", "phoneme") == ([100.0], [90.0])


def test_substitution_agreement_counts_detection_and_identity():
    rows = [
        # true positive, right identity: human heard IY where IH was expected
        _row(level="phoneme", human_sub="IY1", machine_sub="iː", machine_sub_arpabet="IY"),
        # true positive, wrong identity
        _row(level="phoneme", human_sub="EH0", machine_sub="æ", machine_sub_arpabet="AE"),
        # false positive: the machine invented a substitution
        _row(level="phoneme", human_sub="", machine_sub="b", machine_sub_arpabet="B"),
        # false negative: the machine missed one
        _row(level="phoneme", human_sub="D", machine_sub="", machine_sub_arpabet=""),
        # agreed-correct phone, counts toward neither
        _row(level="phoneme"),
        # utterance rows are ignored entirely
        _row(level="utterance", human_sub="D"),
    ]
    result = substitution_agreement(rows, "facebook")
    assert isinstance(result, SubstitutionAgreement)
    assert (result.true_positives, result.false_positives, result.false_negatives) == (2, 1, 1)
    assert result.precision == pytest.approx(2 / 3)
    assert result.recall == pytest.approx(2 / 3)
    assert result.f1 == pytest.approx(2 / 3)
    assert result.identity_matches == 1
    assert result.identity_accuracy == pytest.approx(0.5)


def test_substitution_agreement_is_all_zero_when_nothing_was_flagged():
    result = substitution_agreement([_row(level="phoneme")], "facebook")
    assert result.f1 == 0.0
    assert result.precision == 0.0
    assert result.recall == 0.0
    assert result.identity_accuracy == 0.0


def test_substitution_identity_ignores_the_stress_digit():
    rows = [_row(level="phoneme", human_sub="AA1", machine_sub="ɑː", machine_sub_arpabet="AA")]
    result = substitution_agreement(rows, "facebook")
    assert result.identity_matches == 1


def _utterance_rows(model, count, *, invert=False):
    rows = []
    for index in range(count):
        human = float(index * 2)
        machine = float((count - index) * 2) if invert else human
        rows.append(
            _row(
                model=model,
                level="utterance",
                utt_id=f"test-{index:05d}",
                human=str(human),
                machine=str(machine),
            )
        )
    return rows


def _phoneme_rows(model, count, *, invert=False, subs=0):
    rows = []
    for index in range(count):
        human = float(index)
        machine = float(count - index) if invert else human
        human_sub = "IY1" if index < subs else ""
        machine_sub = "iː" if index < subs else ""
        rows.append(
            _row(
                model=model,
                level="phoneme",
                utt_id=f"test-{index:05d}",
                word_index="0",
                phone_index=str(index),
                ipa="ɪ",
                arpabet="IH",
                human=str(human),
                machine=str(machine),
                human_sub=human_sub,
                machine_sub=machine_sub,
                machine_sub_arpabet="IY" if machine_sub else "",
            )
        )
    return rows


def test_a_well_correlated_model_passes_and_shows_numbers():
    rows = _utterance_rows("facebook", 40) + _phoneme_rows("facebook", 40)
    result = judge(rows, "facebook")
    assert isinstance(result, ModelVerdict)
    assert result.verdict == "PASS"
    assert result.show_numeric_scores is True
    assert result.coverage == pytest.approx(1.0)
    assert result.levels["utterance"].pearson_r == pytest.approx(1.0)


def test_low_coverage_disqualifies_before_correlation_is_considered():
    rows = _utterance_rows("mrrubino", 10) + [
        _row(
            model="mrrubino",
            level="error",
            utt_id=f"err-{index:05d}",
            human="",
            machine="",
            error_code="UNPRONOUNCEABLE_TEXT",
        )
        for index in range(40)
    ]
    result = judge(rows, "mrrubino")
    assert result.verdict == "DISQUALIFIED"
    assert result.show_numeric_scores is False
    assert any("coverage" in reason for reason in result.reasons)


def test_weak_correlation_with_usable_substitutions_falls_back_to_substitutions_only():
    rows = _utterance_rows("facebook", 40, invert=True) + _phoneme_rows(
        "facebook", 40, invert=True, subs=20
    )
    result = judge(rows, "facebook")
    assert result.verdict == "SUBSTITUTIONS_ONLY"
    assert result.show_numeric_scores is False
    assert result.substitutions.f1 == pytest.approx(1.0)
    assert any("fallback" in reason for reason in result.reasons)


def test_weak_correlation_and_weak_substitutions_fails_outright():
    rows = _utterance_rows("facebook", 40, invert=True) + _phoneme_rows(
        "facebook", 40, invert=True
    )
    result = judge(rows, "facebook")
    assert result.verdict == "FAIL"
    assert result.show_numeric_scores is False


def test_too_few_samples_never_passes():
    rows = _utterance_rows("facebook", 5) + _phoneme_rows("facebook", 5)
    result = judge(rows, "facebook")
    assert result.verdict != "PASS"
    assert any("samples" in reason for reason in result.reasons)


def test_select_model_prefers_pass_then_the_stronger_correlation():
    strong = judge(_utterance_rows("a", 40) + _phoneme_rows("a", 40), "a")
    fallback = judge(
        _utterance_rows("b", 40, invert=True) + _phoneme_rows("b", 40, invert=True, subs=20),
        "b",
    )
    assert select_model([fallback, strong]).model == "a"
    assert select_model([fallback]).model == "b"
    assert select_model([]) is None


def test_select_model_returns_none_when_every_candidate_failed():
    failed = judge(
        _utterance_rows("a", 40, invert=True) + _phoneme_rows("a", 40, invert=True), "a"
    )
    assert failed.verdict == "FAIL"
    assert select_model([failed]) is None
