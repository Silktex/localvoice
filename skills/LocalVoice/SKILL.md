---
name: LocalVoice
description: Local voice stack CLI for transcription and speech synthesis. USE WHEN transcribe, transcription, speech to text, text to speech, TTS, STT, speak, synthesize voice, whisper, piper, parler, batch transcribe, voice services, audio to text, localvoice.
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/skills/PAI/USER/SKILLCUSTOMIZATIONS/LocalVoice/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# LocalVoice

CLI interface to the LocalVoice Docker voice stack — Whisper STT (port 8080), Piper TTS (port 8000), and Parler TTS (port 8001).

**CLI Tool:** `/home/rc/localvoice/localvoice.ts` (Bun + TypeScript, zero dependencies)

## Voice Notification

**When executing a workflow, do BOTH:**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running WORKFLOWNAME in LocalVoice skill"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running **WorkflowName** in **LocalVoice** skill...
   ```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Transcribe** | "transcribe this file", "speech to text", single audio file | `Workflows/Transcribe.md` |
| **Speak** | "say this", "text to speech", "speak", single text | `Workflows/Speak.md` |
| **Health** | "check voice services", "localvoice health", "are services up" | `Workflows/Health.md` |
| **BatchTranscribe** | "transcribe these files", "batch transcribe", 3+ audio files | `Workflows/BatchTranscribe.md` |
| **BatchSpeak** | "speak all of these", "batch TTS", 3+ texts to synthesize | `Workflows/BatchSpeak.md` |

**Routing logic:** If 3+ files/texts → use Batch variant (agent swarm). Otherwise → use single variant.

## Quick Reference

- **Transcribe:** `bun /home/rc/localvoice/localvoice.ts transcribe <file> [--language en] [--json]`
- **Speak:** `bun /home/rc/localvoice/localvoice.ts speak "<text>" [--engine piper|parler] [--output out.wav]`
- **Health:** `bun /home/rc/localvoice/localvoice.ts health [--json]`
- **Speakers:** `bun /home/rc/localvoice/localvoice.ts speakers [--json]`

**Full API details:** `ApiReference.md`

## Examples

**Example 1: Transcribe a meeting recording**
```
User: "Transcribe this recording: ~/meetings/standup.wav"
→ Invokes Transcribe workflow
→ Runs: bun localvoice.ts transcribe ~/meetings/standup.wav --json
→ Returns transcription text to user
```

**Example 2: Generate speech from text**
```
User: "Say 'Welcome to the demo' using the high quality voice"
→ Invokes Speak workflow
→ Detects "high quality" → --engine parler
→ Runs: bun localvoice.ts speak "Welcome to the demo" --engine parler -o welcome.wav
→ Returns path to generated audio file
```

**Example 3: Batch transcribe a folder of recordings**
```
User: "Transcribe all the wav files in ~/interviews/"
→ Invokes BatchTranscribe workflow (3+ files detected)
→ Creates agent team "localvoice-batch-stt"
→ Spawns N parallel worker agents, each transcribes one file
→ Collects and presents all transcriptions
```

**Example 4: Check if voice services are running**
```
User: "Are the voice services up?"
→ Invokes Health workflow
→ Runs: bun localvoice.ts health
→ Reports status of whisper-stt, piper-tts, parler-tts
```

## Environment Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOCALVOICE_STT_URL` | `http://localhost:8080` | Whisper STT base URL |
| `LOCALVOICE_PIPER_URL` | `http://localhost:8000` | Piper TTS base URL |
| `LOCALVOICE_PARLER_URL` | `http://localhost:8001` | Parler TTS base URL |
