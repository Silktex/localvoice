# BatchSpeak — Parallel Text-to-Speech via Agent Swarm

Synthesize multiple texts into audio files in parallel using Claude Code's agent team system. Each text gets its own worker agent for maximum throughput.

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Starting batch speech synthesis swarm","voice_id":"YOUR_VOICE_ID_HERE","title":"LocalVoice"}'
```

## When to Use

- **3+ texts** to synthesize → use this workflow
- **1-2 texts** → use `Speak.md` instead (no swarm overhead)

## Swarm Execution

### Step 1: Identify Texts and Options

Collect all text strings from the user request. Determine shared options:

- `--engine piper|parler` (applied to all workers, default: piper)
- Output directory (default: current directory)

### Step 2: Create Agent Team

```
TeamCreate → team_name: "localvoice-batch-tts"
```

Then create one `TaskCreate` per text with subject: `"Speak: <first 30 chars>..."`.

### Step 3: Spawn Worker Agents

For **each** text, spawn a background worker with a sequential output filename:

- **subagent_type**: `"general-purpose"`
- **team_name**: `"localvoice-batch-tts"`
- **run_in_background**: `true`
- **Worker prompt**: `"Synthesize speech using the CLI: bun /home/rc/localvoice/localvoice.ts speak \"<TEXT>\" --json --output <output-dir>/output-NNN.wav [--engine <engine>]. Return the full JSON result."`

Output files named sequentially: `output-001.wav`, `output-002.wav`, `output-003.wav`, etc.

Launch all workers in a **single message** with parallel Task tool calls.

### Step 4: Collect Results

- Wait for all workers to complete
- Each worker returns JSON: `{ "engine": "...", "text": "...", "output": "...", "bytes": ... }`
- Aggregate results into a summary table showing file → text mapping

### Step 5: Cleanup

- Send `shutdown_request` to all workers
- `TeamDelete` to remove team and task list

## Example: 4 Sentences

User: "Generate audio for these 4 chapter intros using parler engine"

```
1. Parse 4 text strings from user input
2. TeamCreate: "localvoice-batch-tts"
3. TaskCreate × 4 (one per text)
4. Task (spawn worker) × 4 in parallel:
   - Worker 1: bun /home/rc/localvoice/localvoice.ts speak "Welcome to chapter one" --json --output output-001.wav --engine parler
   - Worker 2: bun /home/rc/localvoice/localvoice.ts speak "The journey continues in chapter two" --json --output output-002.wav --engine parler
   - Worker 3: bun /home/rc/localvoice/localvoice.ts speak "Chapter three brings new challenges" --json --output output-003.wav --engine parler
   - Worker 4: bun /home/rc/localvoice/localvoice.ts speak "Our story concludes in chapter four" --json --output output-004.wav --engine parler
5. Collect 4 JSON results → present file listing with sizes
6. Cleanup: shutdown workers + TeamDelete
```
