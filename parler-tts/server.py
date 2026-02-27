import os
import io
import logging
import base64
from typing import Optional
from math import gcd

import torch
import torchaudio
import numpy as np
from scipy.signal import resample_poly
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Parler-TTS Server",
    description="High-quality TTS API using Parler-TTS model (CPU)",
    version="1.0.0",
)

MODEL_NAME = os.getenv("MODEL_NAME", "parler-tts/parler_tts_mini_v0.1")
MODEL_CACHE_DIR = os.getenv("MODEL_CACHE_DIR", "/models")
DEVICE = os.getenv("DEVICE", "cpu")
SAMPLE_RATE = int(os.getenv("SAMPLE_RATE", "24000"))
DEFAULT_DESCRIPTION = os.getenv(
    "TTS_DESCRIPTION",
    "A female speaker delivers a slightly expressive and animated speech.",
)

tts_model = None
tokenizer = None


class TTSRequest(BaseModel):
    text: str
    description: Optional[str] = None


class TTSResponse(BaseModel):
    success: bool
    message: str
    audio_base64: Optional[str] = None


def audio_to_pcm_8k(audio_arr: np.ndarray, source_rate: int) -> bytes:
    """Convert float32 audio array to raw PCM 16-bit signed 8kHz mono."""
    # Resample to 8kHz
    g = gcd(8000, source_rate)
    resampled = resample_poly(audio_arr, 8000 // g, source_rate // g)
    # Convert to int16
    audio_int16 = (resampled * 32767).clip(-32768, 32767).astype(np.int16)
    return audio_int16.tobytes()


def generate_audio(text: str, description: str) -> np.ndarray:
    """Generate audio array from text using Parler-TTS."""
    with torch.no_grad():
        input_ids = tokenizer(description, return_tensors="pt").input_ids.to(DEVICE)
        prompt_input_ids = tokenizer(text, return_tensors="pt").input_ids.to(DEVICE)
        generation = tts_model.generate(
            input_ids=input_ids, prompt_input_ids=prompt_input_ids
        )
        return generation.cpu().numpy().squeeze()


@app.on_event("startup")
async def load_model():
    global tts_model, tokenizer
    logger.info(f"Loading model: {MODEL_NAME}")
    logger.info(f"Device: {DEVICE}")
    logger.info(f"Cache dir: {MODEL_CACHE_DIR}")

    try:
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer

        tts_model = ParlerTTSForConditionalGeneration.from_pretrained(
            MODEL_NAME, cache_dir=MODEL_CACHE_DIR
        ).to(DEVICE)

        tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, cache_dir=MODEL_CACHE_DIR)
        tts_model.eval()
        logger.info("Model loaded successfully")

    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        logger.info("Server will start but TTS will not work until model is available")


@app.get("/health")
async def health_check():
    return {
        "status": "healthy" if tts_model is not None else "loading",
        "model": MODEL_NAME,
        "device": DEVICE,
        "sample_rate": SAMPLE_RATE,
    }


@app.post("/tts")
async def text_to_speech(
    request: TTSRequest,
    output_format: Optional[str] = Query(None, description="Output format: 'pcm_8k' for raw PCM 8kHz"),
):
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    description = request.description or DEFAULT_DESCRIPTION
    logger.info(f"TTS request: text='{request.text[:50]}...'")

    try:
        audio_arr = generate_audio(request.text, description)

        if output_format == "pcm_8k":
            pcm_bytes = audio_to_pcm_8k(audio_arr, SAMPLE_RATE)
            return Response(
                content=pcm_bytes,
                media_type="audio/pcm",
                headers={
                    "X-Sample-Rate": "8000",
                    "X-Bits-Per-Sample": "16",
                    "X-Channels": "1",
                },
            )

        import scipy.io.wavfile as wavfile
        buffer = io.BytesIO()
        wavfile.write(buffer, SAMPLE_RATE, audio_arr.astype(np.float32))
        buffer.seek(0)

        return Response(
            content=buffer.read(),
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=output.wav",
                "X-Sample-Rate": str(SAMPLE_RATE),
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
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    description = request.description or DEFAULT_DESCRIPTION

    try:
        audio_arr = generate_audio(request.text, description)

        if output_format == "pcm_8k":
            audio_bytes = audio_to_pcm_8k(audio_arr, SAMPLE_RATE)
        else:
            import scipy.io.wavfile as wavfile
            buffer = io.BytesIO()
            wavfile.write(buffer, SAMPLE_RATE, audio_arr.astype(np.float32))
            buffer.seek(0)
            audio_bytes = buffer.read()

        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
        return TTSResponse(
            success=True,
            message="Audio generated successfully",
            audio_base64=audio_base64,
        )

    except Exception as e:
        logger.error(f"TTS base64 generation failed: {e}")
        return TTSResponse(success=False, message=str(e))


@app.get("/speakers")
async def list_speakers():
    return {
        "speakers": ["default"],
        "note": "Use 'description' parameter to control voice style. Example: 'A female speaker with a calm voice.'",
        "model": MODEL_NAME,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
