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
  try {
    localDb = new Database(DB_PATH, { readonly: true });
  } catch {
    return null;
  }
  return localDb;
}

const LOCALVOICE = {
  stt: process.env.LOCALVOICE_STT_URL ?? "http://localhost:8080",
  piper: process.env.LOCALVOICE_PIPER_URL ?? "http://localhost:8000",
  kokoro: process.env.LOCALVOICE_KOKORO_URL ?? "http://localhost:8880",
  diarization: process.env.LOCALVOICE_DIAR_URL ?? "http://localhost:8090",
};

const VOICE_PREFIX_LABELS: Record<string, string> = {
  af: "American Female", am: "American Male",
  bf: "British Female", bm: "British Male",
  ef: "European Female", em: "European Male",
  ff: "French Female", hf: "Hindi Female", hm: "Hindi Male",
  if: "Italian Female", im: "Italian Male",
  jf: "Japanese Female", jm: "Japanese Male",
  pf: "Portuguese Female", pm: "Portuguese Male",
  zf: "Chinese Female", zm: "Chinese Male",
};

const RETRANSCRIBE_RESET =
  "UPDATE recordings SET sync_status='downloaded', local_transcription=NULL, segments_json=NULL, " +
  "local_language=NULL, local_duration=NULL, local_transcribed_at=NULL, local_model=NULL, " +
  "updated_at=datetime('now')";

