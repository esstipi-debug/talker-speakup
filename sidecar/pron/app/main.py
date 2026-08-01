"""FastAPI surface of the pronunciation sidecar.

POST /assess  multipart: audio (file), text (form), mode (form)
GET  /health  capability flags, always HTTP 200 so the Docker HEALTHCHECK can
              tell "up but misconfigured" from "down"

run_pipeline is synchronous and dispatched to a worker thread: a torch forward
pass on the event loop would stall every other request for its whole duration.
"""

from __future__ import annotations

import ctypes.util
import os
import shutil
import time
from typing import Annotated

import anyio.to_thread
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.exceptions import RequestValidationError

from . import acoustic
from . import align as align_mod
from . import audio as audio_mod
from . import fluency as fluency_mod
from . import g2p
from . import gop as gop_mod
from . import report as report_mod
from .config import SETTINGS
from .errors import PronError, pron_error_handler, validation_error_handler

MAX_TEXT_LENGTH = 300
MODES = frozenset({"scripted", "unscripted"})

app = FastAPI(title="SpeakUp pron sidecar", version="1")
app.add_exception_handler(PronError, pron_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)


def run_pipeline(raw: bytes, text: str, mode: str) -> dict:
    wav = audio_mod.decode_to_16k_mono(raw, max_seconds=SETTINGS.max_audio_sec)
    if audio_mod.is_silent(wav):
        raise PronError("NO_SPEECH", "Couldn't make out any speech in that recording.", status=422)

    words = g2p.normalize_text(text)
    phone_lists = g2p.phonemize_words(words, SETTINGS.espeak_lang)

    model, feature_extractor, tokenizer = acoustic.get_model(SETTINGS.model_id, SETTINGS.device)
    log_probs, sec_per_frame = acoustic.emit_log_probs(wav, model, feature_extractor, SETTINGS.device)

    flat_ipa = [token for tokens in phone_lists for token in tokens]
    token_ids = acoustic.tokens_to_ids(tokenizer, flat_ipa)

    raw_spans = align_mod.align_sequence(log_probs, token_ids, acoustic.blank_id(tokenizer))
    phone_spans = align_mod.to_phone_spans(raw_spans, flat_ipa, int(log_probs.shape[1]))

    gops = [gop_mod.phone_gop(log_probs, span) for span in phone_spans]
    subs = [
        gop_mod.detect_substitution(span.ipa, gop_mod.span_argmax_token(log_probs, span, tokenizer))
        for span in phone_spans
    ]

    prosody = fluency_mod.compute_prosody(
        wav, word_count=len(words), syllable_count=g2p.count_syllables(phone_lists)
    )

    report = report_mod.build_report(
        words=words,
        phone_lists=phone_lists,
        phone_spans=phone_spans,
        phone_gops=gops,
        phone_subs=subs,
        sec_per_frame=sec_per_frame,
        prosody=prosody,
        fluency=fluency_mod.fluency_score(prosody),
        model_id=SETTINGS.model_id,
        mode=mode,
        tau=SETTINGS.gop_tau,
        detect_gop=SETTINGS.detect_gop,
    )

    if mode == "unscripted":
        report = report_mod.strip_phones(report)
    return report


@app.post("/assess")
async def assess(
    audio: Annotated[UploadFile, File()],
    text: Annotated[str, Form()],
    mode: Annotated[str, Form()] = "scripted",
) -> dict:
    cleaned = (text or "").strip()
    if not cleaned:
        raise PronError(
            "MISSING_TEXT",
            'Missing "text" (the reference sentence, non-empty string).',
            status=400,
        )
    if len(cleaned) > MAX_TEXT_LENGTH:
        raise PronError(
            "TEXT_TOO_LONG",
            "That reference sentence is too long. Keep it under 300 characters.",
            status=400,
        )
    if mode not in MODES:
        raise PronError("INVALID_MODE", '"mode" must be "scripted" or "unscripted".', status=400)

    raw = await audio.read()
    if not raw:
        raise PronError("MISSING_AUDIO", 'Missing "audio" file.', status=400)

    try:
        return await anyio.to_thread.run_sync(run_pipeline, raw, cleaned, mode)
    except PronError:
        raise
    except Exception as exc:  # never leak a stack trace to the learner
        raise PronError(
            "INTERNAL", "Something went wrong while scoring that recording.", status=500
        ) from exc


def _espeak_available() -> bool:
    override = os.environ.get("PHONEMIZER_ESPEAK_LIBRARY", "").strip()
    if override:
        return os.path.exists(override)
    return bool(ctypes.util.find_library("espeak-ng") or ctypes.util.find_library("espeak"))


def _ffmpeg_available() -> bool:
    return shutil.which(audio_mod.FFMPEG_BIN) is not None


def _model_loaded() -> bool:
    return acoustic.get_model.cache_info().currsize > 0


@app.get("/health")
async def health() -> dict:
    align_ok = acoustic.align_available()
    espeak_ok = _espeak_available()
    ffmpeg_ok = _ffmpeg_available()
    return {
        "status": "ok" if (align_ok and espeak_ok and ffmpeg_ok) else "degraded",
        "model": SETTINGS.model_id,
        "modelLoaded": _model_loaded(),
        "alignAvailable": align_ok,
        "espeakAvailable": espeak_ok,
        "ffmpegAvailable": ffmpeg_ok,
        "ts": int(time.time() * 1000),
    }
