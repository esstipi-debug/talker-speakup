"""Minimal HTTP client for the pronunciation sidecar (docs/.../pronunciation-1-sidecar.md).

The sidecar is a standalone FastAPI service reached over plain HTTP — this
module has no dependency on the Node server or any of its code.
"""

from __future__ import annotations

import io

import numpy as np
import requests
from scipy.io import wavfile


class SidecarError(Exception):
    """One HTTP call to the sidecar failed. `.code` mirrors the sidecar's own
    error codes (NO_SPEECH, DECODE_FAILED, ...) or a client-side code this
    module assigns itself (UNREACHABLE, INTERNAL) when the sidecar's body
    could not be parsed at all.
    """

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def encode_wav(samples, sample_rate: int) -> bytes:
    """Float32 samples in [-1, 1] -> 16-bit PCM WAV bytes.

    `samples`/`sample_rate` are the `record["audio"]["array"]` /
    `record["audio"]["sampling_rate"]` pair -- the shape HuggingFace
    datasets<4's Audio feature decodes to (see
    test_datasets_audio_contract.py -- this is a version-specific contract,
    not a stable API; datasets>=4 requires torchcodec and returns a decoder
    object instead of this dict, which is why requirements.txt pins <4).

    ffmpeg (inside the sidecar's audio.decode_to_16k_mono) resamples on the
    way in, so the native speechocean762 sample rate is written as-is.
    """
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (clipped * 32767).astype(np.int16)
    buffer = io.BytesIO()
    wavfile.write(buffer, sample_rate, pcm16)
    return buffer.getvalue()


def _error_from_response(response) -> SidecarError:
    try:
        body = response.json()
    except ValueError:
        return SidecarError("INTERNAL", response.text or "sidecar returned a non-JSON error", response.status_code)
    if not isinstance(body, dict):
        return SidecarError("INTERNAL", str(body), response.status_code)
    return SidecarError(
        body.get("code", "INTERNAL"),
        body.get("error", "sidecar returned an error with no message"),
        response.status_code,
    )


def call_assess(
    base_url: str,
    wav_bytes: bytes,
    text: str,
    *,
    mode: str = "scripted",
    timeout: float = 60.0,
) -> dict:
    """POST one utterance to `/assess`. Returns the parsed PronunciationReport.

    Raises SidecarError for both a sidecar-side failure (4xx/5xx with the
    frozen error body) and a client-side failure (connection refused, DNS,
    timeout) so callers have one exception type to catch.
    """
    try:
        response = requests.post(
            f"{base_url}/assess",
            files={"audio": ("utterance.wav", wav_bytes, "audio/wav")},
            data={"text": text, "mode": mode},
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise SidecarError("UNREACHABLE", f"could not reach {base_url}: {exc}", 0) from exc

    if response.status_code >= 400:
        raise _error_from_response(response)
    return response.json()


def check_health(base_url: str, *, timeout: float = 10.0) -> dict:
    """GET `/health`. Raises SidecarError only when the sidecar cannot be reached at all —
    `/health` itself always answers 200, even when degraded."""
    try:
        response = requests.get(f"{base_url}/health", timeout=timeout)
    except requests.RequestException as exc:
        raise SidecarError("UNREACHABLE", f"could not reach {base_url}: {exc}", 0) from exc
    if response.status_code >= 400:
        raise _error_from_response(response)
    return response.json()
