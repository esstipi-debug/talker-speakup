"""run_calibration tests. `records` is always a plain in-memory list here --
iter_records's real datasets.load_dataset call is exercised by nothing in this
suite, by design (see the module docstring)."""
import csv
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar_client import SidecarError  # noqa: E402

from run_calibration import main, process_record, run, write_rows  # noqa: E402


def _record(utt_id="test-00001", accuracy=8, word_count=1):
    return {
        "utt_id": utt_id,
        "accuracy": accuracy,
        "text": "hi",
        "words": [{"phones": ["HH"], "phones-accuracy": [2.0], "mispronunciations": []}] * word_count,
        "audio": {"array": [0.0, 0.1, -0.1], "sampling_rate": 16000},
    }


def _report(accuracy=80, word_count=1):
    return {
        "overall": {"accuracy": accuracy},
        "words": [{"phones": [{"ipa": "h", "score": 80}]}] * word_count,
    }


def test_process_record_returns_utterance_and_phoneme_rows_on_success():
    with patch("run_calibration.call_assess", return_value=_report()):
        rows = process_record("facebook", "http://localhost:8899", _record())
    assert any(r["level"] == "utterance" for r in rows)
    assert any(r["level"] == "phoneme" for r in rows)
    assert all(r["error_code"] == "" for r in rows)


def test_process_record_returns_an_error_row_on_a_sidecar_error():
    with patch("run_calibration.call_assess", side_effect=SidecarError("NO_SPEECH", "quiet", 422)):
        rows = process_record("facebook", "http://localhost:8899", _record())
    assert len(rows) == 1
    assert rows[0]["level"] == "error"
    assert rows[0]["error_code"] == "NO_SPEECH"


def test_process_record_returns_an_error_row_on_a_word_count_mismatch():
    with patch("run_calibration.call_assess", return_value=_report(word_count=2)):
        rows = process_record("facebook", "http://localhost:8899", _record(word_count=1))
    assert len(rows) == 1
    assert rows[0]["level"] == "error"
    assert rows[0]["error_code"] == "WORD_COUNT_MISMATCH"


def test_write_rows_writes_the_header_and_every_row(tmp_path):
    from correlate import REQUIRED_COLUMNS
    from record_transform import BLANK_ROW

    path = tmp_path / "out.csv"
    write_rows(path, [{**BLANK_ROW, "model": "facebook", "utt_id": "a"}], header=True)
    with path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["model"] == "facebook"
    assert list(rows[0]) == list(REQUIRED_COLUMNS)


def test_run_scores_every_record_and_returns_a_summary(tmp_path):
    records = [_record(utt_id="test-00001"), _record(utt_id="test-00002")]
    with patch("run_calibration.call_assess", return_value=_report()):
        summary = run(
            model="facebook",
            base_url="http://localhost:8899",
            records=records,
            out_path=tmp_path / "scores.csv",
        )
    assert summary == {"scored": 2, "failed": 0, "total": 2}
    with (tmp_path / "scores.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert sum(1 for r in rows if r["level"] == "utterance") == 2


def test_run_counts_a_sidecar_failure_as_failed_not_a_crash(tmp_path):
    records = [_record(utt_id="test-00001")]
    with patch("run_calibration.call_assess", side_effect=SidecarError("NO_SPEECH", "quiet", 422)):
        summary = run(
            model="facebook",
            base_url="http://localhost:8899",
            records=records,
            out_path=tmp_path / "scores.csv",
        )
    assert summary == {"scored": 0, "failed": 1, "total": 1}


def test_main_fails_fast_when_the_sidecar_is_unreachable(tmp_path, capsys):
    with patch(
        "run_calibration.check_health",
        side_effect=SidecarError("UNREACHABLE", "refused", 0),
    ):
        code = main(["--sidecar-url", "http://localhost:8899", "--out", str(tmp_path / "out.csv")])
    assert code == 1
    assert "unreachable" in capsys.readouterr().out.lower()


def test_main_uses_the_health_reported_model_as_the_label_by_default(tmp_path, capsys):
    with (
        patch("run_calibration.check_health", return_value={"status": "ok", "model": "facebook/x"}),
        patch("run_calibration.iter_records", return_value=[_record()]),
        patch("run_calibration.call_assess", return_value=_report()),
    ):
        code = main(["--out", str(tmp_path / "out.csv"), "--limit", "1"])
    assert code == 0
    with (tmp_path / "out.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["model"] == "facebook/x"


def test_main_respects_an_explicit_model_label_override(tmp_path):
    with (
        patch("run_calibration.check_health", return_value={"status": "ok", "model": "facebook/x"}),
        patch("run_calibration.iter_records", return_value=[_record()]),
        patch("run_calibration.call_assess", return_value=_report()),
    ):
        main(["--out", str(tmp_path / "out.csv"), "--model-label", "candidate-b", "--limit", "1"])
    with (tmp_path / "out.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["model"] == "candidate-b"


def test_main_returns_1_and_warns_when_every_record_fails_the_same_way(tmp_path, capsys):
    """A systemic failure (wrong dependency version, sidecar down mid-run, corrupted
    corpus slice) makes every record fail identically -- that must never look like a
    normal completed run with a quietly empty CSV of 0% coverage."""
    records = [_record(utt_id="test-00001"), _record(utt_id="test-00002")]
    with (
        patch("run_calibration.check_health", return_value={"status": "ok", "model": "facebook/x"}),
        patch("run_calibration.iter_records", return_value=records),
        patch("run_calibration.call_assess", side_effect=SidecarError("NO_SPEECH", "quiet", 422)),
    ):
        code = main(["--out", str(tmp_path / "out.csv"), "--limit", "2"])
    assert code == 1
    out = capsys.readouterr().out.lower()
    assert "warning" in out
    assert "systemic" in out


def test_run_returns_a_summary_with_zero_scored_when_every_record_fails_the_same_way(tmp_path):
    records = [_record(utt_id="test-00001"), _record(utt_id="test-00002")]
    with patch("run_calibration.call_assess", side_effect=SidecarError("NO_SPEECH", "quiet", 422)):
        summary = run(
            model="facebook",
            base_url="http://localhost:8899",
            records=records,
            out_path=tmp_path / "scores.csv",
        )
    assert summary == {"scored": 0, "failed": 2, "total": 2}


def test_main_does_not_print_wrote_when_there_are_no_records(tmp_path, capsys):
    with (
        patch("run_calibration.check_health", return_value={"status": "ok", "model": "facebook/x"}),
        patch("run_calibration.iter_records", return_value=[]),
    ):
        main(["--out", str(tmp_path / "out.csv"), "--limit", "0"])
    out = capsys.readouterr().out.lower()
    assert "wrote" not in out
