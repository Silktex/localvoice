import os
import struct
import json
import logging
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Whisper STT Server",
    description="Speech-to-Text compatibility server",
    version="1.0.0",
)

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")
MODEL_CACHE_DIR = os.getenv("MODEL_CACHE_DIR", "/models")
BACKEND_URL = os.getenv("STT_BACKEND_URL", "http://whispercpp-backend:8081/inference")
BACKEND_TIMEOUT = float(os.getenv("STT_BACKEND_TIMEOUT", "300"))

backend_client: Optional[httpx.AsyncClient] = None


class TranscribeResponse(BaseModel):
    text: str
    language: Optional[str] = None
    duration: Optional[float] = None


def pcm_to_wav(
    pcm_data: bytes,
    sample_rate: int = 8000,
    channels: int = 1,
    bits_per_sample: int = 16,
) -> bytes:
    """Wrap raw PCM data in a WAV header."""
    data_size = len(pcm_data)
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM format
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm_data


@app.on_event("startup")
async def load_model():
    global backend_client
    logger.info(f"STT backend URL: {BACKEND_URL}")
    logger.info(f"Model hint: {WHISPER_MODEL}")
    logger.info(f"Device hint: {DEVICE}, compute type hint: {COMPUTE_TYPE}")
    backend_client = httpx.AsyncClient(timeout=BACKEND_TIMEOUT)


@app.on_event("shutdown")
async def close_client():
    if backend_client is not None:
        await backend_client.aclose()


def _backend_health_url() -> str:
    if "/" not in BACKEND_URL.replace("http://", "").replace("https://", ""):
        return f"{BACKEND_URL.rstrip('/')}/health"
    return f"{BACKEND_URL.rsplit('/', 1)[0]}/health"


async def _backend_is_healthy() -> bool:
    if backend_client is None:
        return False
    try:
        resp = await backend_client.get(_backend_health_url())
        return resp.status_code == 200
    except Exception:
        return False


async def _prepare_audio_payload(
    request: Request, file: Optional[UploadFile]
) -> tuple[bytes, str, str]:
    content_type = request.headers.get("content-type", "")

    if "audio/pcm" in content_type:
        pcm_data = await request.body()
        if not pcm_data:
            raise HTTPException(status_code=400, detail="Empty audio data")
        audio_data = pcm_to_wav(pcm_data, sample_rate=8000)
        logger.info(f"Received PCM audio: {len(pcm_data)} bytes, wrapped to WAV")
        return audio_data, "audio.wav", "audio/wav"

    if file is not None:
        audio_data = await file.read()
        if not audio_data:
            raise HTTPException(status_code=400, detail="Empty audio file")
        filename = file.filename or "audio.wav"
        media_type = file.content_type or "application/octet-stream"
        return audio_data, filename, media_type

    raise HTTPException(status_code=400, detail="No audio provided")


async def _call_backend(
    audio_data: bytes,
    filename: str,
    media_type: str,
    params: dict,
) -> httpx.Response:
    if backend_client is None:
        raise HTTPException(status_code=503, detail="Backend client not initialized")

    try:
        resp = await backend_client.post(
            BACKEND_URL,
            data=params,
            files={"file": (filename, audio_data, media_type)},
        )
    except Exception as e:
        logger.error(f"Backend request failed: {e}")
        raise HTTPException(status_code=503, detail="STT backend unavailable")

    if resp.status_code >= 400:
        detail = resp.text.strip() or "STT backend error"
        raise HTTPException(status_code=resp.status_code, detail=detail)

    return resp


@app.get("/health")
async def health_check():
    healthy = await _backend_is_healthy()
    return {
        "status": "healthy" if healthy else "loading",
        "model": WHISPER_MODEL,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "backend_url": BACKEND_URL,
    }


@app.post("/v1/audio/transcriptions", response_class=Response)
async def transcribe_audio(
    request: Request,
    file: UploadFile = File(None),
    model: str = Form(default="whisper-1"),
    language: Optional[str] = Form(default=None),
    response_format: str = Form(default="json"),
):
    try:
        _ = model
        audio_data, filename, media_type = await _prepare_audio_payload(request, file)

        params = {"response_format": response_format}
        if language:
            params["language"] = language

        backend_resp = await _call_backend(audio_data, filename, media_type, params)

        if response_format == "json":
            try:
                payload = backend_resp.json()
                text = payload.get("text", "")
            except Exception:
                text = backend_resp.text
            return Response(
                content=json.dumps({"text": text}),
                media_type="application/json",
            )

        return Response(content=backend_resp.text, media_type="text/plain")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...), language: Optional[str] = Form(default=None)
):
    try:
        audio_data = await file.read()
        if not audio_data:
            raise HTTPException(status_code=400, detail="Empty audio file")

        params = {"response_format": "verbose_json"}
        if language:
            params["language"] = language

        backend_resp = await _call_backend(
            audio_data=audio_data,
            filename=file.filename or "audio.wav",
            media_type=file.content_type or "application/octet-stream",
            params=params,
        )

        try:
            payload = backend_resp.json()
        except Exception:
            payload = {"text": backend_resp.text}

        return TranscribeResponse(
            text=payload.get("text", ""),
            language=payload.get("language"),
            duration=payload.get("duration"),
        )

    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
