"""Speaker diarization and voice identification FastAPI service."""

import os
import shutil
import tempfile
import traceback

# PyTorch 2.6 compat: defaults weights_only=True which breaks
# pyannote.audio and speechbrain model loading (pickled TorchVersion objects).
# Patch before any model imports.
import torch
_orig_torch_load = torch.load
def _compat_torch_load(*args, **kwargs):
    if "weights_only" not in kwargs:
        kwargs["weights_only"] = False
    return _orig_torch_load(*args, **kwargs)
torch.load = _compat_torch_load

import soundfile as sf
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

import db
import embeddings
import models

app = FastAPI(title="LocalVoice Speaker Diarization")

# Track model loading state
_models_ready = {"diarization": False, "embedding": False}


@app.on_event("startup")
async def startup():
    """Pre-load models on startup."""
    try:
        models.get_pipeline()
        _models_ready["diarization"] = True
        print("Diarization model ready")
    except Exception as e:
        print(f"WARNING: Diarization model failed to load: {e}")

    try:
        embeddings.get_classifier()
        _models_ready["embedding"] = True
        print("Embedding model ready")
    except Exception as e:
        print(f"WARNING: Embedding model failed to load: {e}")

    # Init database
    db.get_db()
    print("Voice profile database ready")


@app.get("/health")
async def health():
    speakers = db.list_speakers()
    status = "healthy" if all(_models_ready.values()) else "loading"
    return {
        "status": status,
        "models": {
            "diarization": "pyannote/speaker-diarization-3.1" if _models_ready["diarization"] else "loading",
            "embedding": "speechbrain/spkrec-ecapa-voxceleb" if _models_ready["embedding"] else "loading",
        },
        "speakers_enrolled": len(speakers),
        "device": os.environ.get("DEVICE", "cpu"),
    }


def _save_upload(upload: UploadFile, suffix: str = ".wav") -> str:
    """Save an uploaded file to a temp path and return the path."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    shutil.copyfileobj(upload.file, tmp)
    tmp.close()
    return tmp.name


@app.post("/diarize")
async def diarize(
    file: UploadFile = File(...),
    num_speakers: int | None = Form(None),
    min_speakers: int | None = Form(None),
    max_speakers: int | None = Form(None),
):
    """Run speaker diarization on an audio file."""
    tmp_path = _save_upload(file)
    try:
        segments = models.diarize(
            tmp_path,
            num_speakers=num_speakers,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )
        # Get audio duration
        info = sf.info(tmp_path)
        duration = info.duration

        unique_speakers = list(set(s["speaker"] for s in segments))
        return {
            "segments": segments,
            "num_speakers": len(unique_speakers),
            "duration": round(duration, 3),
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        os.unlink(tmp_path)


@app.post("/embed")
async def embed(file: UploadFile = File(...)):
    """Extract a 192-dim speaker embedding from audio."""
    tmp_path = _save_upload(file)
    try:
        embedding = embeddings.extract_embedding(tmp_path)
        info = sf.info(tmp_path)
        return {
            "embedding": embedding,
            "dimension": len(embedding),
            "duration": round(info.duration, 3),
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        os.unlink(tmp_path)


@app.post("/enroll")
async def enroll(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(None),
):
    """Enroll a speaker voice profile."""
    tmp_path = _save_upload(file)
    try:
        embedding = embeddings.extract_embedding(tmp_path)
        info = sf.info(tmp_path)

        # Save audio sample permanently
        ext = os.path.splitext(file.filename or "sample.wav")[1] or ".wav"
        sample_filename = f"{name.lower().replace(' ', '_')}_{len(db.list_speakers()) + 1}{ext}"
        sample_path = os.path.join(db.ENROLLMENTS_DIR, sample_filename)
        shutil.copy2(tmp_path, sample_path)

        result = db.upsert_speaker(
            name=name,
            embedding=embedding,
            description=description,
            audio_path=sample_filename,
            duration=info.duration,
        )
        return result
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        os.unlink(tmp_path)


@app.get("/speakers")
async def list_speakers():
    return {"speakers": db.list_speakers()}


@app.delete("/speakers/{speaker_id}")
async def delete_speaker(speaker_id: str):
    if db.delete_speaker(speaker_id):
        return {"deleted": True, "speaker_id": speaker_id}
    return JSONResponse({"error": "Speaker not found"}, status_code=404)


@app.post("/identify")
async def identify(
    file: UploadFile = File(None),
    threshold: float = Form(0.65),
):
    """Identify the speaker in an audio clip against enrolled profiles."""
    if file is None:
        return JSONResponse({"error": "Audio file required"}, status_code=400)

    tmp_path = _save_upload(file)
    try:
        embedding = embeddings.extract_embedding(tmp_path)
        enrolled = db.get_all_embeddings()
        if not enrolled:
            return {"identified": None, "confidence": 0.0, "all_scores": [], "message": "No speakers enrolled"}
        result = embeddings.identify_speaker(embedding, enrolled, threshold)
        return result
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        os.unlink(tmp_path)


@app.post("/diarize-and-identify")
async def diarize_and_identify(
    file: UploadFile = File(...),
    num_speakers: int | None = Form(None),
    threshold: float = Form(0.65),
):
    """Combined: diarize audio, then identify each speaker against enrolled profiles."""
    tmp_path = _save_upload(file)
    try:
        # Step 1: Diarize
        segments = models.diarize(tmp_path, num_speakers=num_speakers)
        info = sf.info(tmp_path)

        # Step 2: Get unique speaker labels
        unique_speakers = list(set(s["speaker"] for s in segments))

        # Step 3: For each speaker, extract audio and compute embedding
        import torchaudio

        waveform, sr = torchaudio.load(tmp_path)
        if sr != 16000:
            waveform = torchaudio.functional.resample(waveform, sr, 16000)
            sr = 16000
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        enrolled = db.get_all_embeddings()
        speaker_map = {}

        for speaker_label in unique_speakers:
            # Concatenate all segments for this speaker
            speaker_segments = [s for s in segments if s["speaker"] == speaker_label]
            chunks = []
            for seg in speaker_segments:
                start_sample = int(seg["start"] * sr)
                end_sample = int(seg["end"] * sr)
                end_sample = min(end_sample, waveform.shape[1])
                if start_sample < end_sample:
                    chunks.append(waveform[:, start_sample:end_sample])

            if not chunks:
                speaker_map[speaker_label] = {"name": None, "confidence": 0.0}
                continue

            import torch

            combined = torch.cat(chunks, dim=1)

            # Save combined audio to temp file for embedding extraction
            combined_path = tmp_path + f"_{speaker_label}.wav"
            torchaudio.save(combined_path, combined, sr)

            try:
                embedding = embeddings.extract_embedding(combined_path)
                if enrolled:
                    result = embeddings.identify_speaker(embedding, enrolled, threshold)
                    speaker_map[speaker_label] = {
                        "name": result["identified"],
                        "confidence": result["confidence"],
                    }
                else:
                    speaker_map[speaker_label] = {"name": None, "confidence": 0.0}
            finally:
                os.unlink(combined_path)

        # Step 4: Annotate segments with identified names
        for seg in segments:
            label = seg["speaker"]
            if label in speaker_map:
                seg["speaker_label"] = label
                seg["identified_name"] = speaker_map[label]["name"]
                seg["confidence"] = speaker_map[label]["confidence"]

        return {
            "segments": segments,
            "speakers": speaker_map,
            "num_speakers": len(unique_speakers),
            "duration": round(info.duration, 3),
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        os.unlink(tmp_path)
