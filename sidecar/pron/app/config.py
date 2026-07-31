"""Sidecar configuration.

Single source of truth for every sidecar default (frozen interface contract
section 7.2). Reading env vars anywhere else in `app/` is a bug: import
SETTINGS instead. Unparsable values fall back to the default rather than
crashing the container at boot -- a typo'd PRON_GOP_TAU must not take the
drill offline.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_MODEL_ID = "facebook/wav2vec2-lv-60-espeak-cv-ft"


@dataclass(frozen=True)
class Settings:
    model_id: str
    device: str
    espeak_lang: str
    gop_tau: float
    detect_gop: float
    max_audio_sec: float
    host: str
    port: int


def _env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip()


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def load_settings() -> Settings:
    return Settings(
        model_id=_env_str("PRON_MODEL", DEFAULT_MODEL_ID),
        device=_env_str("PRON_DEVICE", "cpu"),
        espeak_lang=_env_str("PRON_ESPEAK_LANG", "en-us"),
        gop_tau=_env_float("PRON_GOP_TAU", 1.0),
        detect_gop=_env_float("PRON_DETECT_GOP", -5.0),
        max_audio_sec=_env_float("PRON_MAX_AUDIO_SEC", 30.0),
        host=_env_str("PRON_HOST", "0.0.0.0"),
        port=_env_int("PRON_PORT", 8899),
    )


SETTINGS: Settings = load_settings()
