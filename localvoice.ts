#!/usr/bin/env bun
/**
 * localvoice — CLI for the LocalVoice Docker voice stack
 *
 * Wraps the STT (Whisper) and TTS (Piper, Parler) HTTP APIs.
 * Zero dependencies — uses Bun's native fetch and fs.
 */

// ── Configuration ──────────────────────────────────────────────────

interface Config {
  sttUrl: string;
  piperUrl: string;
  parlerUrl: string;
}

function loadConfig(): Config {
  return {
    sttUrl: process.env.LOCALVOICE_STT_URL ?? "http://localhost:8080",
    piperUrl: process.env.LOCALVOICE_PIPER_URL ?? "http://localhost:8000",
    parlerUrl: process.env.LOCALVOICE_PARLER_URL ?? "http://localhost:8001",
  };
}

// ── Types ──────────────────────────────────────────────────────────

interface HealthStatus {
  service: string;
  url: string;
  status: string;
  details: Record<string, unknown> | null;
  error: string | null;
}

interface TranscribeResult {
  text: string;
  language?: string;
  duration?: number;
  file: string;
}

interface SpeakResult {
  engine: string;
  text: string;
  output: string;
  bytes: number;
}

interface SpeakersResult {
  engine: string;
  speakers: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[arg.slice(1)] = next;
        i++;
      } else {
        flags[arg.slice(1)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function flag(flags: Record<string, string | true>, ...names: string[]): string | true | undefined {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name];
  }
  return undefined;
}

function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ── Commands ───────────────────────────────────────────────────────

