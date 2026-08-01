"""ARPAbet <-> espeak-IPA mapping for the calibration harness (verification V6).

speechocean762 scores phones as ARPAbet with a stress digit (`AA0`, `IH1`).
The sidecar reports espeak IPA tokens (`ɑː`, `ɪ`, `dʒ`). Correlating the two
requires an explicit mapping, including the many-to-one cases where a single
espeak token such as `ɑːɹ` covers two ARPAbet phones (`AA R`).

Direction of truth is IPA -> ARPAbet: that is the direction the harness travels,
and the direction that has to handle multi-phone units.
"""

from __future__ import annotations

STRESS_DIGITS = "012"

#: Sentinel emitted by expand_ipa() for a token this table does not know.
UNKNOWN_ARPABET = "??"

#: The 39 stress-free CMUdict / ARPAbet phones.
ARPABET_PHONES = frozenset(
    {
        "AA", "AE", "AH", "AO", "AW", "AY", "B", "CH", "D", "DH",
        "EH", "ER", "EY", "F", "G", "HH", "IH", "IY", "JH", "K",
        "L", "M", "N", "NG", "OW", "OY", "P", "R", "S", "SH",
        "T", "TH", "UH", "UW", "V", "W", "Y", "Z", "ZH",
    }
)

#: Canonical IPA for each ARPAbet phone. Total by construction: one entry per
#: ARPAbet phone, every one of them round-tripping through IPA_TO_ARPABET.
ARPABET_TO_IPA: dict[str, str] = {
    "AA": "ɑː", "AE": "æ", "AH": "ʌ", "AO": "ɔː", "AW": "aʊ",
    "AY": "aɪ", "B": "b", "CH": "tʃ", "D": "d", "DH": "ð",
    "EH": "ɛ", "ER": "ɚ", "EY": "eɪ", "F": "f", "G": "ɡ",
    "HH": "h", "IH": "ɪ", "IY": "iː", "JH": "dʒ", "K": "k",
    "L": "l", "M": "m", "N": "n", "NG": "ŋ", "OW": "oʊ",
    "OY": "ɔɪ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "UH": "ʊ", "UW": "uː", "V": "v",
    "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}

#: espeak IPA token -> the ARPAbet phone sequence it covers.
IPA_TO_ARPABET: dict[str, tuple[str, ...]] = {
    # canonical one-to-one (mirrors ARPABET_TO_IPA)
    "ɑː": ("AA",), "æ": ("AE",), "ʌ": ("AH",), "ɔː": ("AO",), "aʊ": ("AW",),
    "aɪ": ("AY",), "b": ("B",), "tʃ": ("CH",), "d": ("D",), "ð": ("DH",),
    "ɛ": ("EH",), "ɚ": ("ER",), "eɪ": ("EY",), "f": ("F",), "ɡ": ("G",),
    "h": ("HH",), "ɪ": ("IH",), "iː": ("IY",), "dʒ": ("JH",), "k": ("K",),
    "l": ("L",), "m": ("M",), "n": ("N",), "ŋ": ("NG",), "oʊ": ("OW",),
    "ɔɪ": ("OY",), "p": ("P",), "ɹ": ("R",), "s": ("S",), "ʃ": ("SH",),
    "t": ("T",), "θ": ("TH",), "ʊ": ("UH",), "uː": ("UW",), "v": ("V",),
    "w": ("W",), "j": ("Y",), "z": ("Z",), "ʒ": ("ZH",),
    # espeak variants that collapse onto the same ARPAbet phone
    "ə": ("AH",), "ɐ": ("AH",), "ɑ": ("AA",), "ɔ": ("AO",),
    "ɜː": ("ER",), "ɝ": ("ER",), "e": ("EH",), "ᵻ": ("IH",),
    "i": ("IY",), "u": ("UW",), "r": ("R",), "g": ("G",),
    # multi-phone espeak units — the V6 cases
    "ɑːɹ": ("AA", "R"), "ɔːɹ": ("AO", "R"), "oːɹ": ("AO", "R"),
    "ɛɹ": ("EH", "R"), "ɪɹ": ("IH", "R"), "ʊɹ": ("UH", "R"),
    "aɪɚ": ("AY", "ER"), "aʊɚ": ("AW", "ER"),
    "əl": ("AH", "L"), "ən": ("AH", "N"), "əm": ("AH", "M"),
    "iə": ("IY", "AH"),
}


def strip_stress(phone: str) -> str:
    """`"AA0"` -> `"AA"`. Uppercases and trims; a bare `""` stays `""`."""
    cleaned = phone.strip().upper()
    if cleaned and cleaned[-1] in STRESS_DIGITS:
        return cleaned[:-1]
    return cleaned


def arpabet_to_ipa(phone: str) -> str:
    """Canonical IPA for one ARPAbet phone, `""` when the phone is unknown."""
    return ARPABET_TO_IPA.get(strip_stress(phone), "")


def ipa_to_arpabet(token: str) -> tuple[str, ...]:
    """ARPAbet phones covered by one espeak IPA token, `()` when unknown."""
    return IPA_TO_ARPABET.get(token.strip(), ())


def expand_ipa(ipa_tokens: list[str]) -> tuple[list[str], list[int]]:
    """Flatten IPA tokens into predicted ARPAbet phones plus an owner index.

    An unknown token contributes exactly one `UNKNOWN_ARPABET` placeholder so
    the surrounding tokens keep their positions.
    """
    predicted: list[str] = []
    owners: list[int] = []
    for index, token in enumerate(ipa_tokens):
        mapped = ipa_to_arpabet(token) or (UNKNOWN_ARPABET,)
        for phone in mapped:
            predicted.append(phone)
            owners.append(index)
    return predicted, owners


def _nw_align(
    left: list[str],
    right: list[str],
    *,
    match: int = 2,
    mismatch: int = -1,
    gap: int = -2,
) -> list[tuple[int | None, int | None]]:
    """Needleman-Wunsch. Returns (left_index, right_index) pairs; None = gap.

    Traceback prefers diagonal, then up, then left, so the output is
    deterministic for a given input.
    """
    rows, cols = len(left), len(right)
    score = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(1, rows + 1):
        score[i][0] = score[i - 1][0] + gap
    for j in range(1, cols + 1):
        score[0][j] = score[0][j - 1] + gap
    for i in range(1, rows + 1):
        for j in range(1, cols + 1):
            hit = match if left[i - 1] == right[j - 1] else mismatch
            score[i][j] = max(
                score[i - 1][j - 1] + hit,
                score[i - 1][j] + gap,
                score[i][j - 1] + gap,
            )

    pairs: list[tuple[int | None, int | None]] = []
    i, j = rows, cols
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            hit = match if left[i - 1] == right[j - 1] else mismatch
            if score[i][j] == score[i - 1][j - 1] + hit:
                pairs.append((i - 1, j - 1))
                i -= 1
                j -= 1
                continue
        if i > 0 and score[i][j] == score[i - 1][j] + gap:
            pairs.append((i - 1, None))
            i -= 1
            continue
        pairs.append((None, j - 1))
        j -= 1
    pairs.reverse()
    return pairs


def align_ipa_to_arpabet(
    ipa_tokens: list[str],
    arpabet_phones: list[str],
) -> list[tuple[int, ...]]:
    """Per IPA token, the `arpabet_phones` indices it aligns to.

    An empty tuple means the token aligned to nothing: it was inserted relative
    to the corpus transcription, or the table does not know it. Callers MUST
    skip those tokens rather than invent a human score for them.
    """
    predicted, owners = expand_ipa(ipa_tokens)
    actual = [strip_stress(phone) for phone in arpabet_phones]
    owned: list[list[int]] = [[] for _ in ipa_tokens]
    for left_index, right_index in _nw_align(predicted, actual):
        if left_index is None or right_index is None:
            continue
        if predicted[left_index] == UNKNOWN_ARPABET:
            continue
        owned[owners[left_index]].append(right_index)
    return [tuple(indices) for indices in owned]
