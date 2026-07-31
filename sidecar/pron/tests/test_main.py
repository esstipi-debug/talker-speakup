"""HTTP contract of the sidecar (interface contract sections 4.3 and 4.4).

The pipeline itself is monkeypatched here: this file asserts the wire shape,
status codes and error codes. The real pipeline is exercised by the golden
integration test at the bottom of this file.
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.errors import PronError

FIXTURES = Path(__file__).parent / "fixtures"

CANNED_REPORT = {
    "version": 1,
    "mode": "scripted",
    "model": "facebook/wav2vec2-lv-60-espeak-cv-ft",
    "durationSec": 0.66,
    "sampleRate": 16000,
    "overall": {"accuracy": 67, "fluency": 84, "completeness": 100},
    "prosody": {
        "speechRateWpm": 132.5,
        "articulationRateSyllPerSec": 4.2,
        "pauseCount": 1,
        "pauseTotalSec": 0.31,
        "f0MinHz": None,
        "f0MaxHz": None,
        "f0RangeSemitones": None,
    },
    "words": [
        {
            "word": "sheep",
            "start": 0.0,
            "end": 0.66,
            "accuracy": 59,
            "phones": [{"ipa": "ʃ", "score": 90, "start": 0.0, "end": 0.66}],
        }
    ],
}


@pytest.fixture
def client():
    return TestClient(main_module.app)


def _files(payload: bytes = b"fake-audio-bytes"):
    return {"audio": ("drill.webm", payload, "audio/webm")}


def test_assess_returns_the_pipeline_report(client, monkeypatch):
    seen = {}

    def fake_pipeline(raw, text, mode):
        seen["raw"] = raw
        seen["text"] = text
        seen["mode"] = mode
        return CANNED_REPORT

    monkeypatch.setattr(main_module, "run_pipeline", fake_pipeline)

    response = client.post("/assess", files=_files(), data={"text": "  The ship  ", "mode": "scripted"})

    assert response.status_code == 200
    assert response.json() == CANNED_REPORT
    assert seen["raw"] == b"fake-audio-bytes"
    assert seen["text"] == "The ship"  # trimmed before it reaches the pipeline
    assert seen["mode"] == "scripted"


def test_assess_defaults_to_scripted_mode(client, monkeypatch):
    seen = {}

    def fake_pipeline(raw, text, mode):
        seen["mode"] = mode
        return CANNED_REPORT

    monkeypatch.setattr(main_module, "run_pipeline", fake_pipeline)

    response = client.post("/assess", files=_files(), data={"text": "the ship"})

    assert response.status_code == 200
    assert seen["mode"] == "scripted"


def test_assess_rejects_blank_text(client, monkeypatch):
    monkeypatch.setattr(main_module, "run_pipeline", lambda *a: CANNED_REPORT)
    response = client.post("/assess", files=_files(), data={"text": "   "})
    assert response.status_code == 400
    assert response.json() == {
        "error": 'Missing "text" (the reference sentence, non-empty string).',
        "code": "MISSING_TEXT",
    }


def test_assess_rejects_a_missing_text_part_with_the_frozen_body_not_fastapi_detail(client):
    response = client.post("/assess", files=_files())
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "MISSING_TEXT"
    assert "detail" not in body


def test_assess_rejects_text_over_300_characters(client, monkeypatch):
    monkeypatch.setattr(main_module, "run_pipeline", lambda *a: CANNED_REPORT)
    response = client.post("/assess", files=_files(), data={"text": "a" * 301})
    assert response.status_code == 400
    assert response.json()["code"] == "TEXT_TOO_LONG"


def test_assess_rejects_an_unknown_mode(client, monkeypatch):
    monkeypatch.setattr(main_module, "run_pipeline", lambda *a: CANNED_REPORT)
    response = client.post("/assess", files=_files(), data={"text": "hi", "mode": "freestyle"})
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_MODE"


def test_assess_rejects_an_empty_upload(client, monkeypatch):
    monkeypatch.setattr(main_module, "run_pipeline", lambda *a: CANNED_REPORT)
    response = client.post("/assess", files=_files(b""), data={"text": "hi"})
    assert response.status_code == 400
    assert response.json() == {"error": 'Missing "audio" file.', "code": "MISSING_AUDIO"}


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("NO_SPEECH", 422),
        ("DECODE_FAILED", 400),
        ("UNPRONOUNCEABLE_TEXT", 400),
        ("MODEL_UNAVAILABLE", 503),
    ],
)
def test_pipeline_pron_errors_surface_with_their_status_and_code(client, monkeypatch, code, status):
    def boom(raw, text, mode):
        raise PronError(code, "Nope.", status=status)

    monkeypatch.setattr(main_module, "run_pipeline", boom)
    response = client.post("/assess", files=_files(), data={"text": "hi"})
    assert response.status_code == status
    assert response.json() == {"error": "Nope.", "code": code}


def test_an_unexpected_pipeline_crash_becomes_a_500_internal(client, monkeypatch):
    def boom(raw, text, mode):
        raise ZeroDivisionError("torch went sideways")

    monkeypatch.setattr(main_module, "run_pipeline", boom)
    response = client.post("/assess", files=_files(), data={"text": "hi"})
    assert response.status_code == 500
    assert response.json()["code"] == "INTERNAL"
    assert "torch went sideways" not in response.json()["error"]


def test_health_reports_every_capability_flag(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "status",
        "model",
        "modelLoaded",
        "alignAvailable",
        "espeakAvailable",
        "ffmpegAvailable",
        "ts",
    }
    assert body["status"] in {"ok", "degraded"}
    assert body["model"] == "facebook/wav2vec2-lv-60-espeak-cv-ft"
    assert isinstance(body["ts"], int)
    assert isinstance(body["alignAvailable"], bool)


def test_health_is_200_even_when_degraded(client, monkeypatch):
    monkeypatch.setattr(main_module.acoustic, "align_available", lambda: False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "degraded"
