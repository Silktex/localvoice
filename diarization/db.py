"""Voice profile database operations."""

import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "/data/voices.db3")
ENROLLMENTS_DIR = os.environ.get("ENROLLMENTS_DIR", "/data/enrollments")

_db = None


def get_db() -> sqlite3.Connection:
    global _db
    if _db is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        os.makedirs(ENROLLMENTS_DIR, exist_ok=True)
        _db = sqlite3.connect(DB_PATH, check_same_thread=False)
        _db.execute("PRAGMA journal_mode=WAL")
        _db.execute("""
            CREATE TABLE IF NOT EXISTS speakers (
                speaker_id    TEXT PRIMARY KEY,
                name          TEXT NOT NULL UNIQUE,
                description   TEXT,
                embedding     TEXT NOT NULL,
                num_samples   INTEGER DEFAULT 1,
                created_at    TEXT DEFAULT (datetime('now')),
                updated_at    TEXT DEFAULT (datetime('now'))
            )
        """)
        _db.execute("""
            CREATE TABLE IF NOT EXISTS enrollment_samples (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                speaker_id    TEXT NOT NULL REFERENCES speakers(speaker_id) ON DELETE CASCADE,
                audio_path    TEXT NOT NULL,
                embedding     TEXT NOT NULL,
                duration      REAL,
                created_at    TEXT DEFAULT (datetime('now'))
            )
        """)
        _db.execute(
            "CREATE INDEX IF NOT EXISTS idx_enrollment_speaker ON enrollment_samples(speaker_id)"
        )
        _db.commit()
    return _db


def gen_speaker_id() -> str:
    return f"sp_{secrets.token_hex(4)}"


def list_speakers() -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT speaker_id, name, description, num_samples, created_at, updated_at "
        "FROM speakers ORDER BY name"
    ).fetchall()
    return [
        {
            "speaker_id": r[0],
            "name": r[1],
            "description": r[2],
            "num_samples": r[3],
            "created_at": r[4],
            "updated_at": r[5],
        }
        for r in rows
    ]


def get_speaker(speaker_id: str) -> dict | None:
    db = get_db()
    r = db.execute(
        "SELECT speaker_id, name, description, embedding, num_samples, created_at "
        "FROM speakers WHERE speaker_id = ?",
        (speaker_id,),
    ).fetchone()
    if not r:
        return None
    return {
        "speaker_id": r[0],
        "name": r[1],
        "description": r[2],
        "embedding": json.loads(r[3]),
        "num_samples": r[4],
        "created_at": r[5],
    }


def get_all_embeddings() -> list[dict]:
    """Return all speakers with their embeddings for identification."""
    db = get_db()
    rows = db.execute(
        "SELECT speaker_id, name, embedding FROM speakers"
    ).fetchall()
    return [
        {"speaker_id": r[0], "name": r[1], "embedding": json.loads(r[2])}
        for r in rows
    ]


def upsert_speaker(
    name: str,
    embedding: list[float],
    description: str | None = None,
    audio_path: str | None = None,
    duration: float | None = None,
) -> dict:
    """Enroll or update a speaker. Averages embeddings if name already exists."""
    db = get_db()
    existing = db.execute(
        "SELECT speaker_id, embedding, num_samples FROM speakers WHERE name = ?",
        (name,),
    ).fetchone()

    now = datetime.now(timezone.utc).isoformat()

    if existing:
        speaker_id, old_emb_json, n = existing
        old_emb = json.loads(old_emb_json)
        # Weighted average
        averaged = [(old_emb[i] * n + embedding[i]) / (n + 1) for i in range(len(embedding))]
        # L2-normalize
        norm = sum(x * x for x in averaged) ** 0.5
        if norm > 0:
            averaged = [x / norm for x in averaged]
        db.execute(
            "UPDATE speakers SET embedding=?, num_samples=?, updated_at=? WHERE speaker_id=?",
            (json.dumps(averaged), n + 1, now, speaker_id),
        )
    else:
        speaker_id = gen_speaker_id()
        db.execute(
            "INSERT INTO speakers (speaker_id, name, description, embedding, num_samples, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 1, ?, ?)",
            (speaker_id, name, description, json.dumps(embedding), now, now),
        )

    # Store individual sample
    if audio_path:
        db.execute(
            "INSERT INTO enrollment_samples (speaker_id, audio_path, embedding, duration) VALUES (?, ?, ?, ?)",
            (speaker_id, audio_path, json.dumps(embedding), duration),
        )

    db.commit()

    row = db.execute(
        "SELECT speaker_id, name, description, num_samples, created_at FROM speakers WHERE speaker_id=?",
        (speaker_id,),
    ).fetchone()
    return {
        "speaker_id": row[0],
        "name": row[1],
        "description": row[2],
        "num_samples": row[3],
        "created_at": row[4],
    }


def delete_speaker(speaker_id: str) -> bool:
    db = get_db()
    db.execute("DELETE FROM enrollment_samples WHERE speaker_id=?", (speaker_id,))
    cursor = db.execute("DELETE FROM speakers WHERE speaker_id=?", (speaker_id,))
    db.commit()
    return cursor.rowcount > 0
