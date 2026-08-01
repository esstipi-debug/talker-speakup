"""Pins the datasets library's actual Audio decode contract for the installed version.

This assumption broke silently once before (datasets 4.x switched to requiring torchcodec
and returning a decoder object instead of a dict) -- this test catches that regression
without ever downloading the real corpus.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import datasets


def test_installed_datasets_decodes_audio_to_the_array_sampling_rate_dict_shape():
    samples = np.zeros(1600, dtype=np.float32)
    ds = datasets.Dataset.from_dict(
        {"audio": [{"array": samples, "sampling_rate": 16000}]},
        features=datasets.Features({"audio": datasets.Audio(sampling_rate=16000)}),
    )
    record = ds[0]
    assert isinstance(record["audio"], dict)
    assert set(record["audio"]) >= {"array", "sampling_rate"}
    assert record["audio"]["sampling_rate"] == 16000
    assert len(record["audio"]["array"]) == 1600
