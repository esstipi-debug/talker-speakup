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
    _vocab = {"<pad>": 0, "|": 1, "ʃ": 2, "<unk>": 3, "iː": 4, "p": 5}

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
    assert tokens_to_ids(FakeTokenizer(), ["ʃ", "iː", "p"]) == [2, 4, 5]


def test_tokens_to_ids_refuses_out_of_vocabulary_phones():
    with pytest.raises(PronError) as excinfo:
        tokens_to_ids(FakeTokenizer(), ["ʃ", "ɹ̩"])
    assert excinfo.value.code == "UNPRONOUNCEABLE_TEXT"
    assert "ɹ̩" in excinfo.value.message


def test_tokens_to_ids_refuses_multiple_out_of_vocabulary_phones():
    """Regression test: ensure all OOV offenders are reported, not just the first.

    A bug that only collects the first offending token would silently miss
    additional OOV phones. This test verifies both offenders appear in the error.
    """
    with pytest.raises(PronError) as excinfo:
        tokens_to_ids(FakeTokenizer(), ["ʔ", "ŋ", "p"])
    assert excinfo.value.code == "UNPRONOUNCEABLE_TEXT"
    assert "ʔ" in excinfo.value.message
    assert "ŋ" in excinfo.value.message


def test_emit_log_probs_applies_log_softmax_and_computes_the_frame_rate():
    wav = np.zeros(16000, dtype=np.float32)  # exactly 1.0 s
    extractor = FakeFeatureExtractor()

    log_probs, sec_per_frame = emit_log_probs(wav, FakeModel(frames=40), extractor, "cpu")

    assert log_probs.shape == (1, 40, 7)
    assert torch.allclose(log_probs.exp().sum(dim=-1), torch.ones(1, 40), atol=1e-5)
    assert sec_per_frame == pytest.approx(0.025)  # computed, never hardcoded to 0.02
    assert extractor.calls == [16000]  # do_normalize=True path is never bypassed


def test_sec_per_frame_computed_with_different_sample_and_frame_counts():
    """Regression test: ensure sec_per_frame is computed, not hardcoded.

    Tests a second data point (32000 samples, 40 frames) to verify the formula
    (len(wav) / SAMPLE_RATE) / frames is actually applied. A hardcoded return
    of 0.025 would fail this test.
    """
    wav = np.zeros(32000, dtype=np.float32)  # exactly 2.0 s
    extractor = FakeFeatureExtractor()

    log_probs, sec_per_frame = emit_log_probs(wav, FakeModel(frames=40), extractor, "cpu")

    assert log_probs.shape == (1, 40, 7)
    assert sec_per_frame == pytest.approx(0.05)  # (32000 / 16000) / 40 = 2.0 / 40 = 0.05


def test_emit_log_probs_rejects_empty_audio():
    with pytest.raises(PronError) as excinfo:
        emit_log_probs(np.zeros(0, dtype=np.float32), FakeModel(frames=1), FakeFeatureExtractor(), "cpu")
    assert excinfo.value.code == "NO_SPEECH"
    assert excinfo.value.status == 422


def test_align_available_reports_the_torchaudio_build_flag():
    assert align_available() is True
