"""Speaker embedding extraction and comparison using pyannote WeSpeaker ResNet34."""

import os

import numpy as np

_inference = None
MODEL_DIR = "/models/wespeaker"


def get_inference():
    """Load and cache the pyannote WeSpeaker embedding model."""
    global _inference
    if _inference is None:
        from pyannote.audio import Inference, Model

        hf_token = os.environ.get("HF_TOKEN")
        if not hf_token:
            raise RuntimeError(
                "HF_TOKEN environment variable required for pyannote.audio. "
                "Get one at https://huggingface.co/settings/tokens"
            )

        model = Model.from_pretrained(
            "pyannote/wespeaker-voxceleb-resnet34-LM",
            use_auth_token=hf_token,
            cache_dir=MODEL_DIR,
        )
        model.to("cpu")
        _inference = Inference(model, window="whole")
        print("WeSpeaker ResNet34 embedding model loaded (cpu, 256-dim)")
    return _inference


def extract_embedding(audio_path: str) -> list[float]:
    """Extract a 256-dim speaker embedding from an audio file."""
    inference = get_inference()
    embedding = inference(audio_path)  # returns numpy array (256,)
    return embedding.tolist()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two embeddings."""
    a_np = np.array(a, dtype=np.float32)
    b_np = np.array(b, dtype=np.float32)
    dot = np.dot(a_np, b_np)
    norm_a = np.linalg.norm(a_np)
    norm_b = np.linalg.norm(b_np)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


def identify_speaker(
    embedding: list[float], enrolled: list[dict], threshold: float = 0.65
) -> dict:
    """Match an embedding against enrolled speakers. Returns best match."""
    scores = []
    for sp in enrolled:
        score = cosine_similarity(embedding, sp["embedding"])
        scores.append({"name": sp["name"], "speaker_id": sp["speaker_id"], "score": round(score, 4)})

    scores.sort(key=lambda x: x["score"], reverse=True)

    best = scores[0] if scores else None
    identified = best["name"] if best and best["score"] >= threshold else None
    speaker_id = best["speaker_id"] if best and best["score"] >= threshold else None

    return {
        "identified": identified,
        "speaker_id": speaker_id,
        "confidence": best["score"] if best else 0.0,
        "all_scores": scores,
    }
