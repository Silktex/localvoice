# BatchTranscribe — Parallel Audio Transcription via Agent Swarm

Transcribe multiple audio files in parallel using Claude Code's agent team system. Each file gets its own worker agent for maximum throughput.

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Starting batch transcription swarm","voice_id":"YOUR_VOICE_ID_HERE","title":"LocalVoice"}'
```

## When to Use

- **3+ audio files** to transcribe → use this workflow
- **1-2 files** → use `Transcribe.md` instead (no swarm overhead)

## Swarm Execution

### Step 1: Identify Files

Collect all audio file paths from the user request. Use Glob for patterns if needed:

```
*.wav, *.mp3, *.ogg, *.flac, *.m4a, recordings/*.wav
```

Verify each file exists before spawning workers.

### Step 2: Create Agent Team

```
TeamCreate → team_name: "localvoice-batch-stt"
```

Then create one `TaskCreate` per audio file with subject: `"Transcribe <filename>"`.

### Step 3: Spawn Worker Agents

For **each** audio file, spawn a background worker:

- **subagent_type**: `"general-purpose"`
- **team_name**: `"localvoice-batch-stt"`
- **run_in_background**: `true`
- **Worker prompt**: `"Transcribe this audio file using the CLI: bun /home/rc/localvoice/localvoice.ts transcribe <FILE_PATH> --json. Return the full JSON result."`

Launch all workers in a **single message** with parallel Task tool calls.

### Step 4: Collect Results

- Wait for all workers to complete
- Each worker returns JSON: `{ "text": "...", "language": "...", "duration": ..., "file": "..." }`
- Aggregate all results into a summary table or combined JSON array

### Step 5: Cleanup

- Send `shutdown_request` to all workers
- `TeamDelete` to remove team and task list

## Example: 5 Files

User: "Transcribe all wav files in ~/recordings"

```
1. Glob: ~/recordings/*.wav → found 5 files
2. TeamCreate: "localvoice-batch-stt"
3. TaskCreate × 5 (one per file)
4. Task (spawn worker) × 5 in parallel:
   - Worker 1: bun /home/rc/localvoice/localvoice.ts transcribe ~/recordings/meeting-01.wav --json
   - Worker 2: bun /home/rc/localvoice/localvoice.ts transcribe ~/recordings/meeting-02.wav --json
   - Worker 3: bun /home/rc/localvoice/localvoice.ts transcribe ~/recordings/interview.wav --json
   - Worker 4: bun /home/rc/localvoice/localvoice.ts transcribe ~/recordings/call-notes.wav --json
   - Worker 5: bun /home/rc/localvoice/localvoice.ts transcribe ~/recordings/voicemail.wav --json
5. Collect 5 JSON results → present combined transcriptions
6. Cleanup: shutdown workers + TeamDelete
```
