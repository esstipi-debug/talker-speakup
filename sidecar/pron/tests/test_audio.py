"""ffmpeg decode. Verified by execution during recon: raw s16le on stdout is
correct; `-f wav` to a pipe yields a corrupt RIFF header, so we never do that.
"""

import io
import math
import struct
import wave

import numpy as np
import pytest

from app.audio import decode_to_16k_mono, duration_seconds, is_silent
from app.errors import PronError


def _wav_bytes(seconds: float = 0.5, sample_rate: int = 44100, channels: int = 2, freq: float = 440.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        frames = bytearray()
        for i in range(int(sample_rate * seconds)):
            value = int(20000 * math.sin(2 * math.pi * freq * i / sample_rate))
            for _ in range(channels):
                frames += struct.pack("<h", value)
        handle.writeframes(bytes(frames))
    return buf.getvalue()


def test_decode_returns_mono_float32_at_16k():
    wav = decode_to_16k_mono(_wav_bytes(seconds=0.5))
    assert wav.dtype == np.float32
    assert wav.ndim == 1
    assert 7900 <= wav.size <= 8100  # 0.5 s at 16 kHz
    assert 0.5 < float(np.abs(wav).max()) < 0.7  # 20000/32768 == 0.61


def test_decode_respects_the_max_seconds_cap():
    wav = decode_to_16k_mono(_wav_bytes(seconds=2.0), max_seconds=0.5)
    assert wav.size <= 9000


def test_decode_raises_decode_failed_on_garbage_bytes():
    with pytest.raises(PronError) as excinfo:
        decode_to_16k_mono(b"this is not audio, it is a sentence about audio")
    assert excinfo.value.code == "DECODE_FAILED"
    assert excinfo.value.status == 400


def test_decode_raises_decode_failed_on_empty_input():
    with pytest.raises(PronError) as excinfo:
        decode_to_16k_mono(b"")
    assert excinfo.value.code == "DECODE_FAILED"


def test_duration_seconds_is_sample_count_over_rate():
    assert duration_seconds(np.zeros(8000, dtype=np.float32)) == 0.5
    assert duration_seconds(np.zeros(24000, dtype=np.float32)) == 1.5


def test_is_silent_distinguishes_digital_silence_from_speech():
    assert is_silent(np.zeros(16000, dtype=np.float32)) is True
    assert is_silent(decode_to_16k_mono(_wav_bytes(seconds=0.3))) is False
