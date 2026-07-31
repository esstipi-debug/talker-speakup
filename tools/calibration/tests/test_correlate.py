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
    coverage,
    load_rows,
    models,
    pairs,
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
