import json
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

from analyzer.beats import ENERGY_HOP_SEC, bpm_from_beats, downbeat_indices, rms_energy

SR = 44100


def test_bpm_is_sixty_over_the_median_interval():
    beats = [0.0, 0.5, 1.0, 1.5, 2.1, 2.6]
    assert bpm_from_beats(beats) == pytest.approx(120.0)


def test_bpm_ignores_a_single_missed_beat():
    beats = [0.0, 0.5, 1.0, 2.0, 2.5, 3.0]
    assert bpm_from_beats(beats) == pytest.approx(120.0)


def test_bpm_survives_beat_times_snapped_to_the_models_20_ms_frames():
    beats = np.round(np.arange(200) * 60 / 124 / 0.02) * 0.02
    assert bpm_from_beats(beats.tolist()) == pytest.approx(124, abs=0.5)


def test_downbeats_map_to_the_nearest_beat_index():
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
    assert downbeat_indices(beats, [0.01, 1.98, 2.96]) == [0, 4, 6]


def test_downbeats_landing_on_the_same_beat_count_once():
    beats = [0.0, 0.5, 1.0]
    assert downbeat_indices(beats, [0.49, 0.51]) == [1]


def test_energy_is_rms_per_half_second_normalized_to_the_loudest():
    half = int(SR * ENERGY_HOP_SEC)
    samples = np.concatenate([np.full(half, 0.1), np.full(half, -0.4), np.full(half // 2, 0.2)])
    assert rms_energy(samples, SR) == pytest.approx([0.25, 1.0, 0.5])


def test_energy_of_silence_is_zero():
    assert rms_energy(np.zeros(SR), SR) == [0.0, 0.0]


def click_track(bpm: float, seconds: float) -> np.ndarray:
    samples = np.zeros(int(SR * seconds))
    period = 60 / bpm
    t = np.arange(int(SR * 0.03)) / SR
    for i in range(int(seconds / period)):
        accent = 1.0 if i % 4 == 0 else 0.5
        pitch = 1500 if i % 4 == 0 else 1000
        click = accent * np.sin(2 * np.pi * pitch * t) * np.exp(-t * 150)
        start = int(i * period * SR)
        samples[start : start + len(click)] += click[: len(samples) - start]
    return samples


def test_beats_command_finds_half_second_spacing_in_a_120_bpm_click_track(tmp_path):
    wav = tmp_path / "click.wav"
    sf.write(wav, click_track(120, 30), SR)
    result = subprocess.run(
        [sys.executable, "-m", "analyzer", "beats", "--input", str(wav)],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    beats = json.loads(lines[0])["beats"]
    spacing = np.diff(beats)
    assert len(beats) > 50
    assert np.all(np.abs(spacing - 0.5) <= 0.02), spacing
