import os
import io
import wave
import json
import logging
import urllib.request
from pathlib import Path
from typing import Optional
import base64

import numpy as np
from scipy.signal import resample_poly
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Piper TTS Server",
    description="Fast Text-to-Speech using Piper VITS (CPU)",
    version="1.0.0",
)

PIPER_VOICE = os.getenv("PIPER_VOICE", "en_US-lessac-medium")
PIPER_DATA_DIR = os.getenv("PIPER_DATA_DIR", "/models/piper")

voice_model = None
voice_sample_rate = None


class TTSRequest(BaseModel):
    text: str
    speaker_id: Optional[int] = None


class TTSBase64Response(BaseModel):
    success: bool
    message: str
    audio_base64: Optional[str] = None
    sample_rate: Optional[int] = None


def synthesize_wav(text: str) -> tuple[bytes, int]:
    """Synthesize text to WAV bytes. Returns (wav_bytes, sample_rate)."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(voice_sample_rate)
        for chunk in voice_model.synthesize(text):
            wav_file.writeframes(chunk.audio_int16_bytes)
    buffer.seek(0)
    return buffer.read(), voice_sample_rate


def wav_to_pcm_8k(wav_bytes: bytes) -> bytes:
    """Convert WAV audio to raw PCM 16-bit signed 8kHz mono."""
    buffer = io.BytesIO(wav_bytes)
    with wave.open(buffer, "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        n_channels = wav_file.getnchannels()
        sampwidth = wav_file.getsampwidth()
        frames = wav_file.readframes(wav_file.getnframes())

    # Convert to numpy array
    audio = np.frombuffer(frames, dtype=np.int16)

    # If stereo, take first channel
    if n_channels > 1:
        audio = audio[::n_channels]

    # Resample to 8kHz if needed
    if sample_rate != 8000:
        from math import gcd
        g = gcd(8000, sample_rate)
        audio = resample_poly(audio, 8000 // g, sample_rate // g).astype(np.int16)

    return audio.tobytes()


def _voice_to_url_path(voice_name: str) -> str:
    """Convert voice name like 'en_US-lessac-medium' to HF URL path."""
    # Format: {lang}_{REGION}-{name}-{quality}
    parts = voice_name.split("-")
    lang_region = parts[0]  # en_US
    name = parts[1]  # lessac
    quality = parts[2] if len(parts) > 2 else "medium"
    lang = lang_region.split("_")[0]  # en
    return f"{lang}/{lang_region}/{name}/{quality}"


def download_voice(voice_name: str, data_dir: str) -> tuple[str, str]:
    """Download Piper voice model files if not present. Returns (onnx_path, config_path)."""
    os.makedirs(data_dir, exist_ok=True)
    onnx_path = os.path.join(data_dir, f"{voice_name}.onnx")
    config_path = os.path.join(data_dir, f"{voice_name}.onnx.json")

    base_url = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"
    url_path = _voice_to_url_path(voice_name)

    for filepath, filename in [(onnx_path, f"{voice_name}.onnx"), (config_path, f"{voice_name}.onnx.json")]:
        if not os.path.exists(filepath):
            url = f"{base_url}/{url_path}/{filename}"
            logger.info(f"Downloading {url} -> {filepath}")
            urllib.request.urlretrieve(url, filepath)
            logger.info(f"Downloaded {filepath} ({os.path.getsize(filepath)} bytes)")
        else:
            logger.info(f"Voice file exists: {filepath}")

    return onnx_path, config_path


@app.on_event("startup")
async def load_model():
    global voice_model, voice_sample_rate
    logger.info(f"Loading Piper voice: {PIPER_VOICE}")
    logger.info(f"Data dir: {PIPER_DATA_DIR}")

    try:
        from piper import PiperVoice

        # Download voice model if needed
        onnx_path, config_path = download_voice(PIPER_VOICE, PIPER_DATA_DIR)

        voice_model = PiperVoice.load(onnx_path, config_path=config_path)
        voice_sample_rate = voice_model.config.sample_rate

        logger.info(f"Piper voice loaded: {PIPER_VOICE} (sample_rate={voice_sample_rate})")

    except Exception as e:
        logger.error(f"Failed to load Piper voice: {e}")
        raise


@app.get("/health")
async def health_check():
    return {
        "status": "healthy" if voice_model is not None else "loading",
        "voice": PIPER_VOICE,
        "sample_rate": voice_sample_rate,
    }


@app.post("/tts")
async def text_to_speech(
    request: TTSRequest,
    output_format: Optional[str] = Query(None, description="Output format: 'pcm_8k' for raw PCM 8kHz"),
):
    if voice_model is None:
        raise HTTPException(status_code=503, detail="Voice not loaded")

    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    logger.info(f"TTS request: text='{request.text[:50]}{'...' if len(request.text) > 50 else ''}'")

    try:
        wav_bytes, sample_rate = synthesize_wav(request.text)

        if output_format == "pcm_8k":
            pcm_bytes = wav_to_pcm_8k(wav_bytes)
            return Response(
                content=pcm_bytes,
                media_type="audio/pcm",
                headers={
                    "X-Sample-Rate": "8000",
                    "X-Bits-Per-Sample": "16",
                    "X-Channels": "1",
                },
            )

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=output.wav",
                "X-Sample-Rate": str(sample_rate),
            },
        )

    except Exception as e:
        logger.error(f"TTS generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tts/base64")
async def text_to_speech_base64(
    request: TTSRequest,
    output_format: Optional[str] = Query(None),
):
    if voice_model is None:
        raise HTTPException(status_code=503, detail="Voice not loaded")

    try:
        wav_bytes, sample_rate = synthesize_wav(request.text)

        if output_format == "pcm_8k":
            audio_bytes = wav_to_pcm_8k(wav_bytes)
            sr = 8000
        else:
            audio_bytes = wav_bytes
            sr = sample_rate

        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

        return TTSBase64Response(
            success=True,
            message="Audio generated successfully",
            audio_base64=audio_base64,
            sample_rate=sr,
        )

    except Exception as e:
        logger.error(f"TTS base64 generation failed: {e}")
        return TTSBase64Response(success=False, message=str(e))


@app.get("/speakers")
async def list_speakers():
    if voice_model is None:
        return {"speakers": [], "note": "Voice not loaded yet"}

    # Piper voices may have multiple speakers
    num_speakers = voice_model.config.num_speakers
    if num_speakers > 1:
        speakers = [{"id": i, "name": f"speaker_{i}"} for i in range(num_speakers)]
    else:
        speakers = [{"id": 0, "name": "default"}]

    return {
        "voice": PIPER_VOICE,
        "speakers": speakers,
        "sample_rate": voice_sample_rate,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
