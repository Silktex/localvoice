# LocalVoice API Reference

Complete endpoint reference for all three LocalVoice Docker services.

## Whisper STT (Speech-to-Text)

**Default URL:** `http://localhost:8080`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Service health check |
| `/v1/audio/transcriptions` | POST | OpenAI-compatible transcription (multipart form) |
| `/transcribe` | POST | Simple transcription (multipart form) |

### POST /v1/audio/transcriptions

**Form fields:**
- `file` (required) — Audio file (WAV, MP3, OGG, etc.)
- `model` — Model name (default: `whisper-1`, ignored — uses configured model)
- `language` — Language hint (e.g. `en`, `es`, `fr`)
- `response_format` — `json` (default) or `text`

**Response (JSON):** `{ "text": "transcribed text" }`

### POST /transcribe

**Form fields:**
- `file` (required) — Audio file
- `language` — Language hint

**Response:** `{ "text": "...", "language": "en", "duration": 12.5 }`

## Piper TTS (Fast Text-to-Speech)

**Default URL:** `http://localhost:8000`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Service health check |
| `/tts` | POST | Synthesize speech (returns WAV or PCM) |
| `/tts/base64` | POST | Synthesize speech (returns base64 audio) |
| `/speakers` | GET | List available speakers |

### POST /tts

**JSON body:** `{ "text": "Hello world" }`
**Query params:** `output_format=pcm_8k` (optional, for raw PCM 8kHz)
**Response:** WAV audio bytes (Content-Type: audio/wav)

## Parler TTS (High-Quality Text-to-Speech)

**Default URL:** `http://localhost:8001`
**Profile:** `quality-tts` (must be started with `--profile quality-tts`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Service health check |
| `/tts` | POST | Synthesize speech with voice description |
| `/tts/base64` | POST | Synthesize speech as base64 |
| `/speakers` | GET | List speakers |

### POST /tts

**JSON body:** `{ "text": "Hello world", "description": "A calm female speaker" }`
**Query params:** `output_format=pcm_8k` (optional)
**Response:** WAV audio bytes

## Docker Services

| Service | Container | Port | Model |
|---------|-----------|------|-------|
| whisper-stt | localvoice-whisper-stt | 8080 | `$WHISPER_MODEL` (default: small) |
| whispercpp-backend | localvoice-whispercpp-backend | 8081 (internal) | Same model, ggml format |
| piper-tts | localvoice-piper-tts | 8000 | `$PIPER_VOICE` (default: en_US-lessac-medium) |
| parler-tts | localvoice-parler-tts | 8001 | `$PARLER_MODEL` (default: parler_tts_mini_v0.1) |
