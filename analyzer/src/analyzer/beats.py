from collections.abc import Sequence

import numpy as np

ENERGY_HOP_SEC = 0.5
BPM_SPAN_BEATS = 8


# beat_this reports beats on a 20 ms frame grid, so a single interval's median can only
# land on values like 120 or 125 BPM. Measuring over 8-beat spans of steady beats
# shrinks that step to 2.5 ms while the median still ignores missed or doubled beats.
def bpm_from_beats(beats: Sequence[float]) -> float:
    beats = np.asarray(beats)
    intervals = np.diff(beats)
    typical = np.median(intervals)
    steady = np.abs(intervals / typical - 1) < 0.25
    spans = [
        (beats[i + BPM_SPAN_BEATS] - beats[i]) / BPM_SPAN_BEATS
        for i in range(len(intervals) - BPM_SPAN_BEATS + 1)
        if steady[i : i + BPM_SPAN_BEATS].all()
    ]
    return float(60 / (np.median(spans) if spans else typical))


def downbeat_indices(beats: Sequence[float], downbeats: Sequence[float]) -> list[int]:
    beats = np.asarray(beats)
    nearest = {int(np.argmin(np.abs(beats - t))) for t in downbeats}
    return sorted(nearest)


def rms_energy(samples: np.ndarray, sr: int, hop_sec: float = ENERGY_HOP_SEC) -> list[float]:
    hop = int(sr * hop_sec)
    windows = [samples[start : start + hop] for start in range(0, len(samples), hop)]
    rms = np.array([np.sqrt(np.mean(np.square(w))) for w in windows])
    peak = rms.max(initial=0.0)
    return (rms / peak if peak > 0 else rms).tolist()


def analyze(path: str) -> dict:
    import soundfile as sf
    from beat_this.inference import Audio2Beats

    samples, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    beats, downbeats = Audio2Beats(checkpoint_path="final0", device="cpu", dbn=False)(mono, sr)
    beats = [round(float(t), 3) for t in beats]
    return {
        "bpm": round(bpm_from_beats(beats), 2) if len(beats) >= 2 else None,
        "beats": beats,
        "downbeatIndices": downbeat_indices(beats, downbeats) if beats else [],
        "energy": {
            "hopSec": ENERGY_HOP_SEC,
            "values": [round(v, 4) for v in rms_energy(mono, sr)],
        },
    }
