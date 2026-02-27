# Transcribe — Speech-to-Text Workflow

Single-file audio transcription using the LocalVoice CLI (Whisper STT).

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Transcribing audio file now","voice_id":"YOUR_VOICE_ID_HERE","title":"LocalVoice"}'
```

## Intent-to-Flag Mapping

| User says | Flag | Example |
|---|---|---|
| "in English" | `--language en` | `--language en` |
| "in Spanish" | `--language es` | `--language es` |
| "in French" | `--language fr` | `--language fr` |
| "in German" | `--language de` | `--language de` |
| "in Japanese" | `--language ja` | `--language ja` |
| *(any language)* | `--language <ISO 639-1>` | `--language pt` |
| "just the text", "plain text" | `--format text` | `--format text` |
| *(default)* | `--format json` | `--format json` |
| "as JSON", "structured" | `--json` | `--json` |

## Execution

Construct and run:

```bash
bun /home/rc/localvoice/localvoice.ts transcribe <audio-file> [--language <lang>] [--format json|text] [--json]
```

**Examples:**
```bash
# Basic transcription
bun /home/rc/localvoice/localvoice.ts transcribe recording.wav

# English, plain text output
bun /home/rc/localvoice/localvoice.ts transcribe meeting.mp3 --language en --format text

# Structured JSON output
bun /home/rc/localvoice/localvoice.ts transcribe call.ogg --language es --json
```

## Output Handling

- **Default** (`--format json`, no `--json`): Prints the transcribed text string to stdout.
- **`--format text`**: Prints raw text directly, no metadata.
- **`--json`**: Outputs structured JSON with `text`, `language`, `duration`, and `file` fields.
- **Errors**: Exit code 1 with `error:` prefix on stderr. Check that the audio file exists and the STT service is running (`bun /home/rc/localvoice/localvoice.ts health`).
