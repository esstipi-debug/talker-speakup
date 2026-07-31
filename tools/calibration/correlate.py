"""Correlation + model-selection report for the pronunciation calibration harness.

Reads the CSV written by run_calibration.py and answers one question per
acoustic model: are its numeric scores trustworthy enough to show a learner?

Verdicts (see README, "Pass/fail thresholds"):
  PASS                -> ship numeric scores
  SUBSTITUTIONS_ONLY  -> design §10 fallback: report `substituted`, hide numbers
  FAIL                -> the model is not usable
  DISQUALIFIED        -> the model could not score enough of the corpus

Usage:
  python tools/calibration/correlate.py tools/calibration/out/scores.csv
  python tools/calibration/correlate.py out/facebook.csv out/mrrubino.csv
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path

from scipy import stats

#: A model that cannot score this fraction of the corpus is disqualified before
#: correlation is even considered — a model that only scores the easy 40 % has a
#: flattering r for reasons that have nothing to do with quality.
PASS_MIN_COVERAGE = 0.80

#: Utterance-level Pearson r required to show numeric scores to a learner.
PASS_MIN_UTTERANCE_PEARSON = 0.60

#: Phoneme-level Spearman rho required alongside it. Deliberately lower:
#: per-phone human labels are a 3-point scale averaged over 5 raters, so the
#: ceiling on any phoneme-level correlation is far below the utterance ceiling.
PASS_MIN_PHONEME_SPEARMAN = 0.35

#: design §10 fallback gate. Below this the substitutions are noise too.
FALLBACK_MIN_SUBSTITUTION_F1 = 0.30

#: Fewer pairs than this and the correlation is not evidence of anything.
MIN_SAMPLES = 30


@dataclass(frozen=True)
class Correlation:
    """Pearson and Spearman for one (human, machine) score population."""

    n: int
    pearson_r: float
    pearson_p: float
    spearman_rho: float
    spearman_p: float


def _nan_correlation(n: int) -> Correlation:
    nan = float("nan")
    return Correlation(n=n, pearson_r=nan, pearson_p=nan, spearman_rho=nan, spearman_p=nan)


def correlate(xs: list[float], ys: list[float]) -> Correlation:
    """Pearson + Spearman over paired scores.

    Returns NaN correlations (never raises) when there are fewer than three
    pairs or either series is constant — both happen on small or degenerate
    slices and must not abort a whole calibration report.
    """
    if len(xs) != len(ys):
        raise ValueError("xs and ys must be the same length")
    n = len(xs)
    if n < 3 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return _nan_correlation(n)
    pearson = stats.pearsonr(xs, ys)
    spearman = stats.spearmanr(xs, ys)
    return Correlation(
        n=n,
        pearson_r=round(float(pearson[0]), 6),
        pearson_p=round(float(pearson[1]), 6),
        spearman_rho=round(float(spearman[0]), 6),
        spearman_p=round(float(spearman[1]), 6),
    )


#: Columns run_calibration.py writes and this module reads. A CSV that lacks any
#: of them is rejected loudly — a silently-missing column would just produce an
#: empty, plausible-looking report.
REQUIRED_COLUMNS = (
    "model",
    "level",
    "utt_id",
    "word_index",
    "phone_index",
    "ipa",
    "arpabet",
    "human",
    "machine",
    "human_sub",
    "machine_sub",
    "machine_sub_arpabet",
    "error_code",
)


def load_rows(path: Path) -> list[dict[str, str]]:
    """Read one score CSV. Raises ValueError when a required column is absent."""
    with Path(path).open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        for column in REQUIRED_COLUMNS:
            if column not in header:
                raise ValueError(f"{path}: missing column {column!r}")
        return [dict(row) for row in reader]


def models(rows: list[dict[str, str]]) -> list[str]:
    """Every model label present in the rows, sorted for a stable report."""
    return sorted({row["model"] for row in rows if row["model"]})


def coverage(rows: list[dict[str, str]], model: str) -> float:
    """Scored utterances / attempted utterances for one model, 0.0 when none."""
    scored = 0
    failed = 0
    for row in rows:
        if row["model"] != model:
            continue
        if row["level"] == "utterance" and row["machine"].strip():
            scored += 1
        elif row["level"] == "error":
            failed += 1
    attempted = scored + failed
    return scored / attempted if attempted else 0.0


def pairs(
    rows: list[dict[str, str]],
    model: str,
    level: str,
) -> tuple[list[float], list[float]]:
    """(human, machine) score series for one model at one level."""
    human: list[float] = []
    machine: list[float] = []
    for row in rows:
        if row["model"] != model or row["level"] != level:
            continue
        if not row["human"].strip() or not row["machine"].strip():
            continue
        human.append(float(row["human"]))
        machine.append(float(row["machine"]))
    return human, machine
