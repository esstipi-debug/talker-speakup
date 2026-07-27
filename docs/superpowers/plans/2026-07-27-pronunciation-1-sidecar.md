# Pronunciation Sidecar Implementation Plan (M7 · plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a containerised Python service that scores a spoken utterance against a reference sentence, returning per-phoneme, per-word and per-sentence scores plus the phoneme actually substituted.

**Architecture:** A FastAPI service at `sidecar/pron/`, independent of the Node server — the only coupling is an HTTP contract. Pipeline: ffmpeg decode → espeak-ng G2P → wav2vec2 phoneme CTC posteriors → CTC forced alignment → GOP scoring → aggregation. Fluency comes from a separate energy-VAD pass, never from the alignment (spec §12 A5).

**Tech Stack:** Python 3.11, FastAPI, PyTorch + torchaudio (`forced_align`), transformers (`Wav2Vec2ForCTC`), phonemizer + espeak-ng, ffmpeg, numpy, pytest, Docker.

## Global Constraints

Every task's requirements implicitly include this section. Values are exact.

- **Repo root (a git worktree):** `C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e`
- **Branch:** `claude/pronunciation-layer-bd7af6`. Never commit to `main`.
- **Design spec:** `docs/superpowers/specs/2026-07-27-pronunciation-layer-design.md`. Read §12 (amendments) before §4 — nine approved decisions were corrected after verification.
- **Shell:** PowerShell 7. `timeout`, `2>/dev/null`, and bash `[ -f x ]` do not exist.
- **Runtime model:** `facebook/wav2vec2-lv-60-espeak-cv-ft` (392-token espeak IPA vocab, Apache-2.0). Never `mrrubino/*` (40 tokens, no `ə`/`iː`/`dʒ`), never `slplab/*` (ARPAbet, no licence), never `torchaudio.pipelines.MMS_FA` (character-level, CC-BY-NC).
- **Provider default:** `PRON_PROVIDER` unset → `mock`. `npm run dev` must work with no Docker running.
- **Ports:** server `3001`, sidecar `8899`, Kokoro TTS `8880`.
- **JS style:** ESM, double quotes, semicolons, 2-space indent, explicit `.js`/`.jsx` on every relative import. No TypeScript, no PropTypes. Hooks are named exports; components are default exports. There is no lint or format config — style is convention only.
- **Test placement:** test files sit *beside* their source (`foo.js` + `foo.test.js`).
- **Coverage floor:** 80% on every new server module.
- **`client/src/hooks/useConversation.js` is untouchable.** No task in any of the four plans may modify it or its test. Plan 3's final task proves this with `git diff`.
- **Nothing writes to the database.** Persistence is M3's single decision; pronunciation results live in client state only.
- **Azure is never a runtime path.** The adapter exists for `tools/calibration/` and requires an explicit key.
- **In unscripted mode `words[].phones` is stripped server-side** before the response is written. A test must fail if phones ever leak.
- **`substituted` is ABSENT, not null,** when a phoneme was produced as expected.
- **Commits stage explicit paths.** `git add -A` and `git add .` are forbidden. Verify the *staged* blob with `git show :<path>` before every commit — this repo has shipped a commit importing an untracked file (spec §11).

### Outstanding verification debt

The four adversarial critic passes (placeholders, interface drift, spec coverage, TDD quality) **did not run** — the API returned `529 Overloaded` twice. These plans carry a mechanical placeholder scan and an author self-review only. Treat the first task of each plan with extra scepticism, and re-run the adversarial pass when capacity allows.

---

# M7 Chunk 1 — The pronunciation sidecar (Python + Docker)

Everything in this chunk lives under `sidecar/pron/`. Nothing here imports from, or is imported by,
the Node server: the only coupling is the HTTP contract in §4.3/§4.4 of the frozen interface
contract. You can build and finish this chunk with the Node server switched off.

Repo root for every path and command below:
`C:/talker/.claude/worktrees/kern-brand-product-assets-5f587e`

## Read this before Task 1

**Two test lanes.** Unit tests run on the Windows host. Integration tests (real espeak-ng, real
model weights, real golden audio) run only inside the container and are marked
`@pytest.mark.integration`.

| Lane | Command | Needs |
|---|---|---|
| Host / unit | `python -m pytest sidecar/pron/tests -q -m "not integration"` | Python 3.11, torch, torchaudio, transformers, numpy, fastapi, httpx, pytest, jsonschema, ffmpeg on PATH |
| Container / all | `docker run --rm speakup-pron python -m pytest tests -q` | Docker Desktop |

Host prerequisites, run once (PowerShell, from the repo root):

```powershell
python --version
ffmpeg -version
python -m pip install --upgrade "torch" "torchaudio" "transformers" "numpy" "fastapi" "python-multipart" "uvicorn" "pytest" "httpx" "jsonschema" "anyio"
python -c "import torch, torchaudio, transformers, numpy; print(torch.__version__, torchaudio.__version__, transformers.__version__, numpy.__version__)"
```

Expected: a Python 3.11.x banner, an ffmpeg version banner, and a line like
`2.12.1+cpu 2.11.0+cpu 5.6.0 2.3.5`. `phonemizer` is deliberately **not** installed on the host —
espeak-ng does not exist on Windows here, and the g2p tests skip themselves when it is missing.

