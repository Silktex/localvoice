/**
 * Background diarization worker — runs as a separate bun process.
 * Usage: bun run diarize-worker.ts <recording_id>
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync } from "fs";

const DB_PATH = process.env.DB_PATH ?? "/data/3cx.db3";
const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? "/data/recordings";
const DIAR_URL = process.env.LOCALVOICE_DIAR_URL ?? "http://diarization:8090";

const id = parseInt(process.argv[2], 10);
if (isNaN(id)) {
  console.error("Usage: bun run diarize-worker.ts <recording_id>");
  process.exit(1);
}

interface DiarSegment { start: number; end: number; speaker_label?: string; speaker?: string }
interface SpeakerInfo { name?: string | null; confidence?: number }

const db = new Database(DB_PATH);

try {
  const rec = db.query(
    "SELECT opus_path, wav_path, from_display_name, to_display_name, call_type, segments_json " +
    "FROM recordings WHERE id = ?"
  ).get(id) as {
    opus_path: string | null; wav_path: string | null;
    from_display_name: string | null; to_display_name: string | null;
    call_type: string | null; segments_json: string | null;
  } | null;

  if (!rec) { console.error(`Recording ${id} not found`); process.exit(1); }

  let audioPath: string | null = null;
  if (rec.opus_path) {
    const p = join(RECORDINGS_DIR, rec.opus_path);
    if (existsSync(p)) audioPath = p;
  }
  if (!audioPath && rec.wav_path) {
    const p = join(RECORDINGS_DIR, rec.wav_path);
    if (existsSync(p)) audioPath = p;
  }
  if (!audioPath) { console.error(`Audio file not found for ${id}`); process.exit(1); }

  console.log(`[diarize-worker] Starting diarization for recording ${id} (${audioPath})`);

  const formData = new FormData();
  formData.append("file", Bun.file(audioPath));
  formData.append("max_speakers", "2");

  const resp = await fetch(`${DIAR_URL}/diarize-and-identify`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    db.run("UPDATE recordings SET sync_status_diar='error', updated_at=datetime('now') WHERE id=?", [id]);
    console.error(`[diarize-worker] Diarization failed for ${id}: ${resp.status}`);
    process.exit(1);
  }

  const diarData = await resp.json() as {
    segments: DiarSegment[];
    speakers: Record<string, SpeakerInfo>;
  };
  const diarSegments = diarData.segments || [];
  const speakerMap: Record<string, SpeakerInfo> = diarData.speakers || {};

  // Map diarized speakers to 3CX caller metadata for 2-speaker calls
  const speakerLabels = [...new Set(diarSegments.map(s => s.speaker_label || s.speaker || ""))].filter(Boolean);
  if (speakerLabels.length === 2 && rec.from_display_name && rec.to_display_name) {
    const hasEnrolledNames = speakerLabels.some(l => speakerMap[l]?.name);
    if (!hasEnrolledNames) {
      const firstSegByLabel: Record<string, number> = {};
      for (const seg of diarSegments) {
        const label = seg.speaker_label || seg.speaker || "";
        if (label && !(label in firstSegByLabel)) firstSegByLabel[label] = seg.start;
      }
      const sorted = [...speakerLabels].sort((a, b) => (firstSegByLabel[a] ?? 0) - (firstSegByLabel[b] ?? 0));

      const isInbound = rec.call_type?.toLowerCase().includes("inbound");
      const firstName = isInbound ? rec.to_display_name : rec.from_display_name;
      const secondName = isInbound ? rec.from_display_name : rec.to_display_name;

      for (const l of speakerLabels) {
        if (!speakerMap[l]) speakerMap[l] = {};
      }
      speakerMap[sorted[0]].name = firstName;
      speakerMap[sorted[1]].name = secondName;
    }
  }

  // Store diarization results
  db.run(
    "UPDATE recordings SET diarization_json=?, speaker_map_json=?, " +
    "diarized_at=datetime('now'), sync_status_diar='diarized', " +
    "updated_at=datetime('now') WHERE id=?",
    [JSON.stringify(diarSegments), JSON.stringify(speakerMap), id]
  );

  // Merge speaker names into transcription segments
  if (rec.segments_json) {
    try {
      const segments = JSON.parse(rec.segments_json);
      for (const wSeg of segments) {
        const wStart = wSeg.start ?? 0;
        const wEnd = wSeg.end ?? 0;
        let bestSpeaker: string | null = null;
        let bestOverlap = 0;
        for (const dSeg of diarSegments) {
          const overlap = Math.max(0, Math.min(wEnd, dSeg.end ?? 0) - Math.max(wStart, dSeg.start ?? 0));
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestSpeaker = dSeg.speaker_label ?? dSeg.speaker ?? null;
          }
        }
        if (bestSpeaker && bestSpeaker in speakerMap) {
          wSeg.speaker = speakerMap[bestSpeaker]?.name || bestSpeaker;
        } else if (bestSpeaker) {
          wSeg.speaker = bestSpeaker;
        }
      }
      db.run("UPDATE recordings SET segments_json=?, updated_at=datetime('now') WHERE id=?",
        [JSON.stringify(segments), id]);
    } catch {}
  }

  console.log(`[diarize-worker] Recording ${id} complete: ${diarSegments.length} diarization segments, ${speakerLabels.length} speakers`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  db.run("UPDATE recordings SET sync_status_diar='error', updated_at=datetime('now') WHERE id=?", [id]);
  console.error(`[diarize-worker] Recording ${id} error: ${msg}`);
  process.exit(1);
}
