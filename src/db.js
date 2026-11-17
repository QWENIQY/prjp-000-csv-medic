'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

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

  -- One row per free download claimed. Keyed by (day, kind, key) where kind is 'ip' or 'device'
  -- and key is an HMAC of the IP / device id, so raw IPs are never stored.
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
`);

/** Run fn inside a write transaction (IMMEDIATE so concurrent claims serialise). */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const stmts = {
  insertExport: db.prepare(`INSERT INTO exports (id, owner, filename, csv, row_count, product_count, fixed_count, created_at, expires_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getExportMeta: db.prepare(`SELECT id, owner, filename, row_count, product_count, fixed_count, created_at, expires_at, unlocked_at, unlock_method
                             FROM exports WHERE id = ? AND expires_at > ?`),
  getExportCsv: db.prepare('SELECT csv, filename FROM exports WHERE id = ? AND owner = ? AND unlocked_at IS NOT NULL AND expires_at > ?'),
  unlockExport: db.prepare('UPDATE exports SET unlocked_at = ?, unlock_method = ? WHERE id = ? AND unlocked_at IS NULL'),
  deleteExpired: db.prepare('DELETE FROM exports WHERE expires_at <= ?'),
  getClaim: db.prepare('SELECT uses FROM free_claims WHERE day = ? AND kind = ? AND key = ?'),
  upsertClaim: db.prepare(`INSERT INTO free_claims (day, kind, key, uses, updated_at) VALUES (?, ?, ?, 1, ?)
                           ON CONFLICT(day, kind, key) DO UPDATE SET uses = uses + 1, updated_at = excluded.updated_at`),
  deleteOldClaims: db.prepare('DELETE FROM free_claims WHERE updated_at < ?'),
  insertPayment: db.prepare(`INSERT OR IGNORE INTO payments (session_id, export_id, amount_total, currency, payment_intent, created_at)
                             VALUES (?, ?, ?, ?, ?, ?)`),
};

function cleanup() {
  const now = Date.now();
  stmts.deleteExpired.run(now);
  stmts.deleteOldClaims.run(now - 3 * 24 * 3600 * 1000);
}

module.exports = { db, tx, stmts, cleanup };
