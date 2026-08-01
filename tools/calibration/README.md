# Pronunciation calibration harness

Measures whether the local sidecar's scores agree with human raters on
**speechocean762** (5,000 non-native English utterances, 5 human raters per
utterance). This is the deliverable design section 8 calls "what makes the
numbers defensible" — until it has actually been run against a live sidecar,
treat any pronunciation score in the product as unverified.

## Status: code complete, not yet run against a live sidecar

The sidecar (`docs/superpowers/plans/2026-07-27-pronunciation-1-sidecar.md`)
has never been built or started in this environment — its own Task 4 (Docker
image) and Tasks 13-14 (run it, golden-fixture integration test) are deferred
pending Docker Desktop. Every module except `iter_records` is unit-tested
against mocked HTTP calls and fake in-memory records (no network, no corpus
download in any test); `iter_records` (the corpus loader in
`run_calibration.py`) is untested and unexercised by this test suite — it is
the one seam a first real run will validate, and the one that broke silently
once already (see `tests/test_datasets_audio_contract.py`, which pins the
`datasets` library's Audio-decode contract without ever downloading the real
corpus). Do not read "the tests pass" as "the model is calibrated" — those
are different claims.

speechocean762's human ratings and the sidecar's scores use deliberately
different numeric scales: utterance accuracy is rated roughly 0-10 and phone
accuracy roughly 0-2 by human raters, while the sidecar reports 0-100. This is
safe because `correlate.py` only ever computes rank/linear correlation
(Pearson/Spearman) between the two series — never a difference or ratio
between a human score and a sidecar score.

## One-time setup

```powershell
cd C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e
python -m venv tools/calibration/.venv
tools/calibration/.venv/Scripts/python.exe -m pip install --upgrade pip
tools/calibration/.venv/Scripts/python.exe -m pip install -r tools/calibration/requirements.txt
```

What actually resolved (from `pip freeze` after installing the pinned `datasets<4` series --
`datasets` 4.x requires the optional `torchcodec` package to decode audio at all, and even with
it installed returns a decoder object instead of the `{"array", "sampling_rate"}` dict shape
`run_calibration.process_record()` assumes; see `tests/test_datasets_audio_contract.py`.
`librosa` and `soundfile` are listed separately because `datasets<4`'s Audio feature
unconditionally imports both to decode, even though pip treats them as an optional extra):

```
datasets==3.6.0
librosa==0.11.0
numpy==2.4.6
pytest==9.1.1
requests==2.34.2
scipy==1.17.1
soundfile==0.14.0
```

(`pandas` is pulled in transitively by `datasets` itself but is not a direct dependency of any
module in this package — nothing here imports it.)

## Running it (once the sidecar container exists and is running on :8899)

```powershell
# 1. Start the sidecar (Plan 1) with whichever candidate model you're evaluating:
#      docker run --rm -d --name speakup-pron -p 8899:8899 -e PRON_MODEL=<model-id> speakup-pron
# 2. Smoke-test with a handful of utterances first -- a full run over 2,500 is slow:
tools/calibration/.venv/Scripts/python.exe tools/calibration/run_calibration.py --limit 20 --out tools/calibration/out/smoke.csv
# 3. Full run:
tools/calibration/.venv/Scripts/python.exe tools/calibration/run_calibration.py --out tools/calibration/out/facebook.csv
# 4. Repeat 1-3 with a second candidate model (a different --model-label or, more simply,
#    let it default to whatever /health reports for the currently-running container):
tools/calibration/.venv/Scripts/python.exe tools/calibration/run_calibration.py --out tools/calibration/out/candidate-b.csv
# 5. Compare and select:
tools/calibration/.venv/Scripts/python.exe tools/calibration/correlate.py tools/calibration/out/facebook.csv tools/calibration/out/candidate-b.csv --out tools/calibration/out/verdict.json
```

`verdict.json`'s `selected` field is the model to put in `PRON_MODEL`; `showNumericScores` says
whether the product may display numbers at all (design section 10's honest fallback — when false,
the client reports `substituted` phonemes and hides scores instead).

## Pass/fail thresholds (see `correlate.py`)

| Constant | Value | Meaning |
|---|---|---|
| `PASS_MIN_COVERAGE` | 0.80 | below this, the model is `DISQUALIFIED` before correlation is even considered |
| `PASS_MIN_UTTERANCE_PEARSON` | 0.60 | utterance-level linear agreement required to show numeric scores |
| `PASS_MIN_PHONEME_SPEARMAN` | 0.35 | phoneme-level rank agreement required alongside it (lower ceiling: 3-point human labels averaged over 5 raters) |
| `FALLBACK_MIN_SUBSTITUTION_F1` | 0.30 | below this even the substitutions-only fallback is not honest |
| `MIN_SAMPLES` | 30 | fewer pairs than this is not evidence of anything |

## Module map

| File | Job |
|---|---|
| `sidecar_client.py` | HTTP client to the sidecar's `/assess` and `/health` — WAV encoding, typed errors |
| `arpabet_ipa.py` | ARPAbet (speechocean762) <-> espeak IPA (sidecar) mapping and sequence alignment |
| `record_transform.py` | One speechocean762 record + one sidecar report -> CSV rows |
| `run_calibration.py` | The corpus loop: iterate speechocean762, call the sidecar, write the CSV |
| `correlate.py` | Read the CSV, compute correlation, apply the pass/fail/fallback thresholds, select a model |
