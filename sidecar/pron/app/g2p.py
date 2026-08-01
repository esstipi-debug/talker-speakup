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
