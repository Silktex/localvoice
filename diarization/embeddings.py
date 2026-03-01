"""Speaker embedding extraction and comparison using SpeechBrain ECAPA-TDNN."""

import os

import numpy as np
import torch
import torchaudio

_classifier = None
MODEL_DIR = "/models/ecapa-tdnn"


def get_classifier():
    global _classifier
    if _classifier is None:
        from speechbrain.inference.speaker import EncoderClassifier

        device = os.environ.get("DEVICE", "cpu")
        _classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=MODEL_DIR,
            run_opts={"device": device},
        )
    return _classifier


def extract_embedding(audio_path: str) -> list[float]:
    """Extract a 192-dim speaker embedding from an audio file."""
    classifier = get_classifier()
    signal, sr = torchaudio.load(audio_path)
    # Resample to 16kHz if needed
    if sr != 16000:
        signal = torchaudio.functional.resample(signal, sr, 16000)
    # Mix to mono
    if signal.shape[0] > 1:
        signal = signal.mean(dim=0, keepdim=True)
    embedding = classifier.encode_batch(signal)  # shape: [1, 1, 192]
    return embedding.squeeze().tolist()


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
