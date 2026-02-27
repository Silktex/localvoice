FROM python:3.11-slim

LABEL maintainer="localvoice"
LABEL description="Whisper STT compatibility shim"

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV WHISPER_MODEL=small
ENV COMPUTE_TYPE=int8
ENV MODEL_CACHE_DIR=/models
ENV STT_BACKEND_URL=http://whispercpp-backend:8081/inference
ENV STT_BACKEND_TIMEOUT=300
ENV PORT=8080
ENV OMP_NUM_THREADS=4

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/* && apt-get clean

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
