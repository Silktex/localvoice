/**
 * LocalVoice Web Server
 *
 * Bun HTTP server providing:
 * - 3CX XAPI proxy (read-only: recordings list + download)
 * - LocalVoice proxy (STT via Whisper, TTS via Piper/Parler)
 * - Health checks for all services
 * - Sync status & model management APIs
 * - Static file serving for the frontend
 */

import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import { Database } from "bun:sqlite";
import { WHISPER_MODELS } from "./models";

// ── Configuration ──────────────────────────────────────────────────

interface ThreeCXConfig {
  fqdn: string;
  client_id: string;
  client_secret: string;
  access_token?: string;
  token_expiry?: number;
}

// Load 3CX config: env vars take priority, fall back to .3cx-config.json
function loadThreeCXFileConfig(): Partial<ThreeCXConfig> {
  const configPath = join(import.meta.dir, "..", ".3cx-config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

const fileConfig = loadThreeCXFileConfig();
const THREECX_FQDN = process.env.THREECX_FQDN || fileConfig.fqdn || "";
const THREECX_CLIENT_ID = process.env.THREECX_CLIENT_ID || fileConfig.client_id || "";
const THREECX_CLIENT_SECRET = process.env.THREECX_CLIENT_SECRET || fileConfig.client_secret || "";

const PORT = Number(process.env.PORT ?? "7001");
const PUBLIC_DIR = join(import.meta.dir, "public");
const DB_PATH = process.env.DB_PATH ?? "/data/3cx.db3";
const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? "/data/recordings";

// Open local SQLite DB (read-only for serving)
let localDb: Database | null = null;
function getLocalDb(): Database | null {
  if (localDb) return localDb;
  if (!existsSync(DB_PATH)) return null;
  localDb = new Database(DB_PATH, { readonly: true });
  return localDb;
}

const LOCALVOICE = {
  stt: process.env.LOCALVOICE_STT_URL ?? "http://localhost:8080",
  piper: process.env.LOCALVOICE_PIPER_URL ?? "http://localhost:8000",
  parler: process.env.LOCALVOICE_PARLER_URL ?? "http://localhost:8001",
};

// ── Token Management ───────────────────────────────────────────────

// Seed token cache from config file if available
let cachedToken: string | null = fileConfig.access_token ?? null;
let tokenExpiry = fileConfig.token_expiry ?? 0;

function loadConfig(): ThreeCXConfig {
  return {
    fqdn: THREECX_FQDN,
    client_id: THREECX_CLIENT_ID,
    client_secret: THREECX_CLIENT_SECRET,
  };
}

async function getToken(): Promise<string> {
  const now = Date.now() / 1000;

  // Return cached token if still valid (30s safety buffer)
  if (cachedToken && tokenExpiry > now + 30) {
    return cachedToken;
  }

  const config = loadConfig();

  // Request new token via OAuth2 client credentials
  const resp = await fetch(`https://${config.fqdn}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      grant_type: "client_credentials",
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in?: number };
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in ?? 3600);
  return cachedToken;
}

async function threecxHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function threecxUrl(path: string): string {
  const config = loadConfig();
  return `https://${config.fqdn}/xapi/v1/${path}`;
}

// ── MIME Types ──────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".opus": "audio/ogg; codecs=opus",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Route Handlers ─────────────────────────────────────────────────

async function handleRecordingsList(url: URL): Promise<Response> {
  const top = url.searchParams.get("top") ?? "25";
  const skip = url.searchParams.get("skip") ?? "0";

  // Try 3CX XAPI first
  if (THREECX_FQDN) {
    try {
      const headers = await threecxHeaders();
      const params = new URLSearchParams({
        $top: top,
        $skip: skip,
        $orderby: "Id desc",
      });
      const resp = await fetch(`${threecxUrl("Recordings")}?${params}`, { headers });
      if (resp.ok) {
        const body = await resp.json();
        return Response.json(body, { status: resp.status });
      }
    } catch {
      // Fall through to local DB
    }
  }

  // Fallback: serve from local SQLite DB
  const db = getLocalDb();
  if (db) {
    const rows = db.query(
      "SELECT id AS Id, from_display_name AS FromDisplayName, to_display_name AS ToDisplayName, " +
      "from_caller_number AS FromCallerNumber, to_caller_number AS ToCallerNumber, " +
      "call_type AS CallType, duration AS Duration, start_time AS StartTime, " +
      "local_transcription AS Transcription, summary AS Summary " +
      "FROM recordings ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(Number(top), Number(skip));
    return Response.json({ value: rows });
  }

  return Response.json({ value: [], error: "3CX unavailable and no local database" });
}

async function handleRecordingAudio(id: string): Promise<Response> {
  const token = await getToken();
  const resp = await fetch(
    threecxUrl(`Recordings/Pbx.DownloadRecording(recId=${id})`),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    return new Response(`Download failed: ${resp.status}`, { status: resp.status });
  }
  const buffer = await resp.arrayBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": `inline; filename="recording_${id}.wav"`,
      "Content-Length": buffer.byteLength.toString(),
      "Accept-Ranges": "bytes",
    },
  });
}

async function handleSTT(req: Request): Promise<Response> {
  const formData = await req.formData();
  const resp = await fetch(`${LOCALVOICE.stt}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
  });
  const body = await resp.json();
  return Response.json(body, { status: resp.status });
}

async function handleTTS(req: Request): Promise<Response> {
  const body = (await req.json()) as { text: string; engine?: string; description?: string };
  const engine = body.engine ?? "piper";
  const baseUrl = engine === "parler" ? LOCALVOICE.parler : LOCALVOICE.piper;
  const engineLabel = engine === "parler" ? "Parler" : "Piper";

  const ttsBody: Record<string, string> = { text: body.text };
  if (body.description) ttsBody.description = body.description;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ttsBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("ConnectionRefused") || msg.includes("fetch failed") || msg.includes("Unable to connect")) {
      return Response.json(
        { error: `${engineLabel} TTS service is not running. Start it with: docker compose --profile quality-tts up -d` },
        { status: 503 },
      );
    }
    return Response.json({ error: `${engineLabel} TTS service unavailable: ${msg}` }, { status: 503 });
  }

  if (!resp.ok) {
    const err = await resp.text();
    return Response.json({ error: err || `${engineLabel} TTS returned ${resp.status}` }, { status: resp.status });
  }

  return new Response(resp.body, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": 'attachment; filename="speech.wav"',
    },
  });
}

async function handleHealth(): Promise<Response> {
  const services = [
    { name: "3cx", check: () => checkThreeCX() },
    { name: "whisper", check: () => checkService(LOCALVOICE.stt) },
    { name: "piper", check: () => checkService(LOCALVOICE.piper) },
    { name: "parler", check: () => checkService(LOCALVOICE.parler) },
  ];

  const results = await Promise.all(
    services.map(async (svc) => {
      try {
        const status = await svc.check();
        return { name: svc.name, status };
      } catch {
        return { name: svc.name, status: "error" };
      }
    }),
  );

  return Response.json(results);
}

async function checkThreeCX(): Promise<string> {
  const headers = await threecxHeaders();
  const resp = await fetch(threecxUrl("SystemStatus"), {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  return resp.ok ? "healthy" : "error";
}

async function checkService(baseUrl: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return "error";
  const data = (await resp.json()) as { status?: string };
  return data.status === "healthy" ? "healthy" : data.status ?? "unknown";
}

// ── Sync Status ────────────────────────────────────────────────────

async function handleSyncStatus(): Promise<Response> {
  const db = getLocalDb();
  if (!db) return Response.json({ error: "Database not available" }, { status: 503 });
  const rows = db.query("SELECT sync_status, COUNT(*) as count FROM recordings GROUP BY sync_status").all() as Array<{sync_status: string, count: number}>;
  const total = db.query("SELECT COUNT(*) as count FROM recordings").get() as {count: number};
  return Response.json({ statuses: rows, total: total.count });
}

// ── Models ─────────────────────────────────────────────────────────

async function handleModels(): Promise<Response> {
  try {
    const sttResp = await fetch(`${LOCALVOICE.stt}/models`, { signal: AbortSignal.timeout(5000) });
    if (sttResp.ok) {
      const active = await sttResp.json();
      return Response.json({ models: WHISPER_MODELS, active });
    }
  } catch {}
  return Response.json({ models: WHISPER_MODELS, active: [] });
}

async function handleModelsCurrent(): Promise<Response> {
  try {
    const resp = await fetch(`${LOCALVOICE.stt}/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return Response.json(await resp.json());
  } catch {}
  return Response.json({ error: "STT service unavailable" }, { status: 503 });
}

// ── Recording Detail & Local Audio ─────────────────────────────────

interface RecordingDetail {
  id: number;
  from_display_name: string | null;
  to_display_name: string | null;
  from_caller_number: string | null;
  to_caller_number: string | null;
  call_type: string | null;
  duration: number | null;
  local_transcription: string | null;
  segments_json: string | null;
  opus_path: string | null;
  summary: string | null;
}

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

function assignSpeakers(segments: Segment[], fromName: string | null, toName: string | null): Segment[] {
  const caller = fromName || "Caller";
  const called = toName || "Called";
  let currentSpeaker = caller;

  return segments.map((seg, i) => {
    if (i > 0) {
      const prevEnd = segments[i - 1].end;
      const gap = seg.start - prevEnd;
      if (gap > 1.0) {
        currentSpeaker = currentSpeaker === caller ? called : caller;
      }
    }
    return { ...seg, speaker: currentSpeaker };
  });
}

function handleRecordingDetail(id: string): Response {
  const db = getLocalDb();
  if (!db) {
    return Response.json({ error: "Local database not available" }, { status: 503 });
  }

  const numId = parseInt(id, 10);
  if (isNaN(numId)) {
    return Response.json({ error: "Invalid recording ID" }, { status: 400 });
  }

  const row = db.query(
    "SELECT id, from_display_name, to_display_name, from_caller_number, to_caller_number, " +
    "call_type, duration, local_transcription, segments_json, opus_path, summary " +
    "FROM recordings WHERE id = ?"
  ).get(numId) as RecordingDetail | null;

  if (!row) {
    return Response.json({ error: "Recording not found in local DB" }, { status: 404 });
  }

  let segments: Segment[] = [];
  if (row.segments_json) {
    try {
      segments = JSON.parse(row.segments_json);
      segments = assignSpeakers(segments, row.from_display_name, row.to_display_name);
    } catch {
      segments = [];
    }
  }

  return Response.json({
    id: row.id,
    from_display_name: row.from_display_name,
    to_display_name: row.to_display_name,
    from_caller_number: row.from_caller_number,
    to_caller_number: row.to_caller_number,
    call_type: row.call_type,
    duration: row.duration,
    transcription: row.local_transcription,
    segments,
    has_opus: !!row.opus_path,
    summary: row.summary,
  });
}

async function handleRecordingAudioLocal(id: string): Promise<Response | null> {
  const db = getLocalDb();
  if (!db) return null;

  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;

  const row = db.query("SELECT opus_path FROM recordings WHERE id = ?").get(numId) as { opus_path: string | null } | null;
  if (!row?.opus_path) return null;

  const opusFile = join(RECORDINGS_DIR, row.opus_path);
  if (!existsSync(opusFile)) return null;

  return new Response(Bun.file(opusFile), {
    headers: {
      "Content-Type": "audio/ogg; codecs=opus",
      "Content-Disposition": `inline; filename="recording_${id}.opus"`,
    },
  });
}

function serveStatic(pathname: string): Response {
  const filePath = pathname === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, pathname);

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  return new Response(file, {
    headers: { "Content-Type": contentType },
  });
}

