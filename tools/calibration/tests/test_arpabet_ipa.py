"""Mapping-table tests (verification step V6)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from arpabet_ipa import (  # noqa: E402
    ARPABET_PHONES,
    ARPABET_TO_IPA,
    IPA_TO_ARPABET,
    align_ipa_to_arpabet,
    arpabet_to_ipa,
    expand_ipa,
    ipa_to_arpabet,
    strip_stress,
)


def test_strip_stress_removes_only_a_trailing_digit():
    assert strip_stress("AA0") == "AA"
    assert strip_stress("IH1") == "IH"
    assert strip_stress("er2") == "ER"
    assert strip_stress("SH") == "SH"
    assert strip_stress(" T ") == "T"
    assert strip_stress("") == ""


def test_every_arpabet_phone_has_a_canonical_ipa_that_maps_back():
    assert len(ARPABET_PHONES) == 39
    for phone in sorted(ARPABET_PHONES):
        ipa = ARPABET_TO_IPA[phone]
        assert ipa, f"{phone} has no canonical IPA"
        assert IPA_TO_ARPABET[ipa] == (phone,), f"{phone} -> {ipa} does not round-trip"


def test_arpabet_to_ipa_handles_stress_and_unknowns():
    assert arpabet_to_ipa("IY1") == "iː"
    assert arpabet_to_ipa("jh0") == "dʒ"
    assert arpabet_to_ipa("QQ") == ""


def test_ipa_to_arpabet_covers_the_multi_phone_espeak_units():
    assert ipa_to_arpabet("ɑːɹ") == ("AA", "R")
    assert ipa_to_arpabet("ɔːɹ") == ("AO", "R")
    assert ipa_to_arpabet("əl") == ("AH", "L")
    assert ipa_to_arpabet("ɚ") == ("ER",)
    assert ipa_to_arpabet("ʃ") == ("SH",)
    assert ipa_to_arpabet("QQQ") == ()


def test_reduced_and_full_vowels_both_land_on_ah():
    # espeak distinguishes ə from ʌ; ARPAbet folds both onto AH (AH0 / AH1).
    assert ipa_to_arpabet("ə") == ("AH",)
    assert ipa_to_arpabet("ʌ") == ("AH",)
    assert ARPABET_TO_IPA["AH"] == "ʌ"


def test_every_mapped_arpabet_phone_is_a_real_arpabet_phone():
    for token, phones in IPA_TO_ARPABET.items():
        assert phones, f"{token} maps to nothing"
        for phone in phones:
            assert phone in ARPABET_PHONES, f"{token} -> {phone} is not ARPAbet"


def test_expand_ipa_records_the_owning_token_per_phone():
    predicted, owners = expand_ipa(["k", "ɑːɹ"])
    assert predicted == ["K", "AA", "R"]
    assert owners == [0, 1, 1]


def test_expand_ipa_marks_unknown_tokens_without_dropping_them():
    predicted, owners = expand_ipa(["s", "QQQ", "t"])
    assert predicted == ["S", "??", "T"]
    assert owners == [0, 1, 2]


def test_align_pairs_one_to_one_when_the_sequences_agree():
    assert align_ipa_to_arpabet(
        ["ð", "ə", "ʃ", "iː", "p"],
        ["DH", "AH0", "SH", "IY1", "P"],
    ) == [(0,), (1,), (2,), (3,), (4,)]


def test_align_gives_a_multi_phone_unit_both_of_its_slots():
    assert align_ipa_to_arpabet(["k", "ɑːɹ"], ["K", "AA1", "R"]) == [(0,), (1, 2)]


def test_align_leaves_a_deleted_phone_unowned():
    # espeak says "stopped" is /s t ɑː p t/; the corpus canonical is S T AA P.
    assert align_ipa_to_arpabet(
        ["s", "t", "ɑː", "p", "t"],
        ["S", "T", "AA1", "P"],
    ) == [(0,), (1,), (2,), (3,), ()]


def test_align_keeps_neighbours_in_step_across_an_unknown_token():
    assert align_ipa_to_arpabet(["s", "QQQ", "t"], ["S", "AH0", "T"]) == [(0,), (), (2,)]


def test_align_still_pairs_a_substituted_phone():
    # A wrong-but-present phone must stay paired: the human scored that slot.
    assert align_ipa_to_arpabet(["ʃ", "ɪ", "p"], ["SH", "IY1", "P"]) == [(0,), (1,), (2,)]


def test_align_of_empty_inputs_is_empty():
    assert align_ipa_to_arpabet([], ["S"]) == []
    assert align_ipa_to_arpabet(["s"], []) == [()]
