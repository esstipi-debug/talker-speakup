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

import argparse
import csv
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

from scipy import stats

from arpabet_ipa import strip_stress

#: A model that cannot score this fraction of the corpus is disqualified before
#: correlation is even considered — a model that only scores the easy 40 % has a
#: flattering r for reasons that have nothing to do with quality.
PASS_MIN_COVERAGE = 0.80

#: Analogous to PASS_MIN_COVERAGE but at the phoneme level: a model whose alignment
#: only covers the easy fraction of phones has a flattering substitution/correlation
#: metric for the wrong reason (design section 10's "no false precision" principle).
PASS_MIN_PHONEME_COVERAGE = 0.80

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


def phoneme_coverage(rows: list[dict[str, str]], model: str) -> float:
    """Fraction of this model's phoneme-level rows that received an actual machine
    pairing (non-blank "machine"). 0.0 when there are no phoneme rows at all."""
    total = 0
    paired = 0
    for row in rows:
        if row["model"] != model or row["level"] != "phoneme":
            continue
        total += 1
        if row["machine"].strip():
            paired += 1
    return paired / total if total else 0.0


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


@dataclass(frozen=True)
class SubstitutionAgreement:
    """How well the machine's `substituted` field tracks the human labels.

    `f1` measures *detection* (did the machine flag the same phones the raters
    flagged). `identity_accuracy` measures whether, having flagged one, it named
    the right replacement — the part a learner actually reads.
    """

    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    identity_matches: int
    identity_accuracy: float
    unmapped_substitutions: int


def substitution_agreement(
    rows: list[dict[str, str]],
    model: str,
) -> SubstitutionAgreement:
    """Detection precision/recall/F1 plus identity accuracy over phoneme rows."""
    true_positives = 0
    false_positives = 0
    false_negatives = 0
    identity_matches = 0
    unmapped_substitutions = 0
    for row in rows:
        if row["model"] != model or row["level"] != "phoneme":
            continue
        human = row["human_sub"].strip()
        machine = row["machine_sub"].strip()
        if human and machine:
            true_positives += 1
            predicted = [
                phone for phone in row["machine_sub_arpabet"].split("+") if phone
            ]
            if not predicted:
                # An espeak `substituted` token IPA_TO_ARPABET does not know (e.g. a
                # tap "ɾ") -- a real detection, but a table gap, not a model error.
                # Excluded from the identity denominator below, not counted a miss.
                unmapped_substitutions += 1
            elif strip_stress(human) in predicted:
                identity_matches += 1
        elif machine:
            false_positives += 1
        elif human:
            false_negatives += 1

    precision = (
        true_positives / (true_positives + false_positives)
        if true_positives + false_positives
        else 0.0
    )
    recall = (
        true_positives / (true_positives + false_negatives)
        if true_positives + false_negatives
        else 0.0
    )
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    identity_denominator = true_positives - unmapped_substitutions
    identity_accuracy = identity_matches / identity_denominator if identity_denominator else 0.0
    return SubstitutionAgreement(
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=round(precision, 6),
        recall=round(recall, 6),
        f1=round(f1, 6),
        identity_matches=identity_matches,
        identity_accuracy=round(identity_accuracy, 6),
        unmapped_substitutions=unmapped_substitutions,
    )


#: Only these two verdicts are selectable, best first.
VERDICT_RANK = {"PASS": 0, "SUBSTITUTIONS_ONLY": 1}


@dataclass(frozen=True)
class ModelVerdict:
    """The calibration answer for one acoustic model."""

    model: str
    coverage: float
    phoneme_coverage: float
    levels: dict[str, Correlation]
    substitutions: SubstitutionAgreement
    verdict: str
    show_numeric_scores: bool
    reasons: tuple[str, ...]


