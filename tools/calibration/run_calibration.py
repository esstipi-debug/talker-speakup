"""Iterate speechocean762, score each utterance with the local sidecar, and
write the CSV correlate.py analyzes.

`datasets` is imported lazily inside iter_records so importing this module (or
running its unit tests) never triggers a corpus download -- every test in
tools/calibration/tests/test_run_calibration.py passes plain in-memory record
lists to run()/process_record() directly.

Usage:
  # start the sidecar container first (Plan 1), then:
  python tools/calibration/run_calibration.py --out tools/calibration/out/facebook.csv
  python tools/calibration/run_calibration.py --limit 20 --out tools/calibration/out/smoke.csv
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

from correlate import REQUIRED_COLUMNS
from record_transform import build_utterance_rows, error_row
from sidecar_client import SidecarError, call_assess, check_health, encode_wav

DATASET_ID = "mispeech/speechocean762"
DEFAULT_SPLIT = "test"


def iter_records(split: str = DEFAULT_SPLIT, limit: int | None = None):
    """Yield raw speechocean762 records. Imported lazily -- see module docstring."""
    import datasets  # noqa: PLC0415

    dataset = datasets.load_dataset(DATASET_ID, split=split)
    for index, record in enumerate(dataset):
        if limit is not None and index >= limit:
            return
        record = dict(record)
        record.setdefault("utt_id", f"{split}-{index:05d}")
        yield record


def process_record(model: str, base_url: str, record: dict, *, timeout: float = 60.0) -> list[dict]:
    """Score one utterance. Never raises: any failure becomes a single error_row
    so one bad utterance cannot abort a multi-hour corpus run."""
    utt_id = record["utt_id"]
    try:
        audio = record["audio"]
        wav_bytes = encode_wav(audio["array"], audio["sampling_rate"])
        report = call_assess(base_url, wav_bytes, record["text"], timeout=timeout)
        return build_utterance_rows(model, utt_id, record, report)
    except SidecarError as exc:
        return [error_row(model, utt_id, exc.code)]
    except ValueError:
        return [error_row(model, utt_id, "WORD_COUNT_MISMATCH")]
    except Exception:  # noqa: BLE001 -- a corpus run must survive one bad record
        return [error_row(model, utt_id, "INTERNAL")]


def write_rows(path: Path, rows, *, header: bool) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "w" if header else "a"
    with path.open(mode, newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(REQUIRED_COLUMNS))
        if header:
            writer.writeheader()
        for row in rows:
            writer.writerow(row)


def run(*, model: str, base_url: str, records, out_path, timeout: float = 60.0) -> dict:
    """Score every record, writing rows incrementally so a late failure does
    not lose everything scored so far. Returns a scored/failed/total summary."""
    scored = 0
    failed = 0
    for index, record in enumerate(records):
        rows = process_record(model, base_url, record, timeout=timeout)
        write_rows(out_path, rows, header=(index == 0))
        if any(row["level"] == "error" for row in rows):
            failed += 1
        else:
            scored += 1
    return {"scored": scored, "failed": failed, "total": scored + failed}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score speechocean762 with the local pronunciation sidecar."
    )
    parser.add_argument("--sidecar-url", default=os.environ.get("PRON_URL", "http://localhost:8899"))
    parser.add_argument("--split", default=DEFAULT_SPLIT)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model-label", default=None, help="defaults to /health's reported model id")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args(argv)

    try:
        health = check_health(args.sidecar_url, timeout=args.timeout)
    except SidecarError as exc:
        print(f"sidecar unreachable at {args.sidecar_url}: {exc.message}")
        return 1

    model = args.model_label or health.get("model", "unknown")
    records = iter_records(split=args.split, limit=args.limit)
    summary = run(model=model, base_url=args.sidecar_url, records=records, out_path=args.out, timeout=args.timeout)
    print(f"model={model} scored={summary['scored']} failed={summary['failed']} total={summary['total']}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
