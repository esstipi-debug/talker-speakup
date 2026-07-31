"""Container-agnostic audio decode.

ffmpeg reads whatever the browser produced (webm/opus, mp4/aac, ogg) from stdin
and writes headerless little-endian s16 PCM to stdout. Raw s16le -- never
`-f wav` to a pipe: ffmpeg cannot seek back to patch the RIFF size field, so the
header claims 2147483647 frames and every reader misreports the length.
"""

from __future__ import annotations

import subprocess

import numpy as np

from .errors import PronError

FFMPEG_BIN = "ffmpeg"
_DECODE_FAILED_MESSAGE = "Couldn't read that recording. Try recording it again."


def decode_to_16k_mono(
    raw: bytes,
    *,
    max_seconds: float = 30.0,
    sample_rate: int = 16000,
    timeout: float = 20.0,
) -> np.ndarray:
    if not raw:
        raise PronError("DECODE_FAILED", _DECODE_FAILED_MESSAGE, status=400)

    cmd = [
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        "pipe:0",
        "-t",
        f"{max_seconds:g}",
        "-vn",
        "-dn",
        "-sn",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "pipe:1",
    ]

    try:
        proc = subprocess.run(
            cmd,
            input=raw,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except FileNotFoundError as exc:  # ffmpeg not installed in the image
        raise PronError(
            "MODEL_UNAVAILABLE",
            "Audio decoding is unavailable on the server (ffmpeg is missing).",
            status=503,
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise PronError("DECODE_FAILED", "That recording took too long to decode.", status=400) from exc

    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace").strip()[:200]
        raise PronError("DECODE_FAILED", f"{_DECODE_FAILED_MESSAGE} ({detail})", status=400)

    return np.frombuffer(proc.stdout, dtype="<i2").astype(np.float32) / 32768.0


def duration_seconds(wav: np.ndarray, sample_rate: int = 16000) -> float:
    return round(float(len(wav)) / sample_rate, 3)


def is_silent(wav: np.ndarray, *, rms_threshold: float = 0.005) -> bool:
    if wav.size == 0:
        return True
    rms = float(np.sqrt(np.mean(np.square(wav, dtype=np.float64))))
    return rms < rms_threshold
