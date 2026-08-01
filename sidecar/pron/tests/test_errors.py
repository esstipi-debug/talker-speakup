"""The sidecar has exactly one error body shape: {"error": str, "code": str}.

FastAPI's default validation body is {"detail": [...]}, which the Node client
cannot map to a typed code -- validation_error_handler exists to override it.
"""

import json

import pytest
from fastapi.exceptions import RequestValidationError

from app.errors import ERROR_CODES, PronError, pron_error_handler, validation_error_handler


def _body(response):
    return json.loads(bytes(response.body).decode("utf-8"))


def test_error_codes_are_exactly_the_frozen_set():
    assert ERROR_CODES == frozenset(
        {
            "MISSING_AUDIO",
            "MISSING_TEXT",
            "TEXT_TOO_LONG",
            "INVALID_MODE",
            "NO_SPEECH",
            "DECODE_FAILED",
            "UNPRONOUNCEABLE_TEXT",
            "MODEL_UNAVAILABLE",
            "INTERNAL",
        }
    )


def test_pron_error_carries_code_message_and_status():
    err = PronError("NO_SPEECH", "Couldn't make out any speech in that recording.", status=422)
    assert err.code == "NO_SPEECH"
    assert err.message == "Couldn't make out any speech in that recording."
    assert err.status == 422
    assert str(err) == "Couldn't make out any speech in that recording."


def test_pron_error_defaults_to_status_400():
    assert PronError("MISSING_TEXT", "nope").status == 400


def test_pron_error_rejects_a_code_outside_the_frozen_set():
    with pytest.raises(ValueError) as excinfo:
        PronError("KABOOM", "nope")
    assert "KABOOM" in str(excinfo.value)


@pytest.mark.anyio
async def test_pron_error_handler_emits_the_frozen_body():
    response = await pron_error_handler(None, PronError("DECODE_FAILED", "Bad audio.", status=400))
    assert response.status_code == 400
    assert _body(response) == {"error": "Bad audio.", "code": "DECODE_FAILED"}


@pytest.mark.anyio
async def test_validation_error_handler_replaces_the_fastapi_detail_body():
    exc = RequestValidationError([{"loc": ("body", "text"), "msg": "field required", "type": "missing"}])
    response = await validation_error_handler(None, exc)
    assert response.status_code == 400
    body = _body(response)
    assert body["code"] == "MISSING_TEXT"
    assert body["error"].endswith(".")
    assert "detail" not in body


@pytest.mark.anyio
async def test_validation_error_handler_blames_the_audio_part_when_that_is_what_is_missing():
    exc = RequestValidationError([{"loc": ("body", "audio"), "msg": "field required", "type": "missing"}])
    response = await validation_error_handler(None, exc)
    assert _body(response)["code"] == "MISSING_AUDIO"


@pytest.fixture
def anyio_backend():
    return "asyncio"
