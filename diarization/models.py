"""Model loading for pyannote.audio diarization pipeline."""

import os

import torch

_pipeline = None
MODEL_DIR = "/models/pyannote"


def get_pipeline():
    """Load and cache the pyannote speaker diarization pipeline."""
    global _pipeline
    if _pipeline is None:
        hf_token = os.environ.get("HF_TOKEN")
        if not hf_token:
            raise RuntimeError(
                "HF_TOKEN environment variable required for pyannote.audio. "
                "Get one at https://huggingface.co/settings/tokens and accept model terms at "
                "https://huggingface.co/pyannote/speaker-diarization-3.1"
            )

        from pyannote.audio import Pipeline

        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
            cache_dir=MODEL_DIR,
        )
        device = os.environ.get("DEVICE", "cpu")
        _pipeline.to(torch.device(device))
        print(f"pyannote diarization pipeline loaded ({device})")
    return _pipeline


def diarize(audio_path: str, num_speakers: int | None = None,
            min_speakers: int | None = None, max_speakers: int | None = None) -> list[dict]:
    """Run speaker diarization on an audio file. Returns list of segments."""
    pipeline = get_pipeline()

    kwargs = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers

    diarization = pipeline(audio_path, **kwargs)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
            "speaker": speaker,
        })

    return segments
