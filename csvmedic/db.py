"""SQLite storage (Python's built-in sqlite3 — nothing to install)."""

from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager

from .config import config

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Fixed CSVs waiting to be downloaded. Deleted automatically after EXPORT_TTL_HOURS.
CREATE TABLE IF NOT EXISTS exports (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,           -- random device id from the cm_did cookie
  filename      TEXT NOT NULL,
  csv           BLOB NOT NULL,
  row_count     INTEGER NOT NULL,
  product_count INTEGER NOT NULL,
  fixed_count   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  unlocked_at   INTEGER,
  unlock_method TEXT                     -- 'free' | 'stripe'
);
CREATE INDEX IF NOT EXISTS exports_expires ON exports(expires_at);

-- One row per free download claimed, keyed by (day, kind, key). kind is 'ip' or 'device';
-- key is an HMAC of the IP / device id, so raw IPs are never stored.
CREATE TABLE IF NOT EXISTS free_claims (
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, kind, key)
);

-- Successful Stripe payments (for your records / refunds).
CREATE TABLE IF NOT EXISTS payments (
  session_id     TEXT PRIMARY KEY,
  export_id      TEXT NOT NULL,
  amount_total   INTEGER,
  currency       TEXT,
  payment_intent TEXT,
  created_at     INTEGER NOT NULL
);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.db_path.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(config.db_path), check_same_thread=False, isolation_level=None, timeout=5)
        c.row_factory = sqlite3.Row
        c.executescript(SCHEMA)
        _conn = c
    return _conn


@contextmanager
def tx():
    """Serialised write transaction (BEGIN IMMEDIATE) — used for the free-download claim."""
    with _lock:
        c = conn()
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise


def execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        return conn().execute(sql, params)


def fetchone(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    with _lock:
        return conn().execute(sql, params).fetchone()


def insert_export(id_: str, owner: str, filename: str, csv_bytes: bytes, rows: int, products: int, fixed: int) -> None:
    now = now_ms()
    execute(
        "INSERT INTO exports (id, owner, filename, csv, row_count, product_count, fixed_count, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (id_, owner, filename, csv_bytes, rows, products, fixed, now, now + config.export_ttl_hours * 3_600_000),
    )


def get_export_meta(id_: str) -> sqlite3.Row | None:
    return fetchone(
        "SELECT id, owner, filename, row_count, product_count, fixed_count, created_at, expires_at, unlocked_at, unlock_method "
        "FROM exports WHERE id = ? AND expires_at > ?",
        (id_, now_ms()),
    )


def get_export_csv(id_: str, owner: str) -> sqlite3.Row | None:
    return fetchone(
        "SELECT csv, filename FROM exports WHERE id = ? AND owner = ? AND unlocked_at IS NOT NULL AND expires_at > ?",
        (id_, owner, now_ms()),
    )


def unlock_export(c: sqlite3.Connection | None, id_: str, method: str) -> int:
    sql = "UPDATE exports SET unlocked_at = ?, unlock_method = ? WHERE id = ? AND unlocked_at IS NULL"
    if c is not None:
        return c.execute(sql, (now_ms(), method, id_)).rowcount
    return execute(sql, (now_ms(), method, id_)).rowcount


def insert_payment(session_id: str, export_id: str, amount, currency, payment_intent) -> None:
    execute(
        "INSERT OR IGNORE INTO payments (session_id, export_id, amount_total, currency, payment_intent, created_at) VALUES (?,?,?,?,?,?)",
        (session_id, export_id, amount, currency, payment_intent, now_ms()),
    )


def cleanup() -> None:
    now = now_ms()
    execute("DELETE FROM exports WHERE expires_at <= ?", (now,))
    execute("DELETE FROM free_claims WHERE updated_at < ?", (now - 3 * 24 * 3_600_000,))
