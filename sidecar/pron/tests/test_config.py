"""Sidecar configuration — every default is frozen by interface contract section 7.2."""

import dataclasses

import pytest

from app.config import DEFAULT_MODEL_ID, SETTINGS, Settings, load_settings

ENV_KEYS = [
    "PRON_MODEL",
    "PRON_DEVICE",
    "PRON_ESPEAK_LANG",
    "PRON_GOP_TAU",
    "PRON_DETECT_GOP",
    "PRON_MAX_AUDIO_SEC",
    "PRON_HOST",
    "PRON_PORT",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_defaults_match_the_frozen_contract():
    settings = load_settings()
    assert settings.model_id == "facebook/wav2vec2-lv-60-espeak-cv-ft"
    assert settings.device == "cpu"
    assert settings.espeak_lang == "en-us"
    assert settings.gop_tau == 1.0
    assert settings.detect_gop == -5.0
    assert settings.max_audio_sec == 30.0
    assert settings.host == "0.0.0.0"
    assert settings.port == 8899
    assert DEFAULT_MODEL_ID == "facebook/wav2vec2-lv-60-espeak-cv-ft"


def test_every_field_can_be_overridden_from_the_environment(monkeypatch):
    monkeypatch.setenv("PRON_MODEL", "acme/other-phoneme-model")
    monkeypatch.setenv("PRON_DEVICE", "cuda")
    monkeypatch.setenv("PRON_ESPEAK_LANG", "en-gb")
    monkeypatch.setenv("PRON_GOP_TAU", "2.5")
    monkeypatch.setenv("PRON_DETECT_GOP", "-3.25")
    monkeypatch.setenv("PRON_MAX_AUDIO_SEC", "12")
    monkeypatch.setenv("PRON_HOST", "127.0.0.1")
    monkeypatch.setenv("PRON_PORT", "9100")

    settings = load_settings()

    assert settings.model_id == "acme/other-phoneme-model"
    assert settings.device == "cuda"
    assert settings.espeak_lang == "en-gb"
    assert settings.gop_tau == 2.5
    assert settings.detect_gop == -3.25
    assert settings.max_audio_sec == 12.0
    assert settings.host == "127.0.0.1"
    assert settings.port == 9100


def test_blank_and_unparsable_values_fall_back_to_the_defaults(monkeypatch):
    monkeypatch.setenv("PRON_MODEL", "   ")
    monkeypatch.setenv("PRON_GOP_TAU", "banana")
    monkeypatch.setenv("PRON_PORT", "")

    settings = load_settings()

    assert settings.model_id == DEFAULT_MODEL_ID
    assert settings.gop_tau == 1.0
    assert settings.port == 8899


def test_settings_is_frozen_so_no_request_can_mutate_global_config():
    settings = load_settings()
    with pytest.raises(dataclasses.FrozenInstanceError):
        settings.port = 1234  # type: ignore[misc]


def test_module_exposes_a_prebuilt_singleton():
    assert isinstance(SETTINGS, Settings)
    assert SETTINGS.port > 0
