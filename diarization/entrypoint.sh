#!/bin/bash
set -e

echo "Starting speaker diarization service..."
echo "  HF_TOKEN: ${HF_TOKEN:+set (hidden)}${HF_TOKEN:-NOT SET}"
echo "  Device: ${DEVICE:-cpu}"
echo "  Port: ${PORT:-8090}"
echo "  Threads: ${OMP_NUM_THREADS:-4}"

# Ensure data directories
mkdir -p /data/enrollments

exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8090}"
