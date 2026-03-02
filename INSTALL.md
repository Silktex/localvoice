# LocalVoice Installation Guide

Instructions for AI agents and developers to install and configure LocalVoice.

## Prerequisites

- Docker and Docker Compose v2
- `bun` runtime (for CLI tool and web UI builds)
- `make` (for convenience targets)
- 16GB+ RAM recommended
- AMD or Intel x86_64 CPU (GPU optional for Whisper via Vulkan)

## Quick Start

```bash
git clone <repo-url> localvoice
cd localvoice
cp .env.example .env
# Edit .env with your values (see Configuration section below)
make stt-model        # Download default Whisper model
make stt-model-en     # Download English-only model
make stt-up           # Start core STT + TTS services
```

## Configuration

Edit `.env` before starting services. The file has sections for each service.

### Required Settings

These must be set for the corresponding services to work:

| Variable | Service | Description |
|----------|---------|-------------|
| `HF_TOKEN` | Diarization | Hugging Face token for pyannote.audio model download. Get from https://huggingface.co/settings/tokens. You must also accept model terms at https://huggingface.co/pyannote/speaker-diarization-3.1 |
| `THREECX_FQDN` | 3CX Sync | Your 3CX PBX domain (e.g., `pbx.example.com`) |
| `THREECX_CLIENT_ID` | 3CX Sync | OAuth2 client ID from 3CX Admin > Integrations > API |
| `THREECX_CLIENT_SECRET` | 3CX Sync | OAuth2 client secret |

### Optional Settings

These have sensible defaults but can be customized:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL` | `medium` | Multilingual Whisper model: `tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3` |
| `WHISPER_MODEL_EN` | `small.en` | English-only model for the second backend |
| `WHISPER_DEVICE` | `vulkan` | Device for whisper.cpp: `vulkan` (AMD/Intel iGPU) or `cpu` |
| `WHISPER_THREADS` | `4` | CPU threads for Whisper inference |
| `PIPER_VOICE` | `en_US-lessac-medium` | Piper TTS voice. Browse: https://rhasspy.github.io/piper-samples/ |
| `PARLER_MODEL` | `parler-tts/parler_tts_mini_v0.1` | Parler TTS model (high quality, slow) |
| `PARLER_THREADS` | `6` | CPU threads for Parler TTS |
| `DIAR_THREADS` | `4` | CPU threads for speaker diarization |
| `SYNC_CRON_SCHEDULE` | `*/15 * * * *` | Cron schedule for 3CX recording sync |
| `SYNC_ON_START` | `false` | Run sync immediately on container start |
| `THREECX_DN` | `100` | Default extension for call control |

### Example .env

```bash
# Minimal configuration for STT + TTS only
WHISPER_MODEL=medium
WHISPER_DEVICE=vulkan
WHISPER_THREADS=4
PIPER_VOICE=en_US-lessac-medium

# Add diarization (requires HF_TOKEN)
HF_TOKEN=hf_your_token_here

# Add 3CX integration (requires all three)
THREECX_FQDN=pbx.example.com
THREECX_CLIENT_ID=your-client-id
THREECX_CLIENT_SECRET=your-client-secret
```

## Services

LocalVoice is composed of independent microservices. Start only what you need.

### Core: Speech-to-Text + TTS

```bash
make stt-model         # Download Whisper model (run once)
make stt-model-en      # Download English model (run once)
make stt-up            # Start whisper-stt + whispercpp backends + piper-tts
```

Services started:
- **whisper-stt** (port 8080) — STT compatibility shim routing to whisper.cpp backends
- **whispercpp-backend** (port 8081) — Whisper.cpp multilingual inference (Vulkan GPU)
- **whispercpp-backend-en** (port 8082) — Whisper.cpp English-only inference (Vulkan GPU)
- **piper-tts** (port 8000) — Fast real-time TTS

### Optional: Web UI

```bash
make web-up
```

- **web** (port 7001) — Browser UI for recordings, transcription, playback

### Optional: Speaker Diarization

Requires `HF_TOKEN` in `.env`.

```bash
docker compose up -d --build diarization
```

- **diarization** (port 8090) — Speaker diarization and identification using pyannote.audio 3.1 with WeSpeaker ResNet34 embeddings. Runs CPU-only.

### Optional: 3CX Recording Sync

Requires `THREECX_FQDN`, `THREECX_CLIENT_ID`, `THREECX_CLIENT_SECRET` in `.env`.

```bash
make sync-up
```

- **3cx-sync** — Syncs recordings from 3CX PBX, transcribes via Whisper, diarizes speakers

### Optional: High-Quality TTS

```bash
docker compose --profile quality-tts up -d parler-tts
```

- **parler-tts** (port 8001) — Parler TTS for higher quality (slower, CPU-intensive)

### Optional: Kokoro TTS

```bash
docker compose up -d kokoro-tts
```

- **kokoro-tts** (port 8880) — Additional TTS engine

### Optional: 3CX CLI Tools


## Verify Installation

```bash
# Run integration tests
make test

# Or check individual services
curl http://localhost:8080/health   # Whisper STT
curl http://localhost:8000/health   # Piper TTS
curl http://localhost:8090/health   # Diarization
curl http://localhost:7001/         # Web UI
```

## CLI Tool

The CLI requires `bun` installed on the host:

```bash
# Transcribe an audio file
bun localvoice.ts transcribe recording.wav

# Transcribe with language hint
bun localvoice.ts transcribe recording.wav --language hi

# Text-to-speech
bun localvoice.ts speak "Hello world"

# Check service health
bun localvoice.ts health
```

## Data Storage

All persistent data lives in `./data/`:

| Path | Contents |
|------|----------|
| `data/3cx.db3` | SQLite database with recordings, transcriptions, diarization |
| `data/voices.db3` | Speaker enrollment profiles |
| `data/recordings/` | Audio files (Opus compressed) |
| `data/enrollments/` | Speaker voice samples |

Docker volumes store model weights:
- `whisper-models` — Whisper GGML model files
- `piper-models` — Piper voice model files
- `parler-models` — Parler TTS model files
- `diarization-models` — pyannote + WeSpeaker model files

## Ports Summary

| Port | Service | Protocol |
|------|---------|----------|
| 7001 | Web UI | HTTP |
| 8000 | Piper TTS | HTTP |
| 8001 | Parler TTS | HTTP |
| 8080 | Whisper STT | HTTP |
| 8090 | Diarization | HTTP |
| 8880 | Kokoro TTS | HTTP |

## Troubleshooting

**Whisper models not found:** Run `make stt-model` and `make stt-model-en` to download models into the shared volume.

**Diarization fails to start:** Ensure `HF_TOKEN` is set in `.env` and you have accepted model terms at https://huggingface.co/pyannote/speaker-diarization-3.1.

**3CX sync not running:** Verify all three `THREECX_*` credential variables are set. Check logs with `make sync-logs`.

**Vulkan not available:** Set `WHISPER_DEVICE=cpu` in `.env`. Vulkan requires `/dev/dri` access (AMD/Intel iGPU).

**Out of memory:** Reduce `WHISPER_MODEL` to `small` or `base`. The diarization service uses up to 4GB RAM.