// ── Server ─────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // API Routes
      if (path === "/api/recordings" && req.method === "GET") {
        return await handleRecordingsList(url);
      }

      const detailMatch = path.match(/^\/api\/recordings\/(\d+)\/detail$/);
      if (detailMatch && req.method === "GET") {
        return handleRecordingDetail(detailMatch[1]);
      }

      const audioMatch = path.match(/^\/api\/recordings\/(\d+)\/audio$/);
      if (audioMatch && req.method === "GET") {
        // Try local Opus first, fall back to 3CX proxy
        const localResp = await handleRecordingAudioLocal(audioMatch[1]);
        if (localResp) return localResp;
        return await handleRecordingAudio(audioMatch[1]);
      }

      if (path === "/api/stt" && req.method === "POST") {
        return await handleSTT(req);
      }

      if (path === "/api/tts" && req.method === "POST") {
        return await handleTTS(req);
      }

      if (path === "/api/health" && req.method === "GET") {
        return await handleHealth();
      }

      // New API routes
      if (path === "/api/sync/status" && req.method === "GET") {
        return await handleSyncStatus();
      }

      if (path === "/api/sync/trigger" && req.method === "POST") {
        return Response.json({ message: "Manual sync trigger not yet implemented" }, { status: 501 });
      }

      if (path === "/api/models" && req.method === "GET") {
        return await handleModels();
      }

      if (path === "/api/models/current" && req.method === "GET") {
        return await handleModelsCurrent();
      }

      // Static files
      return serveStatic(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${req.method} ${path}] ${message}`);
      return Response.json({ error: message }, { status: 500 });
    }
  },
});

console.log(`LocalVoice Web UI running at http://localhost:${PORT}`);
