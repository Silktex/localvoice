FROM python:3.11-slim
LABEL maintainer="localvoice"
LABEL description="Parler-TTS Server with PyTorch (CPU) - High Quality"
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV MODEL_NAME=parler-tts/parler_tts_mini_v0.1
ENV MODEL_CACHE_DIR=/models
ENV DEVICE=cpu
ENV SAMPLE_RATE=24000
ENV TTS_DESCRIPTION="A female speaker delivers a slightly expressive and animated speech."
ENV OMP_NUM_THREADS=6
ENV MKL_NUM_THREADS=6
ENV OPENBLAS_NUM_THREADS=6
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ffmpeg libsndfile1 curl \
    && rm -rf /var/lib/apt/lists/* && apt-get clean
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
RUN mkdir -p ${MODEL_CACHE_DIR}
COPY server.py .
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
