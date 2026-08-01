"""Turn one speechocean762 record + the sidecar's matching PronunciationReport
into the CSV rows correlate.py's REQUIRED_COLUMNS schema expects.

speechocean762's real schema (HuggingFace dataset viewer, mispeech/speechocean762)
and the sidecar's real /assess response shape (sidecar plan, report.py) are both
verified, not assumed -- see the addendum note above this task in the plan.
"""

from __future__ import annotations

from arpabet_ipa import align_ipa_to_arpabet, ipa_to_arpabet, strip_stress
from correlate import REQUIRED_COLUMNS

BLANK_ROW: dict = {column: "" for column in REQUIRED_COLUMNS}


def utterance_row(model: str, utt_id: str, human_accuracy, machine_accuracy) -> dict:
    """One utterance-level row. Scales differ on purpose (human 0-10, machine
    0-100) -- Pearson/Spearman correlation does not require matching scales."""
    return {
        **BLANK_ROW,
        "model": model,
        "level": "utterance",
        "utt_id": utt_id,
        "human": str(human_accuracy),
        "machine": str(machine_accuracy),
    }


def error_row(model: str, utt_id: str, code: str) -> dict:
    """One row recording that an utterance could not be scored at all --
    counted by correlate.coverage() as an attempted-but-failed utterance."""
    return {**BLANK_ROW, "model": model, "level": "error", "utt_id": utt_id, "error_code": code}


def phoneme_rows(
    model: str,
    utt_id: str,
    word_index: int,
    human_word: dict,
    machine_word: dict,
) -> list[dict]:
    """One row per (machine phone, human phone) pairing for a single word, PLUS one row
    for every human phone the alignment never touched at all.

    A multi-phone espeak unit (one machine phone covering two human phones) still
    produces two rows sharing the same machine SCORE -- that is intentional, both
    phones were genuinely scored by that one unit. But its `substituted` flag names
    exactly ONE detected event, so it is attributed to exactly one of those rows (the
    rater-flagged index when there is one, otherwise the first), never duplicated --
    duplicating it would manufacture a false positive on every other row in the group.

    A human phone with no machine pairing at all (the model dropped it) gets its own
    row with a blank `ipa`/`machine` -- pairs() already skips rows with a blank
    `machine` value, so phoneme-level correlation is unaffected, but
    substitution_agreement() now correctly counts a rater-flagged dropped phone as a
    false negative instead of it silently vanishing.
    """
    human_phones = human_word.get("phones", [])
    human_scores = human_word.get("phones-accuracy", [])
    human_subs = {entry["index"]: entry for entry in human_word.get("mispronunciations", [])}
    machine_phones = machine_word.get("phones") or []
    machine_ipa = [phone["ipa"] for phone in machine_phones]

    alignment = align_ipa_to_arpabet(machine_ipa, human_phones)
    paired_human_indices: set[int] = set()
    rows: list[dict] = []

    for machine_index, human_indices in enumerate(alignment):
        machine_phone = machine_phones[machine_index]
        substituted_ipa = machine_phone.get("substituted")
        machine_sub_arpabet = "+".join(ipa_to_arpabet(substituted_ipa)) if substituted_ipa else ""
        attribution_index = None
        if substituted_ipa and human_indices:
            attribution_index = next(
                (i for i in human_indices if i in human_subs), human_indices[0]
            )
        for human_index in human_indices:
            paired_human_indices.add(human_index)
            sub_entry = human_subs.get(human_index)
            is_attributed = human_index == attribution_index
            rows.append(
                {
                    **BLANK_ROW,
                    "model": model,
                    "level": "phoneme",
                    "utt_id": utt_id,
                    "word_index": str(word_index),
                    "phone_index": str(human_index),
                    "ipa": machine_phone["ipa"],
                    "arpabet": strip_stress(human_phones[human_index]),
                    "human": str(human_scores[human_index]),
                    "machine": str(machine_phone["score"]),
                    "human_sub": strip_stress(sub_entry["pronounced-phone"]) if sub_entry else "",
                    "machine_sub": substituted_ipa if is_attributed else "",
                    "machine_sub_arpabet": machine_sub_arpabet if is_attributed else "",
                }
            )

    for human_index in range(len(human_phones)):
        if human_index in paired_human_indices:
            continue
        sub_entry = human_subs.get(human_index)
        rows.append(
            {
                **BLANK_ROW,
                "model": model,
                "level": "phoneme",
                "utt_id": utt_id,
                "word_index": str(word_index),
                "phone_index": str(human_index),
                "arpabet": strip_stress(human_phones[human_index]),
                "human": str(human_scores[human_index]),
                "human_sub": strip_stress(sub_entry["pronounced-phone"]) if sub_entry else "",
            }
        )
    return rows


def build_utterance_rows(model: str, utt_id: str, human_record: dict, machine_report: dict) -> list[dict]:
    """All rows for one utterance: one utterance row plus every word's phoneme rows.

    Raises ValueError on a word-count mismatch between the corpus transcription
    and what the sidecar actually segmented -- callers must turn that into an
    error_row rather than zipping mismatched lists and silently mis-scoring
    every word after the divergence point.
    """
    human_words = human_record["words"]
    machine_words = machine_report["words"]
    if len(human_words) != len(machine_words):
        raise ValueError(
            f"word count mismatch for {utt_id}: corpus has {len(human_words)}, "
            f"sidecar returned {len(machine_words)}"
        )
    rows = [utterance_row(model, utt_id, human_record["accuracy"], machine_report["overall"]["accuracy"])]
    for index, (human_word, machine_word) in enumerate(zip(human_words, machine_words)):
        rows.extend(phoneme_rows(model, utt_id, index, human_word, machine_word))
    return rows