def judge(rows: list[dict[str, str]], model: str) -> ModelVerdict:
    """Apply the documented thresholds to one model's rows.

    Order matters: coverage first (a model that only scored the easy third of
    the corpus has a flattering r for the wrong reason), then the two
    correlation gates, then the design §10 substitutions-only fallback.
    """
    model_coverage = round(coverage(rows, model), 6)
    model_phoneme_coverage = round(phoneme_coverage(rows, model), 6)
    levels: dict[str, Correlation] = {}
    for level in sorted(
        {row["level"] for row in rows if row["model"] == model and row["level"] != "error"}
    ):
        human, machine = pairs(rows, model, level)
        levels[level] = correlate(human, machine)
    subs = substitution_agreement(rows, model)

    reasons: list[str] = []
    if model_coverage < PASS_MIN_COVERAGE:
        reasons.append(
            f"coverage {model_coverage:.2f} < {PASS_MIN_COVERAGE:.2f} — not enough of the corpus scored"
        )
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            phoneme_coverage=model_phoneme_coverage,
            levels=levels,
            substitutions=subs,
            verdict="DISQUALIFIED",
            show_numeric_scores=False,
            reasons=tuple(reasons),
        )

    if model_phoneme_coverage < PASS_MIN_PHONEME_COVERAGE:
        reasons.append(
            f"phoneme coverage {model_phoneme_coverage:.2f} < {PASS_MIN_PHONEME_COVERAGE:.2f} "
            "— too many phones went unaligned to trust substitution/phoneme metrics"
        )
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            phoneme_coverage=model_phoneme_coverage,
            levels=levels,
            substitutions=subs,
            verdict="DISQUALIFIED",
            show_numeric_scores=False,
            reasons=tuple(reasons),
        )

    passed = True
    utterance = levels.get("utterance")
    if utterance is None or utterance.n < MIN_SAMPLES:
        passed = False
        reasons.append(
            f"utterance samples {0 if utterance is None else utterance.n} < {MIN_SAMPLES}"
        )
    elif not utterance.pearson_r >= PASS_MIN_UTTERANCE_PEARSON:
        passed = False
        reasons.append(
            f"utterance pearson r {utterance.pearson_r} < {PASS_MIN_UTTERANCE_PEARSON}"
        )

    phoneme = levels.get("phoneme")
    if phoneme is None or phoneme.n < MIN_SAMPLES:
        passed = False
        reasons.append(f"phoneme samples {0 if phoneme is None else phoneme.n} < {MIN_SAMPLES}")
    elif not phoneme.spearman_rho >= PASS_MIN_PHONEME_SPEARMAN:
        passed = False
        reasons.append(
            f"phoneme spearman rho {phoneme.spearman_rho} < {PASS_MIN_PHONEME_SPEARMAN}"
        )

    if passed:
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            phoneme_coverage=model_phoneme_coverage,
            levels=levels,
            substitutions=subs,
            verdict="PASS",
            show_numeric_scores=True,
            reasons=("every threshold met",),
        )

    if subs.f1 >= FALLBACK_MIN_SUBSTITUTION_F1:
        reasons.append(
            f"substitution F1 {subs.f1} >= {FALLBACK_MIN_SUBSTITUTION_F1} — design §10 fallback: "
            "report substitutions, hide numeric scores"
        )
        return ModelVerdict(
            model=model,
            coverage=model_coverage,
            phoneme_coverage=model_phoneme_coverage,
            levels=levels,
            substitutions=subs,
            verdict="SUBSTITUTIONS_ONLY",
            show_numeric_scores=False,
            reasons=tuple(reasons),
        )

    reasons.append(f"substitution F1 {subs.f1} < {FALLBACK_MIN_SUBSTITUTION_F1}")
    return ModelVerdict(
        model=model,
        coverage=model_coverage,
        phoneme_coverage=model_phoneme_coverage,
        levels=levels,
        substitutions=subs,
        verdict="FAIL",
        show_numeric_scores=False,
        reasons=tuple(reasons),
    )


