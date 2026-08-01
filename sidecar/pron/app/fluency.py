"""Energy VAD -> pauses, rates, fluency.

The CTC alignment cannot supply any of this: every span it produces is a ~20 ms
onset spike, so pauses and articulation rate are measured directly from the
decoded PCM.

f0_* are None in Stage 1 and are emitted as JSON null. They exist in the frozen
schema today so Stage 2's pitch tracker needs no schema migration -- and that
tracker's API has NOT been verified, so nothing pitch-related is implemented here.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Prosody:
    speech_rate_wpm: float
    articulation_rate_syll_per_sec: float
    pause_count: int
    pause_total_sec: float
    f0_min_hz: float | None
    f0_max_hz: float | None
    f0_range_semitones: float | None


def frame_energy(wav: np.ndarray, *, frame_ms: float = 20.0, sample_rate: int = 16000) -> np.ndarray:
    size = max(1, int(sample_rate * frame_ms / 1000.0))
    count = len(wav) // size
    if count == 0:
        return np.zeros(0, dtype=np.float32)
    frames = np.asarray(wav[: count * size], dtype=np.float32).reshape(count, size)
    return np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1)).astype(np.float32)


def voiced_mask(energy: np.ndarray, *, rel_threshold: float = 0.15) -> np.ndarray:
    if energy.size == 0:
        return np.zeros(0, dtype=bool)
    reference = float(np.percentile(energy, 95))
    if reference <= 0.0:
        return np.zeros(energy.size, dtype=bool)
    return energy > (rel_threshold * reference)


def find_pauses(
    mask: np.ndarray, *, frame_ms: float = 20.0, min_pause_ms: float = 250.0
) -> list[tuple[float, float]]:
    if mask.size == 0 or not mask.any():
        return []

    voiced = np.flatnonzero(mask)
    first, last = int(voiced[0]), int(voiced[-1])
    seconds_per_frame = frame_ms / 1000.0
    min_frames = max(1, int(round(min_pause_ms / frame_ms)))

    pauses: list[tuple[float, float]] = []
    run_start: int | None = None
    for index in range(first, last + 1):
        if not mask[index]:
            if run_start is None:
                run_start = index
            continue
        if run_start is not None:
            if index - run_start >= min_frames:
                pauses.append(
                    (
                        round(run_start * seconds_per_frame, 3),
                        round(index * seconds_per_frame, 3),
                    )
                )
            run_start = None
    return pauses


def compute_prosody(
    wav: np.ndarray, *, word_count: int, syllable_count: int, sample_rate: int = 16000
) -> Prosody:
    energy = frame_energy(wav, sample_rate=sample_rate)
    mask = voiced_mask(energy)
    pauses = find_pauses(mask)

    voiced_seconds = float(mask.sum()) * 0.02
    total_seconds = float(len(wav)) / sample_rate
    pause_total = sum(end - start for start, end in pauses)

    return Prosody(
        speech_rate_wpm=round(word_count / max(total_seconds, 1e-6) * 60.0, 3),
        articulation_rate_syll_per_sec=round(syllable_count / max(voiced_seconds, 1e-6), 3),
        pause_count=len(pauses),
        pause_total_sec=round(pause_total, 3),
        f0_min_hz=None,
        f0_max_hz=None,
        f0_range_semitones=None,
    )


def fluency_score(
    prosody: Prosody, *, pause_budget_sec: float = 1.5, rate_lo: float = 3.0, rate_hi: float = 5.5
) -> int:
    pause_penalty = min(1.0, prosody.pause_total_sec / pause_budget_sec)

    rate = prosody.articulation_rate_syll_per_sec
    if rate < rate_lo:
        rate_penalty = min(1.0, (rate_lo - rate) / rate_lo)
    elif rate > rate_hi:
        rate_penalty = min(1.0, (rate - rate_hi) / rate_hi)
    else:
        rate_penalty = 0.0

    score = round(100 * (1 - 0.6 * pause_penalty - 0.4 * rate_penalty))
    return max(0, min(100, score))
