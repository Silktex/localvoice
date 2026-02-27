# Speak — Text-to-Speech Workflow

Single-text speech synthesis using the LocalVoice CLI (Piper or Parler TTS).

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Generating speech audio now","voice_id":"YOUR_VOICE_ID_HERE","title":"LocalVoice"}'
```

## Intent-to-Flag Mapping

| User says | Flag | Example |
|---|---|---|
| "fast", "piper", *(default)* | `--engine piper` | `--engine piper` |
| "high quality", "parler" | `--engine parler` | `--engine parler` |
| "save as X", "output to X" | `--output X` | `--output greeting.wav` |
| *(default)* | `--output output.wav` | `--output output.wav` |
| "calm voice", "excited", any voice style *(parler only)* | `--description "<desc>"` | `--description "A calm female speaker"` |
| "as JSON", "structured" | `--json` | `--json` |

## Execution

Construct and run:

```bash
bun /home/rc/localvoice/localvoice.ts speak "<text>" [--engine piper|parler] [--output <file>] [--description "<desc>"] [--json]
```

**Examples:**
```bash
# Basic speech (piper, fast)
bun /home/rc/localvoice/localvoice.ts speak "Hello world"

# High-quality with voice description
bun /home/rc/localvoice/localvoice.ts speak "Welcome to the demo" --engine parler --description "A warm, calm male speaker"

# Custom output path with JSON result
bun /home/rc/localvoice/localvoice.ts speak "Test audio" --output test.wav --json
```

## Output Handling

- **Default**: Prints `saved <bytes> bytes to <output-file>` to stdout.
- **`--json`**: Outputs structured JSON with `engine`, `text`, `output`, and `bytes` fields.
- **Audio file**: Written to `--output` path (default `output.wav`) in WAV format.
- **Errors**: Exit code 1 with `error:` prefix on stderr. Verify TTS service is running (`bun /home/rc/localvoice/localvoice.ts health`).
