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
