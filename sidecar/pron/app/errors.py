"""The sidecar's single error shape.

Every failure leaves this process as {"error": <sentence>, "code": <ERROR_CODES
member>} with an HTTP status from interface contract section 4.3. FastAPI's own
{"detail": ...} body never reaches the Node client -- validation_error_handler
rewrites it.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

ERROR_CODES: frozenset[str] = frozenset(
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

_MISSING_TEXT_MESSAGE = 'Missing "text" (the reference sentence, non-empty string).'
_MISSING_AUDIO_MESSAGE = 'Missing "audio" file.'


class PronError(Exception):
    """A failure the learner (or the Node server) is allowed to see."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        if code not in ERROR_CODES:
            raise ValueError(f"unknown pron error code: {code}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


async def pron_error_handler(request: Request, exc: PronError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": exc.message, "code": exc.code})


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Rewrite FastAPI's multipart validation failure into the frozen shape.

    A missing form part is the only way to reach this handler, so the code is
    picked from the offending field; MISSING_TEXT is the default.
    """
    fields = {str(part) for error in exc.errors() for part in error.get("loc", ())}
    if "audio" in fields and "text" not in fields:
        return JSONResponse(
            status_code=400,
            content={"error": _MISSING_AUDIO_MESSAGE, "code": "MISSING_AUDIO"},
        )
    return JSONResponse(
        status_code=400,
        content={"error": _MISSING_TEXT_MESSAGE, "code": "MISSING_TEXT"},
    )
