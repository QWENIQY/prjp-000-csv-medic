'use strict';

/**
 * Free-download quota: N free fixed-CSV downloads per day (default 1).
 *
 * A visitor is identified by BOTH their IP address and a long-lived device cookie.
 * If either has already used today's allowance, the free download is refused. So
 * clearing cookies doesn't help (same IP), and switching networks doesn't help
 * (same cookie). IPv6 addresses are grouped by /64 prefix, because a single home
 * connection is normally given a whole /64 and can rotate addresses within it.
 *
 * IPs and device ids are stored only as HMAC-SHA256 hashes with a server secret.
 */

const crypto = require('node:crypto');
const net = require('node:net');
const config = require('./config');
const { tx, stmts } = require('./db');

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: config.quotaTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

function today(now = new Date()) {
  return dayFormatter.format(now); // YYYY-MM-DD in the quota time zone
}

/** Normalise an IP so trivially different forms of the same client compare equal. */
function normaliseIp(ip) {
  if (!ip) return 'unknown';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  if (net.isIPv6(s)) return ipv6Prefix64(s);
  return s;
}

function ipv6Prefix64(addr) {
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = addr.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':') + '::/64';
}

function hmac(value) {
  return crypto.createHmac('sha256', config.ipHashSecret).update(value).digest('base64url');
}

function keysFor(ip, deviceId) {
  return [
    ['ip', hmac('ip:' + normaliseIp(ip))],
    ['device', hmac('device:' + deviceId)],
  ];
}

function freeRemaining(ip, deviceId) {
  const day = today();
  let used = 0;
  for (const [kind, key] of keysFor(ip, deviceId)) {
    const row = stmts.getClaim.get(day, kind, key);
    if (row) used = Math.max(used, row.uses);
  }
  return Math.max(0, config.freeDownloadsPerDay - used);
}

/**
 * Atomically consume a free download and unlock the export.
 * Returns { ok: true } or { ok: false, reason }.
 */
function claimFree(ip, deviceId, exportId) {
  return tx(() => {
    if (freeRemaining(ip, deviceId) <= 0) return { ok: false, reason: 'free_used' };
    const changed = stmts.unlockExport.run(Date.now(), 'free', exportId).changes;
    if (changed === 0) return { ok: false, reason: 'already_unlocked' };
    const day = today();
    const now = Date.now();
    for (const [kind, key] of keysFor(ip, deviceId)) stmts.upsertClaim.run(day, kind, key, now);
    return { ok: true };
  });
}

module.exports = { freeRemaining, claimFree, normaliseIp, today };
