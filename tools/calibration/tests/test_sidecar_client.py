"""HTTP client tests — every request is mocked, no network and no live sidecar."""
import io
import sys
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pytest
import requests
from scipy.io import wavfile

from sidecar_client import SidecarError, call_assess, check_health, encode_wav  # noqa: E402


def test_encode_wav_round_trips_sample_rate_and_samples():
    samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
    wav_bytes = encode_wav(samples, 16000)
    rate, decoded = wavfile.read(io.BytesIO(wav_bytes))
    assert rate == 16000
    assert decoded.dtype == np.int16
    assert decoded[0] == 0
    assert decoded[3] == 32767
    assert decoded[4] == -32767


def test_encode_wav_clips_out_of_range_samples_instead_of_wrapping():
    samples = np.array([2.0, -2.0], dtype=np.float32)
    _rate, decoded = wavfile.read(io.BytesIO(encode_wav(samples, 16000)))
    assert decoded[0] == 32767
    assert decoded[1] == -32767


def test_call_assess_returns_the_parsed_report_on_success():
    fake_response = Mock(status_code=200)
    fake_response.json.return_value = {"version": 1, "overall": {"accuracy": 90}}
    with patch("sidecar_client.requests.post", return_value=fake_response) as mock_post:
        report = call_assess("http://localhost:8899", b"RIFF...", "hello", mode="scripted")
    assert report == {"version": 1, "overall": {"accuracy": 90}}
    _args, kwargs = mock_post.call_args
    assert kwargs["data"] == {"text": "hello", "mode": "scripted"}
    assert "audio" in kwargs["files"]


def test_call_assess_raises_sidecar_error_with_code_and_message_on_4xx():
    fake_response = Mock(status_code=422, text="ignored")
    fake_response.json.return_value = {"error": "Couldn't make out any speech.", "code": "NO_SPEECH"}
    with patch("sidecar_client.requests.post", return_value=fake_response):
        with pytest.raises(SidecarError) as excinfo:
            call_assess("http://localhost:8899", b"RIFF...", "hello")
    assert excinfo.value.code == "NO_SPEECH"
    assert excinfo.value.status == 422
    assert "speech" in excinfo.value.message


def test_call_assess_raises_unreachable_on_a_connection_error():
    with patch("sidecar_client.requests.post", side_effect=requests.ConnectionError("refused")):
        with pytest.raises(SidecarError) as excinfo:
            call_assess("http://localhost:8899", b"RIFF...", "hello")
    assert excinfo.value.code == "UNREACHABLE"
    assert excinfo.value.status == 0


def test_call_assess_falls_back_to_internal_when_the_error_body_is_not_json():
    fake_response = Mock(status_code=500, text="<html>gateway error</html>")
    fake_response.json.side_effect = ValueError("not json")
    with patch("sidecar_client.requests.post", return_value=fake_response):
        with pytest.raises(SidecarError) as excinfo:
            call_assess("http://localhost:8899", b"RIFF...", "hello")
    assert excinfo.value.code == "INTERNAL"


def test_check_health_returns_the_parsed_body():
    fake_response = Mock(status_code=200)
    fake_response.json.return_value = {"status": "ok", "model": "facebook/wav2vec2-lv-60-espeak-cv-ft"}
    with patch("sidecar_client.requests.get", return_value=fake_response):
        body = check_health("http://localhost:8899")
    assert body["model"] == "facebook/wav2vec2-lv-60-espeak-cv-ft"


def test_check_health_raises_unreachable_on_a_connection_error():
    with patch("sidecar_client.requests.get", side_effect=requests.ConnectionError("refused")):
        with pytest.raises(SidecarError) as excinfo:
            check_health("http://localhost:8899")
    assert excinfo.value.code == "UNREACHABLE"