**Manifest addenda.** The frozen contract's §1.3 file manifest lists no test file for `config.py`,
`errors.py`, or `acoustic.py`, and lists no dev-dependency file — but pytest, httpx (required by
FastAPI's `TestClient`) and jsonschema are not in `requirements.txt`. Because TDD is
non-negotiable, this chunk adds exactly four files beyond the manifest:

- `sidecar/pron/requirements-dev.txt`
- `sidecar/pron/tests/test_config.py`
- `sidecar/pron/tests/test_errors.py`
- `sidecar/pron/tests/test_acoustic.py`

They introduce **no new runtime symbol**. Every module, function, dataclass and signature below is
exactly as frozen.

**Every commit stages explicit paths.** This repo has shipped a commit that imported an untracked
file. `git add -A` and `git add .` are forbidden in this plan. Every task ends with
`git diff --cached --name-only` and you must read that list before committing (contract §10 V9).

---

### Task 1: Sidecar package skeleton, pytest wiring, and `config.py`

**Files:**
- Create: `sidecar/pron/pytest.ini`
- Create: `sidecar/pron/app/__init__.py`
- Create: `sidecar/pron/app/config.py`
- Modify: `.gitignore`
- Test: `sidecar/pron/tests/test_config.py`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces:
  - `Settings` — frozen dataclass with fields `model_id: str, device: str, espeak_lang: str, gop_tau: float, detect_gop: float, max_audio_sec: float, host: str, port: int`
  - `def load_settings() -> Settings`
  - `SETTINGS: Settings` (module-level singleton)
  - `DEFAULT_MODEL_ID: str`

**Step 1.** Create the directories and the pytest config. `pythonpath = .` is required — without it
`python -m pytest sidecar/pron/tests` from the repo root cannot import the `app` package, and that
exact command is frozen in contract §9.1.

```powershell
New-Item -ItemType Directory -Force sidecar/pron/app | Out-Null
New-Item -ItemType Directory -Force sidecar/pron/tests/fixtures | Out-Null
```

`sidecar/pron/pytest.ini`:

```ini
[pytest]
testpaths = tests
pythonpath = .
addopts = -q
markers =
    integration: needs espeak-ng, ffmpeg and the wav2vec2 weights; run inside the sidecar container
```

**Step 2.** Write the failing test. `sidecar/pron/tests/test_config.py`:

```python
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
```

**Step 3.** Run it and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_config.py -q
```

Expected (collection error, not a test failure):

```
E   ModuleNotFoundError: No module named 'app'
1 error in 0.0Xs
```

**Step 4.** Create the package marker `sidecar/pron/app/__init__.py` — empty file, zero bytes:

```powershell
New-Item -ItemType File -Force sidecar/pron/app/__init__.py | Out-Null
```

**Step 5.** Implement `sidecar/pron/app/config.py`:

```python
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
```

**Step 6.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_config.py -q
```

Expected: `5 passed`.

**Step 7.** Append the sidecar ignores to `.gitignore`. Add these three lines at the end of the
file (the `tools/calibration/out/` line from contract §1.7 belongs to the calibration chunk — do
not add it here):

```gitignore

# pronunciation sidecar (model weights cache, pytest scratch)
sidecar/pron/.model-cache/
sidecar/pron/.pytest_cache/
```

**Step 8.** Commit with explicit paths:

```powershell
git add sidecar/pron/pytest.ini sidecar/pron/app/__init__.py sidecar/pron/app/config.py sidecar/pron/tests/test_config.py .gitignore
git diff --cached --name-only
```

Expected, exactly these five lines:

```
.gitignore
sidecar/pron/app/__init__.py
sidecar/pron/app/config.py
sidecar/pron/pytest.ini
sidecar/pron/tests/test_config.py
```

```powershell
git commit -m "feat(pron): sidecar package skeleton, pytest wiring, config module"
```

---

### Task 2: `errors.py` — one error shape for the whole sidecar

**Files:**
- Create: `sidecar/pron/app/errors.py`
- Test: `sidecar/pron/tests/test_errors.py`

**Interfaces:**
- Consumes: `fastapi.Request`, `fastapi.exceptions.RequestValidationError`, `fastapi.responses.JSONResponse`.
- Produces:
  - `ERROR_CODES: frozenset[str]`
  - `class PronError(Exception)` with `__init__(self, code: str, message: str, status: int = 400) -> None`, attributes `.code`, `.message`, `.status`
  - `async def pron_error_handler(request: Request, exc: PronError) -> JSONResponse`
  - `async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse`

**Step 1.** Write the failing test. `sidecar/pron/tests/test_errors.py`:

```python
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
```

**Step 2.** Run it and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_errors.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.errors'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/errors.py`:

```python
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
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_errors.py -q
```

Expected: `7 passed`. If you instead see `7 skipped` with `anyio` warnings, install anyio's pytest
plugin: `python -m pip install anyio` (it ships the `anyio_backend` fixture support used above).

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/errors.py sidecar/pron/tests/test_errors.py
git diff --cached --name-only
git commit -m "feat(pron): sidecar error type and the single frozen error body"
```

Expected `git diff --cached --name-only` output:

```
sidecar/pron/app/errors.py
sidecar/pron/tests/test_errors.py
```

---

### Task 3: `audio.py` — ffmpeg decode to 16 kHz mono float32

**Files:**
- Create: `sidecar/pron/app/audio.py`
- Test: `sidecar/pron/tests/test_audio.py`

**Interfaces:**
- Consumes: `app.errors.PronError`, `subprocess`, `numpy`.
- Produces:
  - `def decode_to_16k_mono(raw: bytes, *, max_seconds: float = 30.0, sample_rate: int = 16000, timeout: float = 20.0) -> np.ndarray`
  - `def duration_seconds(wav: np.ndarray, sample_rate: int = 16000) -> float`
  - `def is_silent(wav: np.ndarray, *, rms_threshold: float = 0.005) -> bool`

Recon finding that this task exists to encode: piping `-f wav` to stdout produces a **corrupt RIFF
header** (`frames = 2147483647`) because ffmpeg cannot seek back to patch the size field. We emit
raw `s16le` and do the framing ourselves.

**Step 1.** Write the failing test. `sidecar/pron/tests/test_audio.py`:

```python
"""ffmpeg decode. Verified by execution during recon: raw s16le on stdout is
correct; `-f wav` to a pipe yields a corrupt RIFF header, so we never do that.
"""

import io
import math
import struct
import wave

import numpy as np
import pytest

from app.audio import decode_to_16k_mono, duration_seconds, is_silent
from app.errors import PronError


def _wav_bytes(seconds: float = 0.5, sample_rate: int = 44100, channels: int = 2, freq: float = 440.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        frames = bytearray()
        for i in range(int(sample_rate * seconds)):
            value = int(20000 * math.sin(2 * math.pi * freq * i / sample_rate))
            for _ in range(channels):
                frames += struct.pack("<h", value)
        handle.writeframes(bytes(frames))
    return buf.getvalue()


def test_decode_returns_mono_float32_at_16k():
    wav = decode_to_16k_mono(_wav_bytes(seconds=0.5))
    assert wav.dtype == np.float32
    assert wav.ndim == 1
    assert 7900 <= wav.size <= 8100  # 0.5 s at 16 kHz
    assert 0.5 < float(np.abs(wav).max()) < 0.7  # 20000/32768 == 0.61


def test_decode_respects_the_max_seconds_cap():
    wav = decode_to_16k_mono(_wav_bytes(seconds=2.0), max_seconds=0.5)
    assert wav.size <= 9000


def test_decode_raises_decode_failed_on_garbage_bytes():
    with pytest.raises(PronError) as excinfo:
        decode_to_16k_mono(b"this is not audio, it is a sentence about audio")
    assert excinfo.value.code == "DECODE_FAILED"
    assert excinfo.value.status == 400


def test_decode_raises_decode_failed_on_empty_input():
    with pytest.raises(PronError) as excinfo:
        decode_to_16k_mono(b"")
    assert excinfo.value.code == "DECODE_FAILED"


def test_duration_seconds_is_sample_count_over_rate():
    assert duration_seconds(np.zeros(8000, dtype=np.float32)) == 0.5
    assert duration_seconds(np.zeros(24000, dtype=np.float32)) == 1.5


def test_is_silent_distinguishes_digital_silence_from_speech():
    assert is_silent(np.zeros(16000, dtype=np.float32)) is True
    assert is_silent(decode_to_16k_mono(_wav_bytes(seconds=0.3))) is False
```

**Step 2.** Run it and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_audio.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.audio'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/audio.py`:

```python
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
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_audio.py -q
```

Expected: `6 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/audio.py sidecar/pron/tests/test_audio.py
git diff --cached --name-only
git commit -m "feat(pron): ffmpeg decode to 16 kHz mono float32"
```

---

### Task 4: Dockerfile, dependency pins, and the three UNVERIFIED-API checks

This task builds the image and **verifies three external interfaces the recon could not verify by
execution** (contract §10 V1, V4, V5). No production code is written against a guessed API: the
image is built first, the probes are run inside it, and the results are recorded as comments in the
files. If a probe disagrees with what is written below, the probe wins — adjust the pins and tell
the reviewer.

**Files:**
- Create: `sidecar/pron/requirements.txt`
- Create: `sidecar/pron/requirements-dev.txt`
- Create: `sidecar/pron/Dockerfile`
- Test: none (verification task; the probes become permanent tests in Tasks 5 and 6)

**Interfaces:**
- Consumes: Docker, the public PyPI and Hugging Face endpoints.
- Produces: a local image tagged `speakup-pron`; the recorded pin set in `requirements.txt`.

**Step 1.** Write `sidecar/pron/requirements.txt`. These are the contract §7.3 pins. The Linux
resolution is UNVERIFIED (recon ran on Windows) — Step 5 replaces any that do not resolve.

```
# Runtime deps for the SpeakUp pronunciation sidecar.
# torchaudio is a RANGE, not a pin: forced_align is present with no deprecation
# decorator at 2.8/2.9/2.10/2.11 (the docs removal banner is stale --
# pytorch/audio#3902). Do not narrow it to a single version.
fastapi==0.140.1
uvicorn[standard]==0.42.0
python-multipart==0.0.32
torch==2.12.1
torchaudio>=2.8,<3
transformers==5.6.0
phonemizer==3.3.0
numpy==2.3.5
```

**Step 2.** Write `sidecar/pron/requirements-dev.txt`:

```
# Test-only deps. httpx is required by fastapi.testclient.TestClient;
# jsonschema validates the frozen PronunciationReport schema in test_report.py.
pytest==8.4.2
httpx==0.28.1
jsonschema==4.25.1
```

**Step 3.** Write `sidecar/pron/Dockerfile`:

```dockerfile
# SpeakUp pronunciation sidecar (CAPT). Built and run independently of the Node
# server; the only coupling is HTTP on :8899.
#
# Licence inventory (this container is distributed separately and invoked over
# HTTP):
#   phonemizer                                  GPL-3.0
#   espeak-ng / libespeak-ng1                   GPL-3.0
#   torch, torchaudio                           BSD-3-Clause
#   transformers                                Apache-2.0
#   facebook/wav2vec2-lv-60-espeak-cv-ft        Apache-2.0
FROM python:3.11-slim

# espeak-ng pulls libespeak-ng1 + espeak-ng-data. phonemizer dlopen()s the
# shared library (it never shells out to the CLI), so the library is the real
# requirement; the metapackage is the conventional way to get it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        espeak-ng ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models

WORKDIR /srv

COPY requirements.txt requirements-dev.txt ./
# CPU wheels only -- the default PyPI torch wheel drags in the whole CUDA stack.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt -r requirements-dev.txt

COPY pytest.ini ./
COPY app ./app
COPY tests ./tests

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import json,sys,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8899/health', timeout=5)); sys.exit(0 if d.get('status')=='ok' else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8899"]
```

**Step 4.** Build. This downloads ~1 GB of wheels; expect 5–15 minutes on a cold cache. `app.main`
does not exist yet, so the image builds but the default `CMD` will fail — that is expected until
Task 12.

```powershell
docker build -t speakup-pron sidecar/pron
```

Expected last line: `=> => naming to docker.io/library/speakup-pron`.

If pip fails to resolve a pin, note the version it *does* offer, edit `requirements.txt` /
`requirements-dev.txt` to that version, and rebuild. Do **not** relax `torchaudio>=2.8,<3` and do
not change the `transformers` major.

**Step 5 — V4: record what actually resolved.**

```powershell
docker run --rm speakup-pron pip freeze | Select-String -Pattern "^(torch|torchaudio|transformers|numpy|fastapi|uvicorn|phonemizer|python-multipart)=="
```

Expected: eight `name==version` lines. Copy them into the header comment of
`requirements.txt` under a line `# pip freeze inside python:3.11-slim on <today's date>:` and make
each pinned line match what resolved.

**Step 6 — V5: alignment extension present?** `import torchaudio.lib._torchaudio` raises
`ImportError` (it is a torch op library, not an importable module) — import the flag instead.

```powershell
docker run --rm speakup-pron python -c "from torchaudio._extension import _IS_ALIGN_AVAILABLE; print('align', _IS_ALIGN_AVAILABLE)"
```

Expected exactly: `align True`. If it prints `False`, stop: `forced_align` is decorated with
`@fail_if_no_align` and the whole pipeline is dead. Try a different torchaudio version inside the
`>=2.8,<3` range before doing anything else.

**Step 7 — V1: does espeak's IPA actually land inside the model's vocab?** This is the single
assumption the entire G2P→align→GOP chain rests on and the recon could **not** execute it (no
espeak-ng on Windows). Run it now, before `g2p.py` is written. First download the weights into a
named volume so later runs are fast:

```powershell
docker volume create speakup-pron-models
docker run --rm -v speakup-pron-models:/models speakup-pron python -c "from transformers import Wav2Vec2PhonemeCTCTokenizer as T; t=T.from_pretrained('facebook/wav2vec2-lv-60-espeak-cv-ft', do_phonemize=False); print('vocab', len(t.get_vocab()), 'pad', t.pad_token_id, 'unk', t.unk_token_id)"
```

Expected exactly: `vocab 392 pad 0 unk 3`.

Then the probe itself:

```powershell
docker run --rm -v speakup-pron-models:/models speakup-pron python -c "from phonemizer.backend import EspeakBackend; from phonemizer.separator import Separator; from transformers import Wav2Vec2PhonemeCTCTokenizer as T; b=EspeakBackend('en-us', with_stress=False, language_switch='remove-flags'); w=['sheep','ship','judge','comfortable','spain','wanted']; out=[l.split() for l in b.phonemize(w, separator=Separator(phone=' ', word='|', syllable=''), strip=True)]; v=T.from_pretrained('facebook/wav2vec2-lv-60-espeak-cv-ft', do_phonemize=False).get_vocab(); [print(a, o, 'OOV:', [p for p in o if p not in v]) for a,o in zip(w,out)]"
```

Also record the espeak version:

```powershell
docker run --rm speakup-pron espeak-ng --version
```

**What must hold** (this is the acceptance criterion, the exact token strings are the model's, not
mine): every line prints `OOV: []`, no token contains `ˈ` (U+02C8), `ˌ` (U+02CC), `|`, `͡` or a
space. If any token is OOV, do not paper over it in `g2p.py` — report the exact token list, because
either `with_stress` leaked, the language switch flag leaked, or the model choice is wrong.

Record the probe output as a comment block at the top of `sidecar/pron/Dockerfile`, immediately
under the licence inventory, in this shape (fill in the real values):

```dockerfile
# Verified inside this image on <date> (contract section 10, V1/V4/V5):
#   espeak-ng <version>; torchaudio._extension._IS_ALIGN_AVAILABLE = True
#   tokenizer vocab 392, pad 0, unk 3
#   phonemize(["sheep","ship","judge","comfortable","spain","wanted"]) -> 0 OOV tokens
```

**Step 8.** Commit:

```powershell
git add sidecar/pron/Dockerfile sidecar/pron/requirements.txt sidecar/pron/requirements-dev.txt
git diff --cached --name-only
git commit -m "build(pron): sidecar image with espeak-ng + ffmpeg, pinned deps, verified IPA vocab"
```

---

### Task 5: `g2p.py` — text to expected IPA

**Files:**
- Create: `sidecar/pron/app/g2p.py`
- Test: `sidecar/pron/tests/test_g2p.py`

**Interfaces:**
- Consumes: `app.errors.PronError`, `phonemizer.backend.EspeakBackend`, `phonemizer.separator.Separator`.
- Produces:
  - `VOWEL_IPA: frozenset[str]`
  - `def get_backend(lang: str = "en-us") -> "EspeakBackend"` (process-wide memoized)
  - `def normalize_text(text: str) -> list[str]`
  - `def phonemize_words(words: list[str], lang: str = "en-us") -> list[list[str]]`
  - `def count_syllables(phone_lists: list[list[str]]) -> int`

The backend is constructed **once** per language (phonemizer's own docs: backend init is the
expensive part; never call the module-level `phonemize()` per request).

**Step 1.** Write the failing test. `sidecar/pron/tests/test_g2p.py`:

```python
"""G2P. The pure helpers run anywhere; anything that touches espeak-ng is
marked `integration` and skipped on hosts without the shared library.
"""

import ctypes.util

import pytest

from app.errors import PronError
from app.g2p import VOWEL_IPA, count_syllables, normalize_text, phonemize_words

_HAS_ESPEAK = bool(ctypes.util.find_library("espeak-ng") or ctypes.util.find_library("espeak"))
requires_espeak = pytest.mark.skipif(
    not _HAS_ESPEAK, reason="espeak-ng not installed; run this test in the sidecar container"
)


def test_normalize_text_lowercases_strips_punctuation_and_keeps_apostrophes():
    assert normalize_text("The ship isn't full \u2014 of SHEEP!") == [
        "the",
        "ship",
        "isn't",
        "full",
        "of",
        "sheep",
    ]


def test_normalize_text_drops_punctuation_only_tokens():
    assert normalize_text("hello  ---  world") == ["hello", "world"]


def test_normalize_text_returns_empty_for_punctuation_only_input():
    assert normalize_text("!!! ... ???") == []


def test_count_syllables_counts_vowel_nuclei_across_words():
    assert count_syllables([["\u00f0", "\u0259"], ["\u0283", "i\u02d0", "p"]]) == 2
    assert count_syllables([["k", "\u0252", "m", "f", "\u0259", "t", "\u0259", "b", "\u0259", "l"]]) == 4
    assert count_syllables([]) == 0


def test_vowel_inventory_contains_the_drill_targets():
    for vowel in ("\u026a", "i\u02d0", "\u00e6", "\u0259"):
        assert vowel in VOWEL_IPA


def test_phonemize_words_rejects_an_empty_word_list():
    with pytest.raises(PronError) as excinfo:
        phonemize_words([])
    assert excinfo.value.code == "UNPRONOUNCEABLE_TEXT"
    assert excinfo.value.status == 400


@pytest.mark.integration
@requires_espeak
def test_phonemize_words_returns_one_token_list_per_word():
    out = phonemize_words(["the", "sheep"])
    assert len(out) == 2
    assert all(tokens for tokens in out)
    assert out[1][0] == "\u0283"  # sheep starts with the postalveolar fricative


@pytest.mark.integration
@requires_espeak
def test_phonemize_words_emits_no_stress_marks_and_no_delimiters():
    flat = [token for tokens in phonemize_words(["comfortable", "wanted", "judge"]) for token in tokens]
    assert flat
    for token in flat:
        assert "\u02c8" not in token  # primary stress
        assert "\u02cc" not in token  # secondary stress
        assert "|" not in token
        assert " " not in token


@pytest.mark.integration
@requires_espeak
def test_every_espeak_token_is_inside_the_model_vocabulary():
    """Contract section 10, V1: the one assumption the whole pipeline rests on."""
    from transformers import Wav2Vec2PhonemeCTCTokenizer

    from app.config import DEFAULT_MODEL_ID

    vocab = Wav2Vec2PhonemeCTCTokenizer.from_pretrained(
        DEFAULT_MODEL_ID, do_phonemize=False
    ).get_vocab()
    words = ["sheep", "ship", "judge", "comfortable", "spain", "wanted"]
    oov = [t for tokens in phonemize_words(words) for t in tokens if t not in vocab]
    assert oov == []
```

**Step 2.** Run it and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_g2p.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.g2p'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/g2p.py`:

```python
"""Grapheme-to-phoneme via espeak-ng.

Words are phonemized one per input line and the per-word token counts are kept,
so word boundaries survive without a delimiter token. That matters: the model's
word delimiter is None, and `tokenizer.add_tokens("|")` would mint id 392 --
outside the 392-dim output layer -- which cannot be passed to forced_align.

with_stress is False on purpose: the primary/secondary stress marks are absent
from the model's 392-token vocab, and an OOV token silently poisons GOP because
unk_token_id (3) is not the CTC blank.
"""

from __future__ import annotations

import functools
import re

from .errors import PronError

_UNPRONOUNCEABLE_MESSAGE = "Couldn't turn that sentence into phonemes. Try plain English words."
_WORD_CLEAN_RE = re.compile(r"[^\w'\-]+", flags=re.UNICODE)

# espeak IPA vowel nuclei, used only for syllable counting.
VOWEL_IPA: frozenset[str] = frozenset(
    {
        "i",
        "iː",
        "ɪ",
        "e",
        "ɛ",
        "eɪ",
        "æ",
        "ɐ",
        "ʌ",
        "ə",
        "əl",
        "ɚ",
        "ɜː",
        "ɝ",
        "ɑ",
        "ɑː",
        "ɒ",
        "ɔ",
        "ɔː",
        "o",
        "oʊ",
        "əʊ",
        "ʊ",
        "u",
        "uː",
        "aɪ",
        "aʊ",
        "ɔɪ",
        "ɪə",
        "eə",
        "ʊə",
        "ɑːɹ",
        "ɔːɹ",
        "oːɹ",
        "ɜːɹ",
        "ɪɹ",
        "ɛɹ",
        "ʊɹ",
        "aɪɚ",
        "aʊɚ",
        "iə",
        "iːɹ",
    }
)


@functools.lru_cache(maxsize=4)
def get_backend(lang: str = "en-us"):
    """Process-wide espeak backend. Construction is the expensive part."""
    try:
        from phonemizer.backend import EspeakBackend
    except ImportError as exc:
        raise PronError(
            "MODEL_UNAVAILABLE",
            "Phoneme conversion is unavailable on the server (phonemizer is missing).",
            status=503,
        ) from exc

    try:
        return EspeakBackend(lang, with_stress=False, language_switch="remove-flags")
    except Exception as exc:  # RuntimeError when the shared library is absent
        raise PronError(
            "MODEL_UNAVAILABLE",
            "Phoneme conversion is unavailable on the server (espeak-ng is missing).",
            status=503,
        ) from exc


def normalize_text(text: str) -> list[str]:
    cleaned = _WORD_CLEAN_RE.sub(" ", (text or "").lower())
    return [word for word in cleaned.split() if word.strip("'-")]


def phonemize_words(words: list[str], lang: str = "en-us") -> list[list[str]]:
    if not words:
        raise PronError("UNPRONOUNCEABLE_TEXT", _UNPRONOUNCEABLE_MESSAGE, status=400)

    from phonemizer.separator import Separator

    backend = get_backend(lang)
    lines = backend.phonemize(
        list(words),
        separator=Separator(phone=" ", word="|", syllable=""),
        strip=True,
    )

    out: list[list[str]] = []
    for line in lines:
        out.append([token for token in line.replace("|", " ").split() if token])

    if len(out) != len(words) or any(not tokens for tokens in out):
        raise PronError("UNPRONOUNCEABLE_TEXT", _UNPRONOUNCEABLE_MESSAGE, status=400)
    return out


def count_syllables(phone_lists: list[list[str]]) -> int:
    return sum(1 for tokens in phone_lists for token in tokens if token in VOWEL_IPA)
```

**Step 4.** Run again on the host (integration tests skip):

```powershell
python -m pytest sidecar/pron/tests/test_g2p.py -q
```

Expected: `6 passed, 3 skipped`.

**Step 5.** Run the integration lane in the container — this is where V1 becomes a permanent test:

```powershell
docker build -t speakup-pron sidecar/pron
docker run --rm -v speakup-pron-models:/models speakup-pron python -m pytest tests/test_g2p.py -q
```

Expected: `9 passed`.

**Step 6.** Commit:

```powershell
git add sidecar/pron/app/g2p.py sidecar/pron/tests/test_g2p.py
git diff --cached --name-only
git commit -m "feat(pron): espeak-ng G2P with per-word token lists and vocab conformance test"
```

---

### Task 6: `acoustic.py` — phoneme posteriors and the OOV trap

**Files:**
- Create: `sidecar/pron/app/acoustic.py`
- Test: `sidecar/pron/tests/test_acoustic.py`

**Interfaces:**
- Consumes: `app.errors.PronError`, `torch`, `transformers`, `torchaudio._extension`.
- Produces:
  - `def get_model(model_id: str, device: str) -> tuple[Wav2Vec2ForCTC, Wav2Vec2FeatureExtractor, Wav2Vec2PhonemeCTCTokenizer]`
  - `def blank_id(tokenizer) -> int`
  - `def unk_id(tokenizer) -> int`
  - `def tokens_to_ids(tokenizer, tokens: list[str]) -> list[int]`
  - `def emit_log_probs(wav: np.ndarray, model, feature_extractor, device: str) -> tuple[torch.Tensor, float]`
  - `def align_available() -> bool`

Two verified facts this task encodes: `Wav2Vec2ForCTC` returns **raw logits** (unlike the MMS_FA
pipeline, which log-softmaxes for you), and `unk_token_id` is 3 — not the blank — so an OOV phone
produces a confident, meaningless GOP unless we refuse it up front.

**Step 1.** Write the failing test. `sidecar/pron/tests/test_acoustic.py`:

```python
"""Acoustic front end. The unit lane uses fakes -- no 1 GB download to assert
that log_softmax was applied and that OOV tokens are refused.
"""

from types import SimpleNamespace

import numpy as np
import pytest
import torch

from app.acoustic import align_available, blank_id, emit_log_probs, tokens_to_ids, unk_id
from app.errors import PronError


class FakeTokenizer:
    pad_token_id = 0
    unk_token_id = 3
    _vocab = {"<pad>": 0, "|": 1, "\u0283": 2, "<unk>": 3, "i\u02d0": 4, "p": 5}

    def convert_tokens_to_ids(self, tokens):
        return [self._vocab.get(token, self.unk_token_id) for token in tokens]

    def convert_ids_to_tokens(self, index):
        return {v: k for k, v in self._vocab.items()}[index]


class FakeFeatureExtractor:
    def __init__(self):
        self.calls = []

    def __call__(self, wav, sampling_rate=16000, return_tensors="pt"):
        self.calls.append(sampling_rate)
        return {"input_values": torch.from_numpy(np.asarray(wav)).unsqueeze(0)}


class FakeModel:
    def __init__(self, frames, classes=7):
        self.frames = frames
        self.classes = classes

    def __call__(self, **kwargs):
        batch = kwargs["input_values"].shape[0]
        torch.manual_seed(0)
        return SimpleNamespace(logits=torch.randn(batch, self.frames, self.classes) * 5.0)


def test_blank_and_unk_come_from_the_tokenizer():
    tokenizer = FakeTokenizer()
    assert blank_id(tokenizer) == 0
    assert unk_id(tokenizer) == 3


def test_tokens_to_ids_maps_known_ipa():
    assert tokens_to_ids(FakeTokenizer(), ["\u0283", "i\u02d0", "p"]) == [2, 4, 5]


def test_tokens_to_ids_refuses_out_of_vocabulary_phones():
    with pytest.raises(PronError) as excinfo:
        tokens_to_ids(FakeTokenizer(), ["\u0283", "\u0279\u0329"])
    assert excinfo.value.code == "UNPRONOUNCEABLE_TEXT"
    assert "\u0279\u0329" in excinfo.value.message


def test_emit_log_probs_applies_log_softmax_and_computes_the_frame_rate():
    wav = np.zeros(16000, dtype=np.float32)  # exactly 1.0 s
    extractor = FakeFeatureExtractor()

    log_probs, sec_per_frame = emit_log_probs(wav, FakeModel(frames=40), extractor, "cpu")

    assert log_probs.shape == (1, 40, 7)
    assert torch.allclose(log_probs.exp().sum(dim=-1), torch.ones(1, 40), atol=1e-5)
    assert sec_per_frame == pytest.approx(0.025)  # computed, never hardcoded to 0.02
    assert extractor.calls == [16000]  # do_normalize=True path is never bypassed


def test_emit_log_probs_rejects_empty_audio():
    with pytest.raises(PronError) as excinfo:
        emit_log_probs(np.zeros(0, dtype=np.float32), FakeModel(frames=1), FakeFeatureExtractor(), "cpu")
    assert excinfo.value.code == "NO_SPEECH"
    assert excinfo.value.status == 422


def test_align_available_reports_the_torchaudio_build_flag():
    assert align_available() is True
```

**Step 2.** Run it and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_acoustic.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.acoustic'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/acoustic.py`:

```python
"""wav2vec2 phoneme CTC front end.

Two verified traps live here:
  1. Wav2Vec2ForCTC returns RAW LOGITS. torchaudio's forced_align wants
     log-probabilities, so log_softmax is applied here and nowhere else.
  2. unk_token_id is 3 -- not the CTC blank. An out-of-vocabulary phone aligns
     happily and yields a confident, meaningless GOP, so tokens_to_ids refuses
     it before alignment ever runs.

The tokenizer is loaded with do_phonemize=False: otherwise transformers
constructs its own phonemizer backend at load time, which we neither need nor
want (we run our own G2P).
"""

from __future__ import annotations

import functools

import numpy as np

from .errors import PronError

SAMPLE_RATE = 16000


@functools.lru_cache(maxsize=2)
def get_model(model_id: str, device: str):
    try:
        from transformers import (
            Wav2Vec2FeatureExtractor,
            Wav2Vec2ForCTC,
            Wav2Vec2PhonemeCTCTokenizer,
        )
    except ImportError as exc:
        raise PronError(
            "MODEL_UNAVAILABLE",
            "The pronunciation model is unavailable on the server (transformers is missing).",
            status=503,
        ) from exc

    try:
        tokenizer = Wav2Vec2PhonemeCTCTokenizer.from_pretrained(model_id, do_phonemize=False)
        feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(model_id)
        model = Wav2Vec2ForCTC.from_pretrained(model_id).to(device).eval()
    except Exception as exc:
        raise PronError(
            "MODEL_UNAVAILABLE",
            f"The pronunciation model failed to load ({model_id}).",
            status=503,
        ) from exc

    return model, feature_extractor, tokenizer


def blank_id(tokenizer) -> int:
    return int(tokenizer.pad_token_id)


def unk_id(tokenizer) -> int:
    return int(tokenizer.unk_token_id)


def tokens_to_ids(tokenizer, tokens: list[str]) -> list[int]:
    ids = [int(i) for i in tokenizer.convert_tokens_to_ids(list(tokens))]
    unknown = int(tokenizer.unk_token_id)
    offenders = sorted({token for token, i in zip(tokens, ids) if i == unknown})
    if offenders:
        raise PronError(
            "UNPRONOUNCEABLE_TEXT",
            "These sounds aren't in the model's inventory: " + ", ".join(offenders) + ".",
            status=400,
        )
    return ids


def emit_log_probs(wav: np.ndarray, model, feature_extractor, device: str):
    import torch

    if wav is None or len(wav) == 0:
        raise PronError("NO_SPEECH", "Couldn't make out any speech in that recording.", status=422)

    inputs = feature_extractor(wav, sampling_rate=SAMPLE_RATE, return_tensors="pt")
    tensors = {key: value.to(device) for key, value in dict(inputs).items()}

    with torch.inference_mode():
        logits = model(**tensors).logits

    log_probs = torch.log_softmax(logits.float(), dim=-1)
    frames = int(log_probs.shape[1])
    if frames == 0:
        raise PronError("NO_SPEECH", "Couldn't make out any speech in that recording.", status=422)

    sec_per_frame = (len(wav) / SAMPLE_RATE) / frames
    return log_probs, sec_per_frame


def align_available() -> bool:
    try:
        from torchaudio._extension import _IS_ALIGN_AVAILABLE
    except ImportError:
        return False
    return bool(_IS_ALIGN_AVAILABLE)
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_acoustic.py -q
```

Expected: `6 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/acoustic.py sidecar/pron/tests/test_acoustic.py
git diff --cached --name-only
git commit -m "feat(pron): wav2vec2 phoneme posteriors with an out-of-vocabulary guard"
```

---

### Task 7: `align.py` part 1 — `PhoneSpan`, `expand_spans`, `unflatten`, `frames_to_seconds`

CTC output is peaky: recon measured every phone span at **exactly 1 frame (20 ms)**, covering 9 % of
frames — the other 91 % are blanks. The spec's example report shows real durations. `expand_spans`
is the deterministic blank-attribution pass that reconciles the two, and it is the **only** source
of phone boundaries in this system.

**Files:**
- Create: `sidecar/pron/app/align.py`
- Test: `sidecar/pron/tests/test_align.py`

**Interfaces:**
- Consumes: nothing (pure Python; no torch import in this half).
- Produces:
  - `@dataclass(frozen=True) class PhoneSpan` with `token_id: int, ipa: str, raw_start: int, raw_end: int, start: int, end: int, ctc_score: float`
  - `def expand_spans(spans, total_frames: int) -> list[tuple[int, int]]`
  - `def frames_to_seconds(frame: int, sec_per_frame: float) -> float`
  - `def unflatten(items: list, lengths: list[int]) -> list[list]`

**Step 1.** Write the failing test. `sidecar/pron/tests/test_align.py`:

```python
"""Blank attribution. Raw CTC spans are ~1 frame wide with long blank runs
between them; expand_spans splits each gap at its midpoint so the phones tile
the utterance contiguously (invariant I5).
"""

from dataclasses import dataclass

import pytest

from app.align import PhoneSpan, expand_spans, frames_to_seconds, unflatten


@dataclass
class FakeSpan:
    start: int
    end: int


def test_expand_spans_tiles_the_whole_utterance():
    spans = [FakeSpan(2, 3), FakeSpan(10, 11), FakeSpan(20, 21)]
    assert expand_spans(spans, total_frames=33) == [(0, 6), (6, 15), (15, 33)]


def test_expand_spans_of_a_single_span_covers_everything():
    assert expand_spans([FakeSpan(5, 6)], total_frames=33) == [(0, 33)]


def test_expand_spans_handles_adjacent_spans_without_collapsing_them():
    out = expand_spans([FakeSpan(2, 3), FakeSpan(3, 4)], total_frames=8)
    assert out == [(0, 3), (3, 8)]
    for start, end in out:
        assert end > start


def test_expand_spans_output_is_contiguous_and_conserves_every_frame():
    spans = [FakeSpan(1, 2), FakeSpan(4, 5), FakeSpan(9, 10), FakeSpan(14, 15)]
    out = expand_spans(spans, total_frames=20)
    assert out[0][0] == 0
    assert out[-1][1] == 20
    assert sum(end - start for start, end in out) == 20
    for (_, prev_end), (next_start, _) in zip(out, out[1:]):
        assert prev_end == next_start


def test_expand_spans_is_empty_for_degenerate_input():
    assert expand_spans([], total_frames=33) == []
    assert expand_spans([FakeSpan(0, 1)], total_frames=0) == []


def test_frames_to_seconds_rounds_to_milliseconds():
    assert frames_to_seconds(33, 0.02015) == 0.665
    assert frames_to_seconds(0, 0.02) == 0.0


def test_unflatten_splits_by_per_word_phone_counts():
    assert unflatten(["a", "b", "c", "d", "e"], [2, 3]) == [["a", "b"], ["c", "d", "e"]]
    assert unflatten([], []) == []


def test_unflatten_refuses_mismatched_lengths():
    with pytest.raises(ValueError):
        unflatten(["a", "b"], [3])


def test_phone_span_is_frozen_and_carries_both_raw_and_expanded_frames():
    span = PhoneSpan(token_id=4, ipa="i\u02d0", raw_start=10, raw_end=11, start=6, end=15, ctc_score=0.9)
    assert (span.raw_start, span.raw_end) == (10, 11)
    assert (span.start, span.end) == (6, 15)
    with pytest.raises(Exception):
        span.start = 0  # type: ignore[misc]
```

**Step 2.** Run it and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_align.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.align'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/align.py` (first half; Task 8 appends to this file):

```python
"""Forced alignment and blank attribution.

Verified by execution during recon: with facebook/wav2vec2-lv-60-espeak-cv-ft
every merge_tokens span is exactly one 20 ms frame wide and ~91 % of frames are
CTC blanks. Those raw spans are the right input for GOP (they are where the
model actually committed) and the wrong output for a report (they are not
durations). expand_spans reconciles the two by splitting each blank run at its
midpoint, so the reported phones tile the utterance with no gaps.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PhoneSpan:
    token_id: int
    ipa: str
    raw_start: int  # inclusive emission frame, straight from merge_tokens
    raw_end: int  # exclusive emission frame, straight from merge_tokens
    start: int  # inclusive frame after blank attribution
    end: int  # exclusive frame after blank attribution
    ctc_score: float  # merge_tokens mean score, already exp()'d to a probability


def frames_to_seconds(frame: int, sec_per_frame: float) -> float:
    return round(int(frame) * float(sec_per_frame), 3)


def unflatten(items: list, lengths: list[int]) -> list[list]:
    if sum(lengths) != len(items):
        raise ValueError(f"unflatten: lengths sum to {sum(lengths)} but got {len(items)} items")
    out: list[list] = []
    cursor = 0
    for length in lengths:
        out.append(list(items[cursor : cursor + length]))
        cursor += length
    return out


def expand_spans(spans, total_frames: int) -> list[tuple[int, int]]:
    """Attribute the blank runs between raw CTC spans to their neighbours."""
    if total_frames <= 0 or not spans:
        return []

    count = len(spans)
    starts = [int(span.start) for span in spans]
    ends = [int(span.end) for span in spans]

    starts[0] = 0
    for index in range(count - 1):
        gap_lo = int(spans[index].end)
        gap_hi = int(spans[index + 1].start)
        midpoint = gap_lo + (gap_hi - gap_lo) // 2
        ends[index] = max(gap_lo, midpoint)
        starts[index + 1] = ends[index]
    ends[count - 1] = total_frames

    return [(starts[i], ends[i]) for i in range(count)]
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_align.py -q
```

Expected: `9 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/align.py sidecar/pron/tests/test_align.py
git diff --cached --name-only
git commit -m "feat(pron): PhoneSpan and deterministic CTC blank attribution"
```

---

### Task 8: `align.py` part 2 — `align_sequence` and `to_phone_spans`

**Files:**
- Modify: `sidecar/pron/app/align.py`
- Test: `sidecar/pron/tests/test_align.py` (append)

**Interfaces:**
- Consumes: `torchaudio.functional.forced_align`, `torchaudio.functional.merge_tokens`, `app.errors.PronError`, `app.align.expand_spans`.
- Produces:
  - `def align_sequence(log_probs, token_ids: list[int], blank: int) -> list["TokenSpan"]`
  - `def to_phone_spans(spans, ipa_tokens: list[str], total_frames: int) -> list[PhoneSpan]`

Verified signature (torchaudio 2.11 source, `functional/_alignment.py`):
`forced_align(log_probs, targets, input_lengths=None, target_lengths=None, blank=0) -> (alignments, scores)`,
both `(B, T)`, batch size must be 1, and the returned `scores` are already the log-probs of the
chosen labels — the tutorial `.exp()`s them, and so do we.

**Step 1.** Append to `sidecar/pron/tests/test_align.py`:

```python
import torch

from app.align import align_sequence, to_phone_spans
from app.errors import PronError


def _peaky_log_probs(frames: int, classes: int, path: list[int]) -> torch.Tensor:
    logits = torch.full((1, frames, classes), -10.0)
    for frame, token in enumerate(path):
        logits[0, frame, token] = 10.0
    return torch.log_softmax(logits, dim=-1)


def test_align_sequence_returns_one_span_per_target_token():
    log_probs = _peaky_log_probs(6, 5, [0, 1, 0, 2, 0, 0])
    spans = align_sequence(log_probs, [1, 2], blank=0)
    assert [span.token for span in spans] == [1, 2]
    assert (spans[0].start, spans[0].end) == (1, 2)
    assert (spans[1].start, spans[1].end) == (3, 4)
    assert 0.0 < spans[0].score <= 1.0  # already exp()'d to a probability


def test_align_sequence_raises_no_speech_when_the_audio_is_shorter_than_the_transcript():
    log_probs = _peaky_log_probs(2, 5, [0, 0])
    with pytest.raises(PronError) as excinfo:
        align_sequence(log_probs, [1, 2, 3, 4], blank=0)
    assert excinfo.value.code == "NO_SPEECH"
    assert excinfo.value.status == 422


def test_align_sequence_rejects_an_empty_target():
    with pytest.raises(PronError) as excinfo:
        align_sequence(_peaky_log_probs(4, 5, [0, 0, 0, 0]), [], blank=0)
    assert excinfo.value.code == "UNPRONOUNCEABLE_TEXT"


def test_to_phone_spans_keeps_raw_frames_and_adds_expanded_contiguous_ones():
    log_probs = _peaky_log_probs(6, 5, [0, 1, 0, 2, 0, 0])
    spans = align_sequence(log_probs, [1, 2], blank=0)

    phones = to_phone_spans(spans, ["\u0283", "p"], total_frames=6)

    assert [p.ipa for p in phones] == ["\u0283", "p"]
    assert [(p.raw_start, p.raw_end) for p in phones] == [(1, 2), (3, 4)]
    assert [(p.start, p.end) for p in phones] == [(0, 2), (2, 6)]
    assert [p.token_id for p in phones] == [1, 2]


def test_to_phone_spans_refuses_a_token_count_mismatch():
    log_probs = _peaky_log_probs(6, 5, [0, 1, 0, 2, 0, 0])
    spans = align_sequence(log_probs, [1, 2], blank=0)
    with pytest.raises(ValueError):
        to_phone_spans(spans, ["\u0283"], total_frames=6)
```

**Step 2.** Run and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_align.py -q
```

Expected:

```
E   ImportError: cannot import name 'align_sequence' from 'app.align'
1 error in 0.Xs
```

**Step 3.** Append to `sidecar/pron/app/align.py`:

```python
def align_sequence(log_probs, token_ids: list[int], blank: int):
    """Run CTC forced alignment on the phoneme model's own log-probs.

    No second model: torchaudio's MMS_FA bundle is character-level and CC-BY-NC,
    so it cannot produce per-phoneme spans and must not be used here.
    """
    import torch
    import torchaudio.functional as AF

    from .errors import PronError

    if not token_ids:
        raise PronError(
            "UNPRONOUNCEABLE_TEXT",
            "Couldn't turn that sentence into phonemes. Try plain English words.",
            status=400,
        )

    if int(log_probs.shape[1]) < len(token_ids):
        raise PronError(
            "NO_SPEECH",
            "Couldn't make out any speech in that recording.",
            status=422,
        )

    targets = torch.tensor([list(token_ids)], dtype=torch.int32, device=log_probs.device)

    try:
        alignments, scores = AF.forced_align(log_probs, targets, blank=int(blank))
        spans = AF.merge_tokens(alignments[0], scores[0].exp(), blank=int(blank))
    except RuntimeError as exc:
        if "too long" in str(exc).lower():
            raise PronError(
                "NO_SPEECH", "Couldn't make out any speech in that recording.", status=422
            ) from exc
        raise PronError("INTERNAL", "Alignment failed for that recording.", status=500) from exc
    except ValueError as exc:
        raise PronError("INTERNAL", "Alignment failed for that recording.", status=500) from exc

    if len(spans) != len(token_ids):
        raise PronError("INTERNAL", "Alignment failed for that recording.", status=500)

    return spans


def to_phone_spans(spans, ipa_tokens: list[str], total_frames: int) -> list[PhoneSpan]:
    if len(spans) != len(ipa_tokens):
        raise ValueError(f"to_phone_spans: {len(spans)} spans but {len(ipa_tokens)} IPA tokens")

    expanded = expand_spans(spans, total_frames)
    return [
        PhoneSpan(
            token_id=int(span.token),
            ipa=ipa,
            raw_start=int(span.start),
            raw_end=int(span.end),
            start=int(start),
            end=int(end),
            ctc_score=float(span.score),
        )
        for span, ipa, (start, end) in zip(spans, ipa_tokens, expanded)
    ]
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_align.py -q
```

Expected: `14 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/align.py sidecar/pron/tests/test_align.py
git diff --cached --name-only
git commit -m "feat(pron): CTC forced alignment against the phoneme model's own log-probs"
```

---

### Task 9: `gop.py` — goodness of pronunciation, substitution, aggregation

**Files:**
- Create: `sidecar/pron/app/gop.py`
- Test: `sidecar/pron/tests/test_gop.py`

**Interfaces:**
- Consumes: `app.align.PhoneSpan`, `torch` (tensor indexing only).
- Produces:
  - `def phone_gop(log_probs, span: PhoneSpan) -> float`
  - `def span_argmax_token(log_probs, span: PhoneSpan, tokenizer) -> str`
  - `def gop_to_score(gop: float, tau: float) -> int`
  - `def detect_substitution(expected_ipa: str, argmax_ipa: str) -> str | None`
  - `def word_accuracy(phone_scores: list[int]) -> int`
  - `def sentence_accuracy(word_scores: list[int], phone_counts: list[int]) -> int`
  - `def word_detected(phone_gops: list[float], detect_gop: float) -> bool`
  - `def completeness(detected: list[bool]) -> int`

`phone_gop` uses the **raw** span, not the expanded one. The expanded span is mostly blanks; scoring
over it would penalise every phone in the utterance equally.

**Step 1.** Write the failing test. `sidecar/pron/tests/test_gop.py`:

```python
"""GOP arithmetic. Recon measured gop == 0.000 for a correctly produced phone
and -2.147 for a substituted one, with the span argmax naming the substitute --
that argmax is the only producer of the report's `substituted` field.
"""

import pytest
import torch

from app.align import PhoneSpan
from app.gop import (
    completeness,
    detect_substitution,
    gop_to_score,
    phone_gop,
    sentence_accuracy,
    span_argmax_token,
    word_accuracy,
    word_detected,
)


class FakeTokenizer:
    pad_token_id = 0
    _ids = {0: "<pad>", 1: "\u0283", 2: "i\u02d0", 3: "\u026a", 4: "p"}

    def convert_ids_to_tokens(self, index):
        return self._ids[index]


def _log_probs(path: list[int], classes: int = 5) -> torch.Tensor:
    logits = torch.full((1, len(path), classes), -10.0)
    for frame, token in enumerate(path):
        logits[0, frame, token] = 10.0
    return torch.log_softmax(logits, dim=-1)


def _span(token_id: int, ipa: str, raw_start: int, raw_end: int) -> PhoneSpan:
    return PhoneSpan(
        token_id=token_id,
        ipa=ipa,
        raw_start=raw_start,
        raw_end=raw_end,
        start=0,
        end=raw_end,
        ctc_score=1.0,
    )


def test_phone_gop_is_zero_when_the_expected_phone_dominates_its_span():
    log_probs = _log_probs([0, 1, 0])
    assert phone_gop(log_probs, _span(1, "\u0283", 1, 2)) == pytest.approx(0.0, abs=1e-6)


def test_phone_gop_is_strongly_negative_when_another_phone_dominates():
    log_probs = _log_probs([0, 3, 0])  # the learner produced token 3, we expected token 2
    assert phone_gop(log_probs, _span(2, "i\u02d0", 1, 2)) < -15.0


def test_phone_gop_uses_the_raw_span_not_the_expanded_one():
    log_probs = _log_probs([0, 2, 0, 0])
    good = PhoneSpan(token_id=2, ipa="i\u02d0", raw_start=1, raw_end=2, start=0, end=4, ctc_score=1.0)
    assert phone_gop(log_probs, good) == pytest.approx(0.0, abs=1e-6)


def test_span_argmax_token_names_what_was_actually_produced():
    log_probs = _log_probs([0, 3, 0])
    heard = span_argmax_token(log_probs, _span(2, "i\u02d0", 1, 2), FakeTokenizer())
    assert heard == "\u026a"


def test_span_argmax_token_never_returns_the_blank():
    log_probs = _log_probs([0, 0, 0])
    heard = span_argmax_token(log_probs, _span(2, "i\u02d0", 1, 2), FakeTokenizer())
    assert heard != "<pad>"


def test_gop_to_score_maps_zero_to_one_hundred_and_clamps():
    assert gop_to_score(0.0, 1.0) == 100
    assert gop_to_score(-1.0, 1.0) == 37
    assert gop_to_score(-20.0, 1.0) == 0
    assert gop_to_score(5.0, 1.0) == 100  # never above 100


def test_gop_to_score_is_monotone_and_tau_scales_it():
    assert gop_to_score(-0.5, 1.0) > gop_to_score(-2.0, 1.0)
    assert gop_to_score(-2.0, 2.0) == gop_to_score(-1.0, 1.0)


def test_detect_substitution_only_fires_on_a_difference():
    assert detect_substitution("i\u02d0", "\u026a") == "\u026a"
    assert detect_substitution("p", "p") is None


def test_word_accuracy_is_the_mean_phone_score():
    assert word_accuracy([100, 60]) == 80
    assert word_accuracy([90, 5, 82]) == 59
    assert word_accuracy([]) == 0


def test_sentence_accuracy_weights_words_by_phone_count():
    assert sentence_accuracy([80, 59], [2, 3]) == 67
    assert sentence_accuracy([], []) == 0


def test_word_detected_thresholds_on_the_mean_gop():
    assert word_detected([-0.1, -0.2], -5.0) is True
    assert word_detected([-9.0, -8.0], -5.0) is False


def test_completeness_is_the_share_of_detected_words():
    assert completeness([True, True, False]) == 67
    assert completeness([True, True]) == 100
    assert completeness([]) == 0
```

**Step 2.** Run and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_gop.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.gop'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/gop.py`:

```python
"""Goodness of Pronunciation and its aggregation.

gop = mean over the RAW span of (log p(expected phone) - log p(best phone)).
Range (-inf, 0], 0 = the model agrees the expected phone is the best
explanation of those frames. The raw span matters: the expanded span from
expand_spans is mostly CTC blanks and would push every phone's GOP down.
"""

from __future__ import annotations

import math

from .align import PhoneSpan


def _segment(log_probs, span: PhoneSpan):
    start = int(span.raw_start)
    end = int(span.raw_end)
    if end <= start:
        end = start + 1
    return log_probs[0, start:end]


def phone_gop(log_probs, span: PhoneSpan) -> float:
    segment = _segment(log_probs, span)
    if segment.shape[0] == 0:
        return 0.0
    best = segment.max(dim=-1).values
    return float((segment[:, int(span.token_id)] - best).mean())


def span_argmax_token(log_probs, span: PhoneSpan, tokenizer) -> str:
    segment = _segment(log_probs, span)
    mean = segment.mean(dim=0).clone()
    mean[int(tokenizer.pad_token_id)] = float("-inf")
    return str(tokenizer.convert_ids_to_tokens(int(mean.argmax())))


def gop_to_score(gop: float, tau: float) -> int:
    temperature = tau if tau and tau > 0 else 1.0
    return max(0, min(100, round(100.0 * math.exp(float(gop) / temperature))))


def detect_substitution(expected_ipa: str, argmax_ipa: str) -> str | None:
    if argmax_ipa and argmax_ipa != expected_ipa:
        return argmax_ipa
    return None


def word_accuracy(phone_scores: list[int]) -> int:
    if not phone_scores:
        return 0
    return round(sum(phone_scores) / len(phone_scores))


def sentence_accuracy(word_scores: list[int], phone_counts: list[int]) -> int:
    total = sum(phone_counts)
    if total == 0:
        return 0
    weighted = sum(score * count for score, count in zip(word_scores, phone_counts))
    return round(weighted / total)


def word_detected(phone_gops: list[float], detect_gop: float) -> bool:
    if not phone_gops:
        return False
    return (sum(phone_gops) / len(phone_gops)) > detect_gop


def completeness(detected: list[bool]) -> int:
    if not detected:
        return 0
    return round(100 * sum(1 for flag in detected if flag) / len(detected))
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_gop.py -q
```

Expected: `12 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/gop.py sidecar/pron/tests/test_gop.py
git diff --cached --name-only
git commit -m "feat(pron): GOP scoring, substitution detection, and score aggregation"
```

---

### Task 10: `fluency.py` — VAD, pauses, articulation rate, fluency score

The alignment carries **no** pause information (its spans are 20 ms spikes). Fluency therefore comes
from an independent energy pass over the decoded PCM, never from the alignment.

**Files:**
- Create: `sidecar/pron/app/fluency.py`
- Test: `sidecar/pron/tests/test_fluency.py`

**Interfaces:**
- Consumes: `numpy`.
- Produces:
  - `@dataclass(frozen=True) class Prosody` with `speech_rate_wpm, articulation_rate_syll_per_sec, pause_count, pause_total_sec, f0_min_hz, f0_max_hz, f0_range_semitones`
  - `def frame_energy(wav, *, frame_ms=20.0, sample_rate=16000) -> np.ndarray`
  - `def voiced_mask(energy, *, rel_threshold=0.15) -> np.ndarray`
  - `def find_pauses(mask, *, frame_ms=20.0, min_pause_ms=250.0) -> list[tuple[float, float]]`
  - `def compute_prosody(wav, *, word_count, syllable_count, sample_rate=16000) -> Prosody`
  - `def fluency_score(prosody, *, pause_budget_sec=1.5, rate_lo=3.0, rate_hi=5.5) -> int`

**UNVERIFIED — do not implement in Stage 1 (contract §10 V2).** F0 tracking. The three `f0_*` fields
exist in the frozen schema so Stage 2 needs no migration, and they are emitted as JSON `null`.
Before Stage 2 adds them, verify `torchaudio.functional.detect_pitch_frequency`'s signature and
behaviour against live docs — recon did not.

**Step 1.** Write the failing test. `sidecar/pron/tests/test_fluency.py`:

```python
"""Fluency comes from an energy VAD over the decoded PCM, not from the CTC
alignment -- the alignment's 20 ms spans carry no pause information at all.
"""

import numpy as np
import pytest

from app.fluency import (
    Prosody,
    compute_prosody,
    find_pauses,
    fluency_score,
    frame_energy,
    voiced_mask,
)


def _signal(segments, sample_rate: int = 16000) -> np.ndarray:
    """segments: list of (seconds, amplitude)."""
    parts = []
    for seconds, amplitude in segments:
        count = int(seconds * sample_rate)
        t = np.arange(count) / sample_rate
        parts.append((amplitude * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32))
    return np.concatenate(parts).astype(np.float32)


def test_frame_energy_produces_one_rms_value_per_20ms_frame():
    energy = frame_energy(_signal([(1.0, 0.5)]))
    assert energy.shape == (50,)
    assert float(energy.mean()) == pytest.approx(0.3536, abs=0.02)  # RMS of a 0.5 sine


def test_voiced_mask_separates_tone_from_silence():
    mask = voiced_mask(frame_energy(_signal([(0.4, 0.5), (0.4, 0.0)])))
    assert bool(mask[:15].all()) is True
    assert bool(mask[-15:].any()) is False


def test_find_pauses_reports_one_internal_pause_with_its_span():
    mask = voiced_mask(frame_energy(_signal([(0.5, 0.5), (0.6, 0.0), (0.5, 0.5)])))
    pauses = find_pauses(mask)
    assert len(pauses) == 1
    start, end = pauses[0]
    assert start == pytest.approx(0.5, abs=0.06)
    assert end - start == pytest.approx(0.6, abs=0.08)


def test_find_pauses_ignores_leading_and_trailing_silence():
    mask = voiced_mask(frame_energy(_signal([(0.5, 0.0), (0.5, 0.5), (0.5, 0.0)])))
    assert find_pauses(mask) == []


def test_find_pauses_ignores_gaps_below_the_minimum():
    mask = voiced_mask(frame_energy(_signal([(0.4, 0.5), (0.1, 0.0), (0.4, 0.5)])))
    assert find_pauses(mask) == []


def test_compute_prosody_derives_rates_from_the_waveform():
    wav = _signal([(0.5, 0.5), (0.6, 0.0), (0.5, 0.5)])  # 1.6 s total, ~1.0 s voiced
    prosody = compute_prosody(wav, word_count=2, syllable_count=3)

    assert prosody.speech_rate_wpm == pytest.approx(75.0, abs=1.0)
    assert prosody.articulation_rate_syll_per_sec == pytest.approx(3.0, abs=0.4)
    assert prosody.pause_count == 1
    assert prosody.pause_total_sec == pytest.approx(0.6, abs=0.08)
    assert prosody.f0_min_hz is None
    assert prosody.f0_max_hz is None
    assert prosody.f0_range_semitones is None


def _prosody(pause_total_sec: float, rate: float) -> Prosody:
    return Prosody(
        speech_rate_wpm=120.0,
        articulation_rate_syll_per_sec=rate,
        pause_count=1,
        pause_total_sec=pause_total_sec,
        f0_min_hz=None,
        f0_max_hz=None,
        f0_range_semitones=None,
    )


def test_fluency_score_is_one_hundred_for_no_pauses_at_a_normal_rate():
    assert fluency_score(_prosody(0.0, 4.0)) == 100


def test_fluency_score_spends_the_whole_pause_budget():
    assert fluency_score(_prosody(1.5, 4.0)) == 40
    assert fluency_score(_prosody(9.0, 4.0)) == 40  # penalty is capped at 1.0


def test_fluency_score_penalises_speaking_too_slowly_and_too_fast():
    assert fluency_score(_prosody(0.0, 1.5)) == 80  # (3.0-1.5)/3.0 = 0.5 -> -20
    assert fluency_score(_prosody(0.0, 11.0)) == 60  # (11-5.5)/5.5 = 1.0 -> -40


def test_fluency_score_never_leaves_the_zero_to_one_hundred_range():
    assert 0 <= fluency_score(_prosody(99.0, 99.0)) <= 100
```

**Step 2.** Run and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_fluency.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.fluency'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/fluency.py`:

```python
"""Energy VAD -> pauses, rates, fluency.

The CTC alignment cannot supply any of this: every span it produces is a ~20 ms
onset spike, so pauses and articulation rate are measured directly from the
decoded PCM.

f0_* are None in Stage 1 and are emitted as JSON null. They exist in the frozen
schema today so Stage 2's pitch tracker needs no schema migration -- and that
tracker's API has NOT been verified, so nothing pitch-related is implemented here.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Prosody:
    speech_rate_wpm: float
    articulation_rate_syll_per_sec: float
    pause_count: int
    pause_total_sec: float
    f0_min_hz: float | None
    f0_max_hz: float | None
    f0_range_semitones: float | None


def frame_energy(wav: np.ndarray, *, frame_ms: float = 20.0, sample_rate: int = 16000) -> np.ndarray:
    size = max(1, int(sample_rate * frame_ms / 1000.0))
    count = len(wav) // size
    if count == 0:
        return np.zeros(0, dtype=np.float32)
    frames = np.asarray(wav[: count * size], dtype=np.float32).reshape(count, size)
    return np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1)).astype(np.float32)


def voiced_mask(energy: np.ndarray, *, rel_threshold: float = 0.15) -> np.ndarray:
    if energy.size == 0:
        return np.zeros(0, dtype=bool)
    reference = float(np.percentile(energy, 95))
    if reference <= 0.0:
        return np.zeros(energy.size, dtype=bool)
    return energy > (rel_threshold * reference)


def find_pauses(
    mask: np.ndarray, *, frame_ms: float = 20.0, min_pause_ms: float = 250.0
) -> list[tuple[float, float]]:
    if mask.size == 0 or not mask.any():
        return []

    voiced = np.flatnonzero(mask)
    first, last = int(voiced[0]), int(voiced[-1])
    seconds_per_frame = frame_ms / 1000.0
    min_frames = max(1, int(round(min_pause_ms / frame_ms)))

    pauses: list[tuple[float, float]] = []
    run_start: int | None = None
    for index in range(first, last + 1):
        if not mask[index]:
            if run_start is None:
                run_start = index
            continue
        if run_start is not None:
            if index - run_start >= min_frames:
                pauses.append(
                    (
                        round(run_start * seconds_per_frame, 3),
                        round(index * seconds_per_frame, 3),
                    )
                )
            run_start = None
    return pauses


def compute_prosody(
    wav: np.ndarray, *, word_count: int, syllable_count: int, sample_rate: int = 16000
) -> Prosody:
    energy = frame_energy(wav, sample_rate=sample_rate)
    mask = voiced_mask(energy)
    pauses = find_pauses(mask)

    voiced_seconds = float(mask.sum()) * 0.02
    total_seconds = float(len(wav)) / sample_rate
    pause_total = sum(end - start for start, end in pauses)

    return Prosody(
        speech_rate_wpm=round(word_count / max(total_seconds, 1e-6) * 60.0, 3),
        articulation_rate_syll_per_sec=round(syllable_count / max(voiced_seconds, 1e-6), 3),
        pause_count=len(pauses),
        pause_total_sec=round(pause_total, 3),
        f0_min_hz=None,
        f0_max_hz=None,
        f0_range_semitones=None,
    )


def fluency_score(
    prosody: Prosody, *, pause_budget_sec: float = 1.5, rate_lo: float = 3.0, rate_hi: float = 5.5
) -> int:
    pause_penalty = min(1.0, prosody.pause_total_sec / pause_budget_sec)

    rate = prosody.articulation_rate_syll_per_sec
    if rate < rate_lo:
        rate_penalty = min(1.0, (rate_lo - rate) / rate_lo)
    elif rate > rate_hi:
        rate_penalty = min(1.0, (rate - rate_hi) / rate_hi)
    else:
        rate_penalty = 0.0

    score = round(100 * (1 - 0.6 * pause_penalty - 0.4 * rate_penalty))
    return max(0, min(100, score))
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_fluency.py -q
```

Expected: `11 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/fluency.py sidecar/pron/tests/test_fluency.py
git diff --cached --name-only
git commit -m "feat(pron): energy VAD prosody and the fluency score"
```

---

### Task 11: `report.py` — assemble the frozen `PronunciationReport`

**Files:**
- Create: `sidecar/pron/app/report.py`
- Test: `sidecar/pron/tests/test_report.py`

**Interfaces:**
- Consumes: `app.align.PhoneSpan`, `app.align.frames_to_seconds`, `app.align.unflatten`, `app.fluency.Prosody`, and `gop_to_score`, `word_accuracy`, `sentence_accuracy`, `word_detected`, `completeness` from `app.gop`.
- Produces:
  - `def build_report(*, words, phone_lists, phone_spans, phone_gops, phone_subs, sec_per_frame, prosody, fluency, model_id, mode, tau, detect_gop) -> dict`
  - `def strip_phones(report: dict) -> dict`

Invariant I1 is the one to get right: when a phone was produced as expected the `substituted` key is
**absent**. `"substituted": null` is a contract violation at every layer, and the test below asserts
against it.

**Step 1.** Write the failing test. `sidecar/pron/tests/test_report.py`:

```python
"""The assembled report must satisfy the frozen v1 JSON Schema plus the
invariants the schema cannot express (contract section 5.1).
"""

import jsonschema
import pytest

from app.align import PhoneSpan
from app.fluency import Prosody
from app.report import build_report, strip_phones

PRONUNCIATION_REPORT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://speakup.local/schemas/pronunciation-report-v1.json",
    "title": "PronunciationReport",
    "type": "object",
    "additionalProperties": False,
    "required": ["version", "mode", "model", "overall", "prosody", "words"],
    "properties": {
        "version": {"type": "integer", "const": 1},
        "mode": {"type": "string", "enum": ["scripted", "unscripted"]},
        "pronProvider": {"type": "string", "enum": ["local", "mock", "azure"]},
        "model": {"type": "string", "minLength": 1},
        "durationSec": {"type": "number", "minimum": 0},
        "sampleRate": {"type": "integer", "const": 16000},
        "overall": {
            "type": "object",
            "additionalProperties": False,
            "required": ["accuracy", "fluency", "completeness"],
            "properties": {
                "accuracy": {"type": "integer", "minimum": 0, "maximum": 100},
                "fluency": {"type": "integer", "minimum": 0, "maximum": 100},
                "completeness": {"type": "integer", "minimum": 0, "maximum": 100},
            },
        },
        "prosody": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "speechRateWpm",
                "articulationRateSyllPerSec",
                "pauseCount",
                "pauseTotalSec",
                "f0MinHz",
                "f0MaxHz",
                "f0RangeSemitones",
            ],
            "properties": {
                "speechRateWpm": {"type": "number", "minimum": 0},
                "articulationRateSyllPerSec": {"type": "number", "minimum": 0},
                "pauseCount": {"type": "integer", "minimum": 0},
                "pauseTotalSec": {"type": "number", "minimum": 0},
                "f0MinHz": {"type": ["number", "null"], "minimum": 0},
                "f0MaxHz": {"type": ["number", "null"], "minimum": 0},
                "f0RangeSemitones": {"type": ["number", "null"], "minimum": 0},
            },
        },
        "words": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["word", "start", "end", "accuracy"],
                "properties": {
                    "word": {"type": "string", "minLength": 1},
                    "start": {"type": "number", "minimum": 0},
                    "end": {"type": "number", "minimum": 0},
                    "accuracy": {"type": "integer", "minimum": 0, "maximum": 100},
                    "phones": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["ipa", "score", "start", "end"],
                            "properties": {
                                "ipa": {"type": "string", "minLength": 1},
                                "score": {"type": "integer", "minimum": 0, "maximum": 100},
                                "start": {"type": "number", "minimum": 0},
                                "end": {"type": "number", "minimum": 0},
                                "substituted": {"type": "string", "minLength": 1},
                            },
                        },
                    },
                },
            },
        },
    },
}

WORDS = ["the", "sheep"]
PHONE_LISTS = [["\u00f0", "\u0259"], ["\u0283", "i\u02d0", "p"]]
FRAMES = [(0, 5), (5, 10), (10, 15), (15, 25), (25, 33)]
IPA_FLAT = ["\u00f0", "\u0259", "\u0283", "i\u02d0", "p"]
GOPS = [0.0, -0.51, -0.1, -3.0, -0.2]
SUBS = [None, None, None, "\u026a", None]

PROSODY = Prosody(
    speech_rate_wpm=132.5,
    articulation_rate_syll_per_sec=4.2,
    pause_count=1,
    pause_total_sec=0.31,
    f0_min_hz=None,
    f0_max_hz=None,
    f0_range_semitones=None,
)


def _spans():
    return [
        PhoneSpan(
            token_id=index,
            ipa=ipa,
            raw_start=start,
            raw_end=start + 1,
            start=start,
            end=end,
            ctc_score=0.9,
        )
        for index, (ipa, (start, end)) in enumerate(zip(IPA_FLAT, FRAMES))
    ]


def _report(mode: str = "scripted"):
    return build_report(
        words=WORDS,
        phone_lists=PHONE_LISTS,
        phone_spans=_spans(),
        phone_gops=GOPS,
        phone_subs=SUBS,
        sec_per_frame=0.02,
        prosody=PROSODY,
        fluency=84,
        model_id="facebook/wav2vec2-lv-60-espeak-cv-ft",
        mode=mode,
        tau=1.0,
        detect_gop=-5.0,
    )


def test_report_validates_against_the_frozen_v1_schema():
    jsonschema.validate(_report(), PRONUNCIATION_REPORT_SCHEMA)


def test_envelope_carries_the_sidecar_only_fields_and_no_pron_provider():
    report = _report()
    assert report["version"] == 1
    assert report["mode"] == "scripted"
    assert report["model"] == "facebook/wav2vec2-lv-60-espeak-cv-ft"
    assert report["sampleRate"] == 16000
    assert report["durationSec"] == 0.66
    assert "pronProvider" not in report  # invariant I7: the Node layer adds it


def test_scores_are_the_gop_mapping_aggregated_by_phone_count():
    report = _report()
    assert [p["score"] for p in report["words"][0]["phones"]] == [100, 60]
    assert [p["score"] for p in report["words"][1]["phones"]] == [90, 5, 82]
    assert report["words"][0]["accuracy"] == 80
    assert report["words"][1]["accuracy"] == 59
    assert report["overall"]["accuracy"] == 67
    assert report["overall"]["fluency"] == 84
    assert report["overall"]["completeness"] == 100


def test_substituted_is_absent_never_null_when_the_phone_was_correct():
    phones = [p for word in _report()["words"] for p in word["phones"]]
    correct = [p for p in phones if p["ipa"] != "i\u02d0"]
    assert all("substituted" not in p for p in correct)
    heard = [p for p in phones if p["ipa"] == "i\u02d0"][0]
    assert heard["substituted"] == "\u026a"


def test_word_bounds_match_their_first_and_last_phone():
    for word in _report()["words"]:
        assert word["start"] == word["phones"][0]["start"]
        assert word["end"] == word["phones"][-1]["end"]
        assert word["end"] >= word["start"]


def test_phone_spans_are_contiguous_and_ascending():
    phones = [p for word in _report()["words"] for p in word["phones"]]
    for current, following in zip(phones, phones[1:]):
        assert current["end"] == following["start"]


def test_prosody_is_copied_across_with_null_f0():
    prosody = _report()["prosody"]
    assert prosody["speechRateWpm"] == 132.5
    assert prosody["articulationRateSyllPerSec"] == 4.2
    assert prosody["pauseCount"] == 1
    assert prosody["pauseTotalSec"] == 0.31
    assert prosody["f0MinHz"] is None
    assert prosody["f0MaxHz"] is None
    assert prosody["f0RangeSemitones"] is None


def test_strip_phones_removes_every_phone_row_without_mutating_the_input():
    report = _report()
    stripped = strip_phones(report)

    assert all("phones" not in word for word in stripped["words"])
    assert all("phones" in word for word in report["words"])
    jsonschema.validate(stripped, PRONUNCIATION_REPORT_SCHEMA)


def test_build_report_refuses_misaligned_inputs():
    with pytest.raises(ValueError):
        build_report(
            words=WORDS,
            phone_lists=PHONE_LISTS,
            phone_spans=_spans()[:4],
            phone_gops=GOPS,
            phone_subs=SUBS,
            sec_per_frame=0.02,
            prosody=PROSODY,
            fluency=84,
            model_id="m",
            mode="scripted",
            tau=1.0,
            detect_gop=-5.0,
        )
```

**Step 2.** Run and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_report.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.report'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/report.py`:

```python
"""Assembles the frozen PronunciationReport v1 (interface contract section 5).

Invariant I1: "substituted" is ABSENT when the phone was produced as expected.
Emitting "substituted": null is a contract violation -- the client's ranking
rule treats presence as evidence, so a null would fabricate an error.
"""

from __future__ import annotations

from .align import PhoneSpan, frames_to_seconds, unflatten
from .fluency import Prosody
from .gop import completeness, gop_to_score, sentence_accuracy, word_accuracy, word_detected

REPORT_VERSION = 1
SAMPLE_RATE = 16000


def build_report(
    *,
    words: list[str],
    phone_lists: list[list[str]],
    phone_spans: list[PhoneSpan],
    phone_gops: list[float],
    phone_subs: list[str | None],
    sec_per_frame: float,
    prosody: Prosody,
    fluency: int,
    model_id: str,
    mode: str,
    tau: float,
    detect_gop: float,
) -> dict:
    if not words:
        raise ValueError("build_report: at least one word is required")
    if len(words) != len(phone_lists):
        raise ValueError(
            f"build_report: {len(words)} words but {len(phone_lists)} phone lists"
        )

    counts = [len(tokens) for tokens in phone_lists]
    if not (len(phone_spans) == len(phone_gops) == len(phone_subs) == sum(counts)):
        raise ValueError(
            "build_report: spans/gops/subs must line up with the per-word phone counts"
        )

    span_groups = unflatten(list(phone_spans), counts)
    gop_groups = unflatten(list(phone_gops), counts)
    sub_groups = unflatten(list(phone_subs), counts)

    out_words: list[dict] = []
    word_scores: list[int] = []
    detected: list[bool] = []

    for word, spans, gops, subs in zip(words, span_groups, gop_groups, sub_groups):
        phones: list[dict] = []
        scores: list[int] = []
        for span, gop, substituted in zip(spans, gops, subs):
            score = gop_to_score(gop, tau)
            phone = {
                "ipa": span.ipa,
                "score": score,
                "start": frames_to_seconds(span.start, sec_per_frame),
                "end": frames_to_seconds(span.end, sec_per_frame),
            }
            if substituted:
                phone["substituted"] = substituted
            phones.append(phone)
            scores.append(score)

        accuracy = word_accuracy(scores)
        out_words.append(
            {
                "word": word,
                "start": phones[0]["start"],
                "end": phones[-1]["end"],
                "accuracy": accuracy,
                "phones": phones,
            }
        )
        word_scores.append(accuracy)
        detected.append(word_detected(list(gops), detect_gop))

    duration_sec = frames_to_seconds(phone_spans[-1].end, sec_per_frame)

    return {
        "version": REPORT_VERSION,
        "mode": mode,
        "model": model_id,
        "durationSec": duration_sec,
        "sampleRate": SAMPLE_RATE,
        "overall": {
            "accuracy": sentence_accuracy(word_scores, counts),
            "fluency": int(fluency),
            "completeness": completeness(detected),
        },
        "prosody": {
            "speechRateWpm": prosody.speech_rate_wpm,
            "articulationRateSyllPerSec": prosody.articulation_rate_syll_per_sec,
            "pauseCount": prosody.pause_count,
            "pauseTotalSec": prosody.pause_total_sec,
            "f0MinHz": prosody.f0_min_hz,
            "f0MaxHz": prosody.f0_max_hz,
            "f0RangeSemitones": prosody.f0_range_semitones,
        },
        "words": out_words,
    }


def strip_phones(report: dict) -> dict:
    """Defence in depth -- the Node route strips too, for every provider."""
    out = dict(report)
    out["words"] = [
        {key: value for key, value in word.items() if key != "phones"}
        for word in report.get("words", [])
    ]
    return out
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_report.py -q
```

Expected: `9 passed`.

**Step 5.** Commit:

```powershell
git add sidecar/pron/app/report.py sidecar/pron/tests/test_report.py
git diff --cached --name-only
git commit -m "feat(pron): report assembly against the frozen v1 schema"
```

---

### Task 12: `main.py` — the FastAPI `/assess` and `/health` endpoints

**Files:**
- Create: `sidecar/pron/app/main.py`
- Test: `sidecar/pron/tests/test_main.py`

**Interfaces:**
- Consumes: every `app.*` module; `fastapi`, `anyio.to_thread`.
- Produces:
  - `app: FastAPI`
  - `def run_pipeline(raw: bytes, text: str, mode: str) -> dict`
  - `async def assess(audio, text, mode="scripted") -> dict` at `POST /assess`
  - `async def health() -> dict` at `GET /health`

`run_pipeline` is synchronous and runs through `anyio.to_thread.run_sync` so torch never blocks the
event loop. Tests monkeypatch `main.run_pipeline` — the name is resolved from module globals at call
time, so patching it works.

**Step 1.** Write the failing test. `sidecar/pron/tests/test_main.py`:

```python
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
            "phones": [{"ipa": "\u0283", "score": 90, "start": 0.0, "end": 0.66}],
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
```

**Step 2.** Run and watch it fail:

```powershell
python -m pytest sidecar/pron/tests/test_main.py -q
```

Expected:

```
E   ModuleNotFoundError: No module named 'app.main'
1 error in 0.Xs
```

**Step 3.** Implement `sidecar/pron/app/main.py`:

```python
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
```

**Step 4.** Run again:

```powershell
python -m pytest sidecar/pron/tests/test_main.py -q
```

Expected: `15 passed`. (The health test passes on the host as `degraded`, because espeak-ng is not
installed there — `test_health_reports_every_capability_flag` only asserts the value is one of
`{"ok", "degraded"}`.)

**Step 5.** Run the whole host suite:

```powershell
python -m pytest sidecar/pron/tests -q -m "not integration"
```

Expected: `91 passed, 3 deselected` — 5 config + 7 errors + 6 audio + 6 g2p + 6 acoustic + 14 align
+ 12 gop + 11 fluency + 9 report + 15 main, with the three espeak-only g2p cases deselected. What
matters is zero failures; the total shifts if you added cases.

**Step 6.** Commit:

```powershell
git add sidecar/pron/app/main.py sidecar/pron/tests/test_main.py
git diff --cached --name-only
git commit -m "feat(pron): FastAPI /assess and /health for the sidecar"
```

---

### Task 13: Run the sidecar with one documented command

**Files:**
- Modify: `README.md`
- Test: `sidecar/pron/tests/test_main.py` is re-run inside the image (no new test file)

**Interfaces:**
- Consumes: the image from Task 4, `app.main:app`.
- Produces: a documented `docker run` invocation and a warm model volume.

**Step 1.** Rebuild the image so it contains every module written since Task 4:

```powershell
docker build -t speakup-pron sidecar/pron
```

**Step 2.** Run the full suite inside the image — this is the first time the integration lane runs
end to end:

```powershell
docker run --rm -v speakup-pron-models:/models speakup-pron python -m pytest tests -q
```

Expected: all tests pass, `0 skipped` (espeak-ng is present in the image, so nothing skips).

**Step 3.** Warm the model cache into the named volume so the first real request is not a 1.2 GB
download:

```powershell
docker run --rm -v speakup-pron-models:/models speakup-pron python -c "from app.acoustic import get_model; from app.config import SETTINGS; get_model(SETTINGS.model_id, SETTINGS.device); print('model cached')"
```

Expected last line: `model cached`.

**Step 4.** Start the sidecar:

```powershell
docker run --rm -d --name speakup-pron -p 8899:8899 -v speakup-pron-models:/models speakup-pron
```

Wait for the model to load (first `/health` may answer before it does — `modelLoaded` is the flag to
watch), then:

```powershell
Invoke-RestMethod http://localhost:8899/health | ConvertTo-Json -Compress
```

Expected, with `ts` differing:

```json
{"status":"ok","model":"facebook/wav2vec2-lv-60-espeak-cv-ft","modelLoaded":false,"alignAvailable":true,"espeakAvailable":true,"ffmpegAvailable":true,"ts":1785484800000}
```

`status` must be `ok`. If it is `degraded`, read which flag is `false` — that flag names the missing
system dependency, and the Node server will fall back to listen-and-repeat rather than scoring.

Check the container's own healthcheck resolved:

```powershell
docker inspect --format "{{.State.Health.Status}}" speakup-pron
```

Expected: `healthy` (allow up to the 120 s start period).

**Step 5.** Stop it:

```powershell
docker stop speakup-pron
```

**Step 6.** Document it. Append this section to `README.md`, immediately before the final section of
the file:

````markdown
## Pronunciation sidecar (M7)

Phoneme-level scoring runs in its own container — Python, FastAPI, wav2vec2 +
espeak-ng — reachable at `http://localhost:8899`. The Node server talks to it
over HTTP and degrades to listen-and-repeat when it is not running, so the
sidecar is optional for day-to-day development.

```powershell
# build once (~10 min cold; downloads torch CPU wheels)
docker build -t speakup-pron sidecar/pron

# a named volume keeps the 1.2 GB of model weights out of the image
docker volume create speakup-pron-models

# run it
docker run --rm -d --name speakup-pron -p 8899:8899 -v speakup-pron-models:/models speakup-pron

# check it
Invoke-RestMethod http://localhost:8899/health

# stop it
docker stop speakup-pron
```

Then point the API server at it in `server/.env`:

```
PRON_PROVIDER=local
PRON_URL=http://localhost:8899
```

`GET /health` returns HTTP 200 whether the sidecar is healthy or degraded, so
`status` (`"ok"` or `"degraded"`) plus the `alignAvailable` / `espeakAvailable` /
`ffmpegAvailable` flags tell you exactly which system dependency is missing.

Sidecar tests:

```powershell
docker run --rm speakup-pron python -m pytest tests -q          # everything
python -m pytest sidecar/pron/tests -q -m "not integration"     # host lane, no Docker
```

Licences: the sidecar bundles phonemizer and espeak-ng (both GPL-3.0) alongside
torch/torchaudio (BSD-3), transformers (Apache-2.0) and Apache-2.0 model
weights. It is distributed as a separate container invoked over HTTP.
````

**Step 7.** Commit:

```powershell
git add README.md
git diff --cached --name-only
git commit -m "docs(pron): document building and running the pronunciation sidecar"
```

---

### Task 14: Golden fixtures and the end-to-end integration test

**Files:**
- Create: `sidecar/pron/tests/fixtures/sheep.wav`
- Create: `sidecar/pron/tests/fixtures/ship.wav`
- Create: `sidecar/pron/tests/fixtures/silence.wav`
- Create: `sidecar/pron/tests/fixtures/expected_sheep.json`
- Test: `sidecar/pron/tests/test_main.py` (append)

**Interfaces:**
- Consumes: the real pipeline through `TestClient`.
- Produces: no new symbols; three 16 kHz mono golden clips and one tolerance-compared golden report.

The clips are synthesised with espeak-ng inside the image: offline, deterministic, byte-identical on
every machine, and no recorded human voice enters the repo.

**Step 1.** Generate the fixtures. Run from the repo root in PowerShell:

```powershell
docker run --rm -v "${PWD}/sidecar/pron/tests/fixtures:/out" --entrypoint bash speakup-pron -lc "set -e; espeak-ng -v en-us -s 130 -w /tmp/sheep_raw.wav 'the sheep'; espeak-ng -v en-us -s 130 -w /tmp/ship_raw.wav 'the ship'; ffmpeg -y -loglevel error -i /tmp/sheep_raw.wav -ac 1 -ar 16000 -acodec pcm_s16le /out/sheep.wav; ffmpeg -y -loglevel error -i /tmp/ship_raw.wav -ac 1 -ar 16000 -acodec pcm_s16le /out/ship.wav; ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -acodec pcm_s16le /out/silence.wav; ls -l /out"
```

(Git Bash: replace `${PWD}` with `$PWD`.)

Expected: three files listed, each a few tens of kilobytes except `silence.wav` at ~32 KB. Verify
the format:

```powershell
python -c "import wave; [print(n, (lambda w: (w.getnchannels(), w.getframerate(), w.getnframes()))(wave.open('sidecar/pron/tests/fixtures/'+n))) for n in ['sheep.wav','ship.wav','silence.wav']]"
```

Expected: each tuple is `(1, 16000, <frames>)` — mono, 16 kHz — and `silence.wav` shows exactly
`16000` frames.

**Step 2.** Append the integration tests to `sidecar/pron/tests/test_main.py`:

```python
@pytest.mark.integration
def test_silence_is_rejected_with_no_speech(client):
    response = client.post(
        "/assess",
        files={"audio": ("silence.wav", (FIXTURES / "silence.wav").read_bytes(), "audio/wav")},
        data={"text": "the sheep"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "NO_SPEECH"


@pytest.mark.integration
def test_unpronounceable_reference_text_is_rejected(client):
    response = client.post(
        "/assess",
        files={"audio": ("sheep.wav", (FIXTURES / "sheep.wav").read_bytes(), "audio/wav")},
        data={"text": "!!! ??? ..."},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "UNPRONOUNCEABLE_TEXT"


@pytest.mark.integration
def test_unscripted_mode_strips_every_phone_row(client):
    response = client.post(
        "/assess",
        files={"audio": ("sheep.wav", (FIXTURES / "sheep.wav").read_bytes(), "audio/wav")},
        data={"text": "the sheep", "mode": "unscripted"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "unscripted"
    assert all("phones" not in word for word in body["words"])


@pytest.mark.integration
def test_golden_sheep_report_matches_the_recorded_baseline(client):
    expected = json.loads((FIXTURES / "expected_sheep.json").read_text(encoding="utf-8"))

    response = client.post(
        "/assess",
        files={"audio": ("sheep.wav", (FIXTURES / "sheep.wav").read_bytes(), "audio/wav")},
        data={"text": "the sheep"},
    )
    assert response.status_code == 200
    body = response.json()

    assert body["version"] == expected["version"]
    assert body["mode"] == expected["mode"]
    assert body["model"] == expected["model"]
    assert body["sampleRate"] == 16000
    assert body["durationSec"] == pytest.approx(expected["durationSec"], abs=0.05)
    assert [w["word"] for w in body["words"]] == [w["word"] for w in expected["words"]]

    for got_word, want_word in zip(body["words"], expected["words"]):
        assert [p["ipa"] for p in got_word["phones"]] == [p["ipa"] for p in want_word["phones"]]
        assert got_word["accuracy"] == pytest.approx(want_word["accuracy"], abs=10)
        for got_phone, want_phone in zip(got_word["phones"], want_word["phones"]):
            assert got_phone["score"] == pytest.approx(want_phone["score"], abs=15)

    for key in ("accuracy", "fluency", "completeness"):
        assert body["overall"][key] == pytest.approx(expected["overall"][key], abs=10)


@pytest.mark.integration
def test_the_wrong_vowel_scores_lower_than_the_right_one(client):
    """`ship` audio against a `sheep` reference must not score as well as `sheep` does."""

    def score(fixture: str) -> int:
        response = client.post(
            "/assess",
            files={"audio": (fixture, (FIXTURES / fixture).read_bytes(), "audio/wav")},
            data={"text": "the sheep"},
        )
        assert response.status_code == 200
        phones = [p for w in response.json()["words"] for p in w["phones"]]
        return [p for p in phones if p["ipa"] == "i\u02d0"][0]["score"]

    assert score("ship.wav") < score("sheep.wav")
```

**Step 3.** Rebuild and run the integration lane. `expected_sheep.json` does not exist yet, so the
golden test must fail:

```powershell
docker build -t speakup-pron sidecar/pron
docker run --rm -v speakup-pron-models:/models speakup-pron python -m pytest tests/test_main.py -q
```

Expected: four of the five new tests pass and one fails with

```
E   FileNotFoundError: [Errno 2] No such file or directory: '/srv/tests/fixtures/expected_sheep.json'
```

If instead `test_the_wrong_vowel_scores_lower_than_the_right_one` fails, **stop and report it** —
that is the pipeline failing to discriminate the /ɪ/–/iː/ contrast, which is the whole point of the
milestone, and no golden file should be recorded until it holds.

**Step 4.** Record the baseline. Run the real pipeline once and write its output to the fixture:

```powershell
docker run --rm -v speakup-pron-models:/models -v "${PWD}/sidecar/pron/tests/fixtures:/out" speakup-pron python -c "import json; from fastapi.testclient import TestClient; from app.main import app; c=TestClient(app); r=c.post('/assess', files={'audio':('sheep.wav', open('tests/fixtures/sheep.wav','rb').read(),'audio/wav')}, data={'text':'the sheep'}); r.raise_for_status(); open('/out/expected_sheep.json','w',encoding='utf-8').write(json.dumps(r.json(), ensure_ascii=False, indent=2)+'\n'); print(json.dumps(r.json(), ensure_ascii=False, indent=2))"
```

Read the printed report before accepting it. It must show two words (`the`, `sheep`), the phone
sequence `ð ə ʃ iː p`, contiguous phone spans, and scores that are not all 0 and not all 100. If any
of that is wrong, delete `expected_sheep.json` and debug — do not freeze a broken baseline.

**Step 5.** Re-run the integration lane:

```powershell
docker run --rm -v speakup-pron-models:/models speakup-pron python -m pytest tests -q
```

Expected: everything passes, `0 skipped`.

**Step 6.** Re-run the host lane to confirm nothing regressed:

```powershell
python -m pytest sidecar/pron/tests -q -m "not integration"
```

Expected: all pass, integration tests deselected.

**Step 7.** Commit. Note that `git diff --cached --name-only` must list exactly five paths — if the
image left any stray file in `tests/fixtures/`, it would show up here (contract §10 V9):

```powershell
git add sidecar/pron/tests/fixtures/sheep.wav sidecar/pron/tests/fixtures/ship.wav sidecar/pron/tests/fixtures/silence.wav sidecar/pron/tests/fixtures/expected_sheep.json sidecar/pron/tests/test_main.py
git diff --cached --name-only
git commit -m "test(pron): golden espeak fixtures and end-to-end sidecar integration tests"
```

Expected output of `git diff --cached --name-only`:

```
sidecar/pron/tests/fixtures/expected_sheep.json
sidecar/pron/tests/fixtures/sheep.wav
sidecar/pron/tests/fixtures/ship.wav
sidecar/pron/tests/fixtures/silence.wav
sidecar/pron/tests/test_main.py
```