def select_model(verdicts: list[ModelVerdict]) -> ModelVerdict | None:
    """The best selectable model, or None when every candidate is unusable.

    PASS beats SUBSTITUTIONS_ONLY; within a tier the stronger utterance-level
    Pearson wins; the model label breaks remaining ties so the choice is
    reproducible.
    """
    eligible = [verdict for verdict in verdicts if verdict.verdict in VERDICT_RANK]
    if not eligible:
        return None

    def sort_key(verdict: ModelVerdict) -> tuple[int, float, str]:
        utterance = verdict.levels.get("utterance")
        r = utterance.pearson_r if utterance is not None else float("nan")
        if math.isnan(r):
            r = -2.0
        return (VERDICT_RANK[verdict.verdict], -r, verdict.model)

    return sorted(eligible, key=sort_key)[0]


def _jsonable(value):
    """Recursively replace non-finite floats with None so json.dumps stays strict."""
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def verdict_to_dict(verdict: ModelVerdict) -> dict:
    """JSON-safe view of a ModelVerdict (NaN correlations become null)."""
    return _jsonable(asdict(verdict))


def format_report(verdicts: list[ModelVerdict]) -> str:
    """Human-readable calibration report, one block per model."""
    lines: list[str] = []
    for verdict in verdicts:
        lines.append(f"=== {verdict.model} — {verdict.verdict} ===")
        lines.append(
            f"  coverage {verdict.coverage:.3f}"
            f"   phoneme coverage {verdict.phoneme_coverage:.3f}"
            f"   numeric scores: {'show' if verdict.show_numeric_scores else 'HIDE'}"
        )
        for level in sorted(verdict.levels):
            correlation = verdict.levels[level]
            lines.append(
                f"  {level:<13} n={correlation.n:<6}"
                f" pearson r={correlation.pearson_r:.3f} (p={correlation.pearson_p:.4f})"
                f" spearman rho={correlation.spearman_rho:.3f} (p={correlation.spearman_p:.4f})"
            )
        subs = verdict.substitutions
        lines.append(
            f"  substitutions  tp={subs.true_positives} fp={subs.false_positives}"
            f" fn={subs.false_negatives} f1={subs.f1:.3f}"
            f" identity={subs.identity_accuracy:.3f}"
            f" unmapped={subs.unmapped_substitutions}"
        )
        for reason in verdict.reasons:
            lines.append(f"  - {reason}")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Exit 0 when a model was selected, 1 when none was."""
    parser = argparse.ArgumentParser(
        description="Correlate sidecar pronunciation scores against speechocean762 human scores."
    )
    parser.add_argument(
        "csv_paths",
        nargs="+",
        type=Path,
        help="one or more score CSVs written by run_calibration.py",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="verdict JSON path (default: verdict.json beside the first CSV)",
    )
    args = parser.parse_args(argv)

    rows: list[dict[str, str]] = []
    for path in args.csv_paths:
        rows.extend(load_rows(path))

    verdicts = [judge(rows, model) for model in models(rows)]
    chosen = select_model(verdicts)

    print(format_report(verdicts))
    print(f"SELECTED: {chosen.model if chosen else 'none'}")

    out = args.out or args.csv_paths[0].with_name("verdict.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "selected": chosen.model if chosen else None,
        "showNumericScores": bool(chosen and chosen.show_numeric_scores),
        "thresholds": {
            "passMinCoverage": PASS_MIN_COVERAGE,
            "passMinUtterancePearson": PASS_MIN_UTTERANCE_PEARSON,
            "passMinPhonemeSpearman": PASS_MIN_PHONEME_SPEARMAN,
            "fallbackMinSubstitutionF1": FALLBACK_MIN_SUBSTITUTION_F1,
            "minSamples": MIN_SAMPLES,
        },
        "models": [verdict_to_dict(verdict) for verdict in verdicts],
    }
    out.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return 0 if chosen else 1


if __name__ == "__main__":
    raise SystemExit(main())
