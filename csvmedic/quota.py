"""
Free-download quota: N free fixed-CSV downloads per day (default 1).

A visitor is identified by BOTH their IP address and a long-lived device cookie. If either has
already used today's allowance, the free download is refused — so clearing cookies doesn't help
(same IP), and switching networks doesn't help (same cookie). IPv6 addresses are grouped by /64
prefix because one home connection normally gets a whole /64. IPs and device ids are stored only
as HMAC-SHA256 hashes with a server secret.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
from datetime import datetime
from zoneinfo import ZoneInfo

from . import db
from .config import config

_tz = ZoneInfo(config.quota_timezone)


def today() -> str:
    return datetime.now(_tz).strftime("%Y-%m-%d")


def normalise_ip(ip: str | None) -> str:
    if not ip:
        return "unknown"
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return ip.strip()
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def _hmac(value: str) -> str:
    digest = hmac.new(config.ip_hash_secret.encode(), value.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _keys(ip: str | None, device_id: str) -> list[tuple[str, str]]:
    return [("ip", _hmac("ip:" + normalise_ip(ip))), ("device", _hmac("device:" + device_id))]


def free_remaining(ip: str | None, device_id: str, c=None) -> int:
    day = today()
    used = 0
    for kind, key in _keys(ip, device_id):
        sql = "SELECT uses FROM free_claims WHERE day = ? AND kind = ? AND key = ?"
        row = c.execute(sql, (day, kind, key)).fetchone() if c is not None else db.fetchone(sql, (day, kind, key))
        if row:
            used = max(used, row["uses"])
    return max(0, config.free_downloads_per_day - used)


def claim_free(ip: str | None, device_id: str, export_id: str) -> tuple[bool, str]:
    """Atomically consume a free download and unlock the export."""
    with db.tx() as c:
        if free_remaining(ip, device_id, c) <= 0:
            return False, "free_used"
        if db.unlock_export(c, export_id, "free") == 0:
            return False, "already_unlocked"
        day, now = today(), db.now_ms()
        for kind, key in _keys(ip, device_id):
            c.execute(
                "INSERT INTO free_claims (day, kind, key, uses, updated_at) VALUES (?, ?, ?, 1, ?) "
                "ON CONFLICT(day, kind, key) DO UPDATE SET uses = uses + 1, updated_at = excluded.updated_at",
                (day, kind, key, now),
            )
        return True, "ok"