async function cmdHealth(config: Config, flags: Record<string, string | true>): Promise<void> {
  const services = [
    { name: "whisper-stt", url: config.sttUrl },
    { name: "piper-tts", url: config.piperUrl },
    { name: "parler-tts", url: config.parlerUrl },
  ];

  const results: HealthStatus[] = [];

  for (const svc of services) {
    try {
      const resp = await fetch(`${svc.url}/health`, { signal: AbortSignal.timeout(5000) });
      const data = (await resp.json()) as Record<string, unknown>;
      results.push({
        service: svc.name,
        url: svc.url,
        status: (data.status as string) ?? "unknown",
        details: data,
        error: null,
      });
    } catch (err) {
      results.push({
        service: svc.name,
        url: svc.url,
        status: "unreachable",
        details: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (flag(flags, "json")) {
    jsonOut(results);
    return;
  }

  for (const r of results) {
    const icon = r.status === "healthy" ? "✓" : r.status === "loading" ? "~" : "✗";
    console.log(`${icon} ${r.service.padEnd(14)} ${r.status.padEnd(14)} ${r.url}`);
    if (r.error) console.log(`  error: ${r.error}`);
  }
}

async function cmdTranscribe(
  config: Config,
  positional: string[],
  flags: Record<string, string | true>,
): Promise<void> {
  const filePath = positional[0];
  if (!filePath) die("usage: localvoice transcribe <audio-file> [--language <lang>] [--format <json|text>]");

  const file = Bun.file(filePath);
  if (!(await file.exists())) die(`file not found: ${filePath}`);

  const language = flag(flags, "language", "l");
  const format = flag(flags, "format", "f") ?? "json";

  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", "whisper-1");
  formData.append("response_format", typeof format === "string" ? format : "json");
  if (typeof language === "string") formData.append("language", language);

  let resp: Response;
  try {
    resp = await fetch(`${config.sttUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: formData,
    });
  } catch (err) {
    die(`whisper-stt unreachable at ${config.sttUrl}: ${err instanceof Error ? err.message : err}`);
  }

  if (!resp.ok) {
    const body = await resp.text();
    die(`transcription failed (${resp.status}): ${body}`);
  }

  if (format === "text") {
    const text = await resp.text();
    if (flag(flags, "json")) {
      jsonOut({ text, file: filePath } as TranscribeResult);
    } else {
      console.log(text);
    }
    return;
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const result: TranscribeResult = {
    text: (data.text as string) ?? "",
    language: data.language as string | undefined,
    duration: data.duration as number | undefined,
    file: filePath,
  };

  if (flag(flags, "json")) {
    jsonOut(result);
  } else {
    console.log(result.text);
  }
}

async function cmdSpeak(
  config: Config,
  positional: string[],
  flags: Record<string, string | true>,
): Promise<void> {
  const text = positional.join(" ");
  if (!text) die("usage: localvoice speak <text> [--engine piper|parler] [--output <file>] [--description <desc>]");

  const engine = (flag(flags, "engine", "e") ?? "piper") as string;
  const output = (flag(flags, "output", "o") ?? "output.wav") as string;
  const description = flag(flags, "description", "d");

  let baseUrl: string;
  if (engine === "parler") {
    baseUrl = config.parlerUrl;
  } else if (engine === "piper") {
    baseUrl = config.piperUrl;
  } else {
    die(`unknown engine: ${engine}. Use 'piper' or 'parler'`);
  }

  const body: Record<string, string> = { text };
  if (typeof description === "string") body.description = description;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(`${engine} TTS unreachable at ${baseUrl}: ${err instanceof Error ? err.message : err}`);
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    die(`TTS failed (${resp.status}): ${errBody}`);
  }

  const audioBuffer = await resp.arrayBuffer();
  await Bun.write(output, audioBuffer);

  const result: SpeakResult = {
    engine,
    text,
    output,
    bytes: audioBuffer.byteLength,
  };

  if (flag(flags, "json")) {
    jsonOut(result);
  } else {
    console.log(`saved ${result.bytes} bytes to ${output}`);
  }
}

async function cmdSpeakers(config: Config, flags: Record<string, string | true>): Promise<void> {
  const engines = [
    { name: "piper", url: config.piperUrl },
    { name: "parler", url: config.parlerUrl },
  ];

  const results: SpeakersResult[] = [];

  for (const eng of engines) {
    try {
      const resp = await fetch(`${eng.url}/speakers`, { signal: AbortSignal.timeout(5000) });
      const data = (await resp.json()) as unknown;
      results.push({ engine: eng.name, speakers: data });
    } catch {
      results.push({ engine: eng.name, speakers: { error: "unreachable" } });
    }
  }

  if (flag(flags, "json")) {
    jsonOut(results);
    return;
  }

  for (const r of results) {
    console.log(`\n── ${r.engine} ──`);
    console.log(JSON.stringify(r.speakers, null, 2));
  }
}

// ── Help ───────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`localvoice — CLI for the LocalVoice Docker voice stack

USAGE
  localvoice <command> [options]

COMMANDS
  transcribe <file>   Transcribe an audio file using Whisper STT
  speak <text>         Synthesize speech using Piper or Parler TTS
  health               Check health of all services
  speakers             List available TTS speakers

TRANSCRIBE OPTIONS
  --language, -l <lang>   Language hint (e.g. en, es, fr)
  --format, -f <fmt>      Response format: json (default) or text
  --json                  Output structured JSON

SPEAK OPTIONS
  --engine, -e <name>     TTS engine: piper (default) or parler
  --output, -o <file>     Output file (default: output.wav)
  --description, -d <d>   Voice description (parler only)
  --json                  Output structured JSON

GLOBAL OPTIONS
  --json                  Force JSON output for any command
  --help, -h              Show this help

ENVIRONMENT
  LOCALVOICE_STT_URL      Whisper STT base URL (default: http://localhost:8080)
  LOCALVOICE_PIPER_URL    Piper TTS base URL  (default: http://localhost:8000)
  LOCALVOICE_PARLER_URL   Parler TTS base URL (default: http://localhost:8001)

EXAMPLES
  localvoice transcribe recording.wav
  localvoice transcribe meeting.mp3 --language en --json
  localvoice speak "Hello world"
  localvoice speak "Bonjour" --engine parler --description "A calm male speaker"
  localvoice speak "Test" -o test.wav --json
  localvoice health
  localvoice health --json
  localvoice speakers`);
}

function showCommandHelp(command: string): void {
  switch (command) {
    case "transcribe":
      console.log(`localvoice transcribe — Transcribe audio files

USAGE
  localvoice transcribe <audio-file> [options]

OPTIONS
  --language, -l <lang>   Language hint (e.g. en, es, fr)
  --format, -f <fmt>      Response format: json (default) or text
  --json                  Output structured JSON

EXAMPLES
  localvoice transcribe recording.wav
  localvoice transcribe meeting.mp3 -l en
  localvoice transcribe call.ogg --format text`);
      break;
    case "speak":
      console.log(`localvoice speak — Synthesize speech from text

USAGE
  localvoice speak <text> [options]

OPTIONS
  --engine, -e <name>     TTS engine: piper (default) or parler
  --output, -o <file>     Output file (default: output.wav)
  --description, -d <d>   Voice description (parler engine only)
  --json                  Output structured JSON

EXAMPLES
  localvoice speak "Hello world"
  localvoice speak "Bonjour" --engine parler
  localvoice speak "Test" -o test.wav --json`);
      break;
    case "health":
      console.log(`localvoice health — Check service health

USAGE
  localvoice health [--json]

Queries /health on all three services (whisper-stt, piper-tts, parler-tts).`);
      break;
    case "speakers":
      console.log(`localvoice speakers — List TTS speakers

USAGE
  localvoice speakers [--json]

Queries /speakers on piper-tts and parler-tts.`);
      break;
    default:
      showHelp();
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const { positional, flags: parsedFlags } = parseArgs(args);
  const command = positional[0];
  const restPositional = positional.slice(1);

  if (flag(parsedFlags, "help", "h")) {
    if (command) {
      showCommandHelp(command);
    } else {
      showHelp();
    }
    process.exit(0);
  }

  const config = loadConfig();

  switch (command) {
    case "health":
      await cmdHealth(config, parsedFlags);
      break;
    case "transcribe":
      await cmdTranscribe(config, restPositional, parsedFlags);
      break;
    case "speak":
      await cmdSpeak(config, restPositional, parsedFlags);
      break;
    case "speakers":
      await cmdSpeakers(config, parsedFlags);
      break;
    case "help":
      showHelp();
      break;
    default:
      die(`unknown command: ${command}. Run 'localvoice --help' for usage.`);
  }
}

main().catch((err: unknown) => {
  die(err instanceof Error ? err.message : String(err));
});
