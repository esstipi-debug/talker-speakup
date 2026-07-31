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
    assert normalize_text("The ship isn't full — of SHEEP!") == [
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
    assert count_syllables([["ð", "ə"], ["ʃ", "iː", "p"]]) == 2
    assert count_syllables([["k", "ɒ", "m", "f", "ə", "t", "ə", "b", "ə", "l"]]) == 4
    assert count_syllables([]) == 0


def test_vowel_inventory_contains_the_drill_targets():
    for vowel in ("ɪ", "iː", "æ", "ə"):
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
    assert out[1][0] == "ʃ"  # sheep starts with the postalveolar fricative


@pytest.mark.integration
@requires_espeak
def test_phonemize_words_emits_no_stress_marks_and_no_delimiters():
    flat = [token for tokens in phonemize_words(["comfortable", "wanted", "judge"]) for token in tokens]
    assert flat
    for token in flat:
        assert "ˈ" not in token  # primary stress
        assert "ˌ" not in token  # secondary stress
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


@pytest.mark.integration
@requires_espeak
def test_get_backend_is_memoized_per_language():
    """Verify that get_backend returns the same object for identical language codes."""
    from app.g2p import get_backend

    first = get_backend("en-us")
    second = get_backend("en-us")
    assert first is second
