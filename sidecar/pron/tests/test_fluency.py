"""Fluency comes from an energy VAD over the decoded PCM, not from the CTC
alignment -- the alignment's 20 ms spans carry no pause information at all.
"""

import numpy as np
import pytest

from app.fluency import (
    Prosody,
    compute_prosody,
    find_pauses,
    fluency_score,
    frame_energy,
    voiced_mask,
)


def _signal(segments, sample_rate: int = 16000) -> np.ndarray:
    """segments: list of (seconds, amplitude)."""
    parts = []
    for seconds, amplitude in segments:
        count = int(seconds * sample_rate)
        t = np.arange(count) / sample_rate
        parts.append((amplitude * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32))
    return np.concatenate(parts).astype(np.float32)


def test_frame_energy_produces_one_rms_value_per_20ms_frame():
    energy = frame_energy(_signal([(1.0, 0.5)]))
    assert energy.shape == (50,)
    assert float(energy.mean()) == pytest.approx(0.3536, abs=0.02)  # RMS of a 0.5 sine


def test_voiced_mask_separates_tone_from_silence():
    mask = voiced_mask(frame_energy(_signal([(0.4, 0.5), (0.4, 0.0)])))
    assert bool(mask[:15].all()) is True
    assert bool(mask[-15:].any()) is False


def test_find_pauses_reports_one_internal_pause_with_its_span():
    mask = voiced_mask(frame_energy(_signal([(0.5, 0.5), (0.6, 0.0), (0.5, 0.5)])))
    pauses = find_pauses(mask)
    assert len(pauses) == 1
    start, end = pauses[0]
    assert start == pytest.approx(0.5, abs=0.06)
    assert end - start == pytest.approx(0.6, abs=0.08)


def test_find_pauses_ignores_leading_and_trailing_silence():
    mask = voiced_mask(frame_energy(_signal([(0.5, 0.0), (0.5, 0.5), (0.5, 0.0)])))
    assert find_pauses(mask) == []


def test_find_pauses_ignores_gaps_below_the_minimum():
    mask = voiced_mask(frame_energy(_signal([(0.4, 0.5), (0.1, 0.0), (0.4, 0.5)])))
    assert find_pauses(mask) == []


def test_compute_prosody_derives_rates_from_the_waveform():
    wav = _signal([(0.5, 0.5), (0.6, 0.0), (0.5, 0.5)])  # 1.6 s total, ~1.0 s voiced
    prosody = compute_prosody(wav, word_count=2, syllable_count=3)

    assert prosody.speech_rate_wpm == pytest.approx(75.0, abs=1.0)
    assert prosody.articulation_rate_syll_per_sec == pytest.approx(3.0, abs=0.4)
    assert prosody.pause_count == 1
    assert prosody.pause_total_sec == pytest.approx(0.6, abs=0.08)
    assert prosody.f0_min_hz is None
    assert prosody.f0_max_hz is None
    assert prosody.f0_range_semitones is None


def _prosody(pause_total_sec: float, rate: float) -> Prosody:
    return Prosody(
        speech_rate_wpm=120.0,
        articulation_rate_syll_per_sec=rate,
        pause_count=1,
        pause_total_sec=pause_total_sec,
        f0_min_hz=None,
        f0_max_hz=None,
        f0_range_semitones=None,
    )


def test_fluency_score_is_one_hundred_for_no_pauses_at_a_normal_rate():
    assert fluency_score(_prosody(0.0, 4.0)) == 100


def test_fluency_score_spends_the_whole_pause_budget():
    assert fluency_score(_prosody(1.5, 4.0)) == 40
    assert fluency_score(_prosody(9.0, 4.0)) == 40  # penalty is capped at 1.0


def test_fluency_score_penalises_speaking_too_slowly_and_too_fast():
    assert fluency_score(_prosody(0.0, 1.5)) == 80  # (3.0-1.5)/3.0 = 0.5 -> -20
    assert fluency_score(_prosody(0.0, 11.0)) == 60  # (11-5.5)/5.5 = 1.0 -> -40


def test_fluency_score_never_leaves_the_zero_to_one_hundred_range():
    assert 0 <= fluency_score(_prosody(99.0, 99.0)) <= 100
