# Health — Service Health Check

Check the status of all LocalVoice Docker services (Whisper STT, Piper TTS, Parler TTS).

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Checking LocalVoice service health","voice_id":"YOUR_VOICE_ID_HERE","title":"LocalVoice"}'
```

## Execution

```bash
# Human-readable output (icons + table)
bun /home/rc/localvoice/localvoice.ts health

# Structured JSON output
bun /home/rc/localvoice/localvoice.ts health --json
```

## Interpreting Results

| Status | Icon | Meaning |
|---|---|---|
| `healthy` | `✓` | Service is running and ready to accept requests |
| `loading` | `~` | Service is starting up — wait and retry in 10-30 seconds |
| `unreachable` | `✗` | Service is down or not started — check Docker containers |

- **All healthy**: Proceed with transcribe/speak operations.
- **Any loading**: Wait briefly, then re-check. Models may still be loading into memory.
- **Any unreachable**: Run `docker ps` to verify containers are running. Restart if needed.
- **Errors**: The `error` field in JSON output contains the specific failure reason (connection refused, timeout, etc.).