// Write-capable DB handle for mutation endpoints
let writeDb: Database | null = null;
function getWriteDb(): Database | null {
  if (writeDb) return writeDb;
  try {
    writeDb = new Database(DB_PATH);
  } catch {
    return null;
  }
  return writeDb;
}

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
  const body = (await req.json()) as { text: string; engine?: string; voice?: string; description?: string };
  const engine = body.engine ?? "kokoro";

  if (engine === "kokoro") {
    try {
      const resp = await fetch(`${LOCALVOICE.kokoro}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "kokoro",
          input: body.text,
          voice: body.voice || "af_heart",
          response_format: "wav",
        }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return Response.json({ error: err || `Kokoro TTS returned ${resp.status}` }, { status: resp.status });
      }
      return new Response(resp.body, {
        headers: {
          "Content-Type": "audio/wav",
          "Content-Disposition": 'attachment; filename="speech.wav"',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        return Response.json({ error: "Kokoro TTS service is not running." }, { status: 503 });
      }
      return Response.json({ error: `Kokoro TTS unavailable: ${msg}` }, { status: 503 });
    }
  }

  // Fallback to Piper
  const ttsBody: Record<string, string> = { text: body.text };
  let resp: Response;
  try {
    resp = await fetch(`${LOCALVOICE.piper}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ttsBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Piper TTS unavailable: ${msg}` }, { status: 503 });
  }
  if (!resp.ok) {
    const err = await resp.text();
    return Response.json({ error: err || `Piper TTS returned ${resp.status}` }, { status: resp.status });
  }
  return new Response(resp.body, {
    headers: { "Content-Type": "audio/wav", "Content-Disposition": 'attachment; filename="speech.wav"' },
  });
}

async function handleHealth(): Promise<Response> {
  const services = [
    { name: "3cx", check: () => checkThreeCX() },
    { name: "whisper", check: () => checkService(LOCALVOICE.stt) },
    { name: "piper", check: () => checkService(LOCALVOICE.piper) },
    { name: "kokoro", check: () => checkService(LOCALVOICE.kokoro) },
    { name: "diarization", check: () => checkService(LOCALVOICE.diarization) },
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
  // If segments already have real speaker labels from diarization, use them
  const hasRealSpeakers = segments.some(
    (s) => s.speaker && s.speaker !== "Caller" && s.speaker !== "Called" && !s.speaker.startsWith("SPEAKER_")
  );
  if (hasRealSpeakers) return segments;

  // Fallback: gap-based heuristic
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

      if (path === "/api/sync/schedule" && req.method === "GET") {
        const interval = Number(process.env.SYNC_INTERVAL_MINUTES ?? "15");
        return Response.json({ interval_minutes: interval });
      }

      if (path === "/api/sync/trigger" && req.method === "POST") {
        return Response.json({ message: "Manual sync trigger not yet implemented" }, { status: 501 });
      }

      // Sync recordings list (clickable stat cards)
      if (path === "/api/sync/recordings" && req.method === "GET") {
        const db = getLocalDb();
        if (!db) return Response.json({ error: "DB unavailable" }, { status: 503 });
        const status = url.searchParams.get("status") ?? "pending";
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const rows = db.query(
          "SELECT id, start_time, from_display_name, to_display_name, call_type, duration, local_transcription " +
          "FROM recordings WHERE sync_status = ? ORDER BY id DESC LIMIT ? OFFSET ?"
        ).all(status, limit, offset);
        const total = db.query("SELECT COUNT(*) as count FROM recordings WHERE sync_status = ?").get(status) as {count: number};
        return Response.json({ recordings: rows, total: total.count });
      }

      // Retranscribe single recording
      const retranscribeMatch = path.match(/^\/api\/recordings\/(\d+)\/retranscribe$/);
      if (retranscribeMatch && req.method === "POST") {
        const db = getWriteDb();
        if (!db) return Response.json({ error: "DB unavailable" }, { status: 503 });
        const id = parseInt(retranscribeMatch[1], 10);
        db.run(`${RETRANSCRIBE_RESET} WHERE id=?`, [id]);
        return Response.json({ success: true, id });
      }

      // Retransliterate single recording
      const retransMatch = path.match(/^\/api\/recordings\/(\d+)\/retransliterate$/);
      if (retransMatch && req.method === "POST") {
        const db = getWriteDb();
        if (!db) return Response.json({ error: "DB unavailable" }, { status: 503 });
        const id = parseInt(retransMatch[1], 10);
        const row = db.query("SELECT local_transcription, segments_json FROM recordings WHERE id=?").get(id) as any;
        if (!row?.local_transcription) return Response.json({ error: "No transcription to transliterate" }, { status: 404 });

        const input = JSON.stringify({ text: row.local_transcription, segments: row.segments_json ? JSON.parse(row.segments_json) : [] });
        const proc = Bun.spawn(["python3", join(import.meta.dir, "transliterate.py")], { stdin: new Blob([input]) });
        const output = await new Response(proc.stdout).text();
        const result = JSON.parse(output);

        db.run(
          "UPDATE recordings SET local_transcription=?, segments_json=?, updated_at=datetime('now') WHERE id=?",
          [result.text, JSON.stringify(result.segments), id]
        );
        return Response.json({ success: true, id, text: result.text });
      }

      // Bulk actions
      if (path === "/api/recordings/bulk-action" && req.method === "POST") {
        const body = await req.json() as { action: string; ids?: number[]; filter?: { status: string } };
        const db = getWriteDb();
        if (!db) return Response.json({ error: "DB unavailable" }, { status: 503 });

        if (body.action === "retranscribe") {
          if (body.ids) {
            const placeholders = body.ids.map(() => "?").join(",");
            db.run(`${RETRANSCRIBE_RESET} WHERE id IN (${placeholders})`, body.ids);
            return Response.json({ success: true, count: body.ids.length });
          }
          if (body.filter?.status) {
            const result = db.run(`${RETRANSCRIBE_RESET} WHERE sync_status=?`, [body.filter.status]);
            return Response.json({ success: true, count: result.changes });
          }
        }
        return Response.json({ error: "Invalid action" }, { status: 400 });
      }

      // Speaker management — proxy to diarization service
      if (path === "/api/speakers" && req.method === "GET") {
        try {
          const resp = await fetch(`${LOCALVOICE.diarization}/speakers`, { signal: AbortSignal.timeout(5000) });
          return Response.json(await resp.json(), { status: resp.status });
        } catch {
          return Response.json({ speakers: [], error: "Diarization service unavailable" });
        }
      }

      if (path === "/api/speakers/enroll" && req.method === "POST") {
        const formData = await req.formData();
        const resp = await fetch(`${LOCALVOICE.diarization}/enroll`, {
          method: "POST",
          body: formData,
        });
        return Response.json(await resp.json(), { status: resp.status });
      }

      const speakerDeleteMatch = path.match(/^\/api\/speakers\/([^/]+)$/);
      if (speakerDeleteMatch && req.method === "DELETE") {
        const resp = await fetch(`${LOCALVOICE.diarization}/speakers/${speakerDeleteMatch[1]}`, {
          method: "DELETE",
        });
        return Response.json(await resp.json(), { status: resp.status });
      }

      // Re-diarize a recording
      const rediarizeMatch = path.match(/^\/api\/recordings\/(\d+)\/rediarize$/);
      if (rediarizeMatch && req.method === "POST") {
        const db = getWriteDb();
        if (!db) return Response.json({ error: "DB unavailable" }, { status: 503 });
        const id = parseInt(rediarizeMatch[1], 10);
        db.run(
          "UPDATE recordings SET sync_status_diar='pending', diarization_json=NULL, speaker_map_json=NULL, " +
          "diarized_at=NULL, updated_at=datetime('now') WHERE id=?", [id]
        );
        return Response.json({ success: true, id });
      }

      // TTS voices
      if (path === "/api/tts/voices" && req.method === "GET") {
        try {
          const resp = await fetch(`${LOCALVOICE.kokoro}/v1/audio/voices`, { signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            const data = await resp.json() as { voices?: string[] } | string[];
            const voiceIds = Array.isArray(data) ? data : (data.voices || []);
            const voices = voiceIds.map((id: string) => {
              const prefix = id.substring(0, 2);
              const name = id.substring(3).replace(/_/g, " ").replace(/^v\d+/, "").trim();
              const label = VOICE_PREFIX_LABELS[prefix] || prefix.toUpperCase();
              const displayName = name ? `${name.charAt(0).toUpperCase() + name.slice(1)} (${label})` : `${id} (${label})`;
              return { id, name: displayName, group: label };
            });
            return Response.json(voices);
          }
        } catch {}
        return Response.json([
          { id: "af_heart", name: "Heart (American Female)", group: "American Female" },
          { id: "af_bella", name: "Bella (American Female)", group: "American Female" },
          { id: "af_sarah", name: "Sarah (American Female)", group: "American Female" },
          { id: "am_adam", name: "Adam (American Male)", group: "American Male" },
          { id: "am_michael", name: "Michael (American Male)", group: "American Male" },
          { id: "bf_emma", name: "Emma (British Female)", group: "British Female" },
          { id: "bm_george", name: "George (British Male)", group: "British Male" },
        ]);
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
