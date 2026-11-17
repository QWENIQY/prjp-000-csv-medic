"""Settings, read from environment variables and the project's .env file."""

from __future__ import annotations

import os
import re
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
ENV_FILE = ROOT / ".env"


def load_env_file(path: Path = ENV_FILE) -> None:
    """Minimal .env loader: KEY=value lines, # comments, optional quotes. Real env vars win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _trust_proxy(value: str) -> int:
    """Number of reverse-proxy hops in front of the app (0 = none). 'true' counts as 1."""
    if value.isdigit():
        return int(value)
    return 1 if value.lower() in ("true", "yes") else 0


@dataclass
class Config:
    is_prod: bool
    host: str
    port: int
    app_url: str
    app_origin: str
    trust_proxy: int
    db_path: Path
    ip_hash_secret: str
    stripe_secret_key: str
    stripe_webhook_secret: str
    stripe_price_id: str
    price_amount: int
    price_currency: str
    free_downloads_per_day: int
    quota_timezone: str
    export_ttl_hours: int
    canonical_redirect: bool
    indexnow_key: str
    legal: dict = field(default_factory=dict)
    max_upload_bytes: int = 15 * 1024 * 1024  # Shopify's own CSV import limit

    @property
    def payments_enabled(self) -> bool:
        return bool(self.stripe_secret_key)

    @property
    def price_label(self) -> str:
        symbols = {"gbp": "£", "usd": "$", "eur": "€"}
        sym = symbols.get(self.price_currency, self.price_currency.upper() + " ")
        return f"{sym}{self.price_amount / 100:,.2f}"


def load_config() -> Config:
    load_env_file()
    is_prod = _env("NODE_ENV", _env("ENV")).lower() == "production" or _env("CSVMEDIC_ENV").lower() == "production"
    port = int(_env("PORT", "3000") or 3000)
    app_url = (_env("APP_URL") or f"http://localhost:{port}").rstrip("/")
    parts = urlsplit(app_url)
    secret = _env("IP_HASH_SECRET")
    if not secret:
        if is_prod:
            raise RuntimeError("IP_HASH_SECRET is missing. Run `python3 run.py` once to generate it, or set it in your host's environment.")
        secret = secrets.token_hex(32)
    indexnow = _env("INDEXNOW_KEY")
    return Config(
        is_prod=is_prod,
        host=_env("HOST", "0.0.0.0"),
        port=port,
        app_url=app_url,
        app_origin=f"{parts.scheme}://{parts.netloc}",
        trust_proxy=_trust_proxy(_env("TRUST_PROXY")),
        db_path=Path(_env("DB_PATH") or ROOT / "data" / "csvmedic.db").expanduser(),
        ip_hash_secret=secret,
        stripe_secret_key=_env("STRIPE_SECRET_KEY"),
        stripe_webhook_secret=_env("STRIPE_WEBHOOK_SECRET"),
        stripe_price_id=_env("STRIPE_PRICE_ID"),
        price_amount=int(_env("PRICE_AMOUNT_PENCE", "500") or 500),
        price_currency=(_env("PRICE_CURRENCY", "gbp") or "gbp").lower(),
        free_downloads_per_day=int(_env("FREE_DOWNLOADS_PER_DAY", "1") or 1),
        quota_timezone=_env("QUOTA_TIMEZONE", "Europe/London") or "Europe/London",
        export_ttl_hours=int(_env("EXPORT_TTL_HOURS", "24") or 24),
        canonical_redirect=_env("CANONICAL_REDIRECT").lower() == "true",
        indexnow_key=indexnow if re.fullmatch(r"[A-Za-z0-9-]{8,128}", indexnow) else "",
        legal={
            "LEGAL_NAME": _env("LEGAL_NAME"),
            "COMPANY_NUMBER": _env("COMPANY_NUMBER"),
            "REGISTERED_ADDRESS": _env("REGISTERED_ADDRESS"),
            "CONTACT_EMAIL": _env("CONTACT_EMAIL"),
            "VAT_NUMBER": _env("VAT_NUMBER"),
            "ICO_NUMBER": _env("ICO_NUMBER"),
            "HOSTING_PROVIDER": _env("HOSTING_PROVIDER"),
            "HOSTING_LOCATION": _env("HOSTING_LOCATION"),
        },
    )


config = load_config()
