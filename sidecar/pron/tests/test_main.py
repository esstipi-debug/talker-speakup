"""HTTP contract of the sidecar (interface contract sections 4.3 and 4.4).

Most of this file monkeypatches `run_pipeline` wholesale and asserts the wire
shape, status codes and error codes -- request validation, error mapping,
/health. Those tests never execute the pipeline's own body.

The `run_pipeline` direct-call tests near the bottom of this file are the
complement: they call `main.run_pipeline(...)` itself (not through the HTTP
client) and monkeypatch each of its dependencies individually, so the two
behaviors the wire-shape tests can't see -- the silence gate short-circuiting
before G2P/acoustic/align/gop/fluency run, and `strip_phones` firing only in
"unscripted" mode -- are actually exercised rather than correct "by
inspection" only.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.errors import PronError

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


def test_assess_accepts_text_at_exactly_the_max_length(client, monkeypatch):
    # Boundary-accept counterpart to the 301-char rejection above: a `>` -> `>=`
    # mutation in the length check would reject this and pass undetected without it.
    monkeypatch.setattr(main_module, "run_pipeline", lambda *a: CANNED_REPORT)
    response = client.post(
        "/assess", files=_files(), data={"text": "a" * main_module.MAX_TEXT_LENGTH}
    )
    assert response.status_code == 200


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


# --- Direct run_pipeline unit tests -----------------------------------------
#
# Everything above calls the HTTP client with run_pipeline monkeypatched
# wholesale, so it never runs the pipeline's own body. These tests call
# main.run_pipeline(...) directly and monkeypatch each of ITS dependencies
# individually (the module-level functions it imports as audio_mod, g2p,
# acoustic, align_mod, gop_mod, fluency_mod, report_mod) so the function can
# run to completion without real audio decoding, a real model, or real
# espeak-ng.


def _stub_happy_path(monkeypatch, report=None):
    """Patch every run_pipeline dependency so it can reach the end of the
    happy path. report_mod.build_report is patched to return a canned report
    (matching the real report shape); report_mod.strip_phones is left real,
    since that is exactly the branch the mode test below exercises.
    """
    canned = CANNED_REPORT if report is None else report
    log_probs_stub = SimpleNamespace(shape=(1, 3, 392))

    monkeypatch.setattr(
        main_module.audio_mod, "decode_to_16k_mono", lambda raw, **kw: np.zeros(1600, dtype=np.float32)
    )
    monkeypatch.setattr(main_module.audio_mod, "is_silent", lambda wav: False)
    monkeypatch.setattr(main_module.g2p, "normalize_text", lambda text: ["sheep"])
    monkeypatch.setattr(main_module.g2p, "phonemize_words", lambda words, lang: [["ʃ", "iː", "p"]])
    monkeypatch.setattr(main_module.g2p, "count_syllables", lambda phone_lists: 1)
    monkeypatch.setattr(
        main_module.acoustic, "get_model", lambda model_id, device: ("model-stub", "fe-stub", "tok-stub")
    )
    monkeypatch.setattr(
        main_module.acoustic,
        "emit_log_probs",
        lambda wav, model, feature_extractor, device: (log_probs_stub, 0.02),
    )
    monkeypatch.setattr(main_module.acoustic, "tokens_to_ids", lambda tokenizer, tokens: [1, 2, 3])
    monkeypatch.setattr(main_module.acoustic, "blank_id", lambda tokenizer: 0)
    monkeypatch.setattr(
        main_module.align_mod, "align_sequence", lambda log_probs, token_ids, blank: "raw-spans-stub"
    )
    monkeypatch.setattr(
        main_module.align_mod,
        "to_phone_spans",
        lambda raw_spans, flat_ipa, total_frames: [SimpleNamespace(ipa=ipa) for ipa in flat_ipa],
    )
    monkeypatch.setattr(main_module.gop_mod, "phone_gop", lambda log_probs, span: -0.1)
    monkeypatch.setattr(main_module.gop_mod, "span_argmax_token", lambda log_probs, span, tokenizer: "ʃ")
    monkeypatch.setattr(main_module.gop_mod, "detect_substitution", lambda expected_ipa, argmax_ipa: None)
    monkeypatch.setattr(
        main_module.fluency_mod,
        "compute_prosody",
        lambda wav, *, word_count, syllable_count: "prosody-stub",
    )
    monkeypatch.setattr(main_module.fluency_mod, "fluency_score", lambda prosody: 84)
    monkeypatch.setattr(main_module.report_mod, "build_report", lambda **kwargs: dict(canned))


def test_run_pipeline_raises_no_speech_before_any_downstream_stage_runs(monkeypatch):
    monkeypatch.setattr(
        main_module.audio_mod, "decode_to_16k_mono", lambda raw, **kw: np.zeros(10, dtype=np.float32)
    )
    monkeypatch.setattr(main_module.audio_mod, "is_silent", lambda wav: True)

    # Spies that fail loudly (not just "was called") if the silence gate ever
    # stops running before these stages -- ordering regressions should raise
    # instead of quietly passing.
    phonemize_spy = MagicMock(side_effect=AssertionError("phonemize_words ran after NO_SPEECH"))
    get_model_spy = MagicMock(side_effect=AssertionError("acoustic.get_model ran after NO_SPEECH"))
    monkeypatch.setattr(main_module.g2p, "phonemize_words", phonemize_spy)
    monkeypatch.setattr(main_module.acoustic, "get_model", get_model_spy)

    with pytest.raises(PronError) as exc_info:
        main_module.run_pipeline(b"fake-audio-bytes", "the ship", "scripted")

    assert exc_info.value.code == "NO_SPEECH"
    assert phonemize_spy.called is False
    assert get_model_spy.called is False


def test_run_pipeline_strips_phones_only_in_unscripted_mode(monkeypatch):
    _stub_happy_path(monkeypatch)

    scripted = main_module.run_pipeline(b"fake-audio-bytes", "sheep", "scripted")
    unscripted = main_module.run_pipeline(b"fake-audio-bytes", "sheep", "unscripted")

    assert scripted["words"][0]["phones"] == CANNED_REPORT["words"][0]["phones"]
    assert "phones" not in unscripted["words"][0]
    # Stripping removes "phones" only -- the rest of the word survives.
    assert unscripted["words"][0]["word"] == CANNED_REPORT["words"][0]["word"]
    assert unscripted["words"][0]["accuracy"] == CANNED_REPORT["words"][0]["accuracy"]
