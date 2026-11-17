"""CSV Medic web application (FastAPI)."""

from __future__ import annotations

import asyncio
import html
import json
import logging
import mimetypes
import re
import secrets
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import stripe
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.middleware.gzip import GZipMiddleware

from . import db, quota
from .config import PUBLIC, config
from .csvio import decode_bytes, parse, serialize, sniff_delimiter
from .fixer import fix_shopify_csv

log = logging.getLogger("csvmedic")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/csv", ".csv")
mimetypes.add_type("image/svg+xml", ".svg")

HTTPS = config.app_url.startswith("https://")
MAX_ROWS = 200_000
MAX_COLS = 500
EXPORT_ID = re.compile(r"^[A-Za-z0-9_-]{24}$")
DEVICE_COOKIE = "cm_did"
DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
CONSENT_VERSION = "digital-content-waiver-2026-11-17"


# ---------------------------------------------------------------------------
# Lifespan: open DB, periodic cleanup
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.conn()
    db.cleanup()
    if config.is_prod:
        missing = [k for k, v in config.legal.items() if not v]
        if missing:
            log.warning("Legal pages show placeholders for unset business details: %s", ", ".join(missing))

    async def janitor():
        while True:
            await asyncio.sleep(600)
            try:
                await run_in_threadpool(db.cleanup)
            except Exception:  # pragma: no cover
                log.exception("cleanup failed")

    task = asyncio.create_task(janitor())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def client_ip(request: Request) -> str:
    """Client IP, trusting exactly TRUST_PROXY reverse-proxy hops (so X-Forwarded-For can't be spoofed)."""
    remote = request.client.host if request.client else ""
    if config.trust_proxy <= 0:
        return remote
    xff = request.headers.get("x-forwarded-for", "")
    chain = [remote] + [p.strip() for p in reversed(xff.split(",")) if p.strip()]
    return chain[min(config.trust_proxy, len(chain) - 1)]


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def read_body(request: Request, limit: int) -> bytes | None:
    """Read the request body, returning None if it exceeds `limit` bytes."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        return None
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _get(obj, *path):
    """Safe nested lookup that works for dicts and Stripe objects."""
    for key in path:
        if obj is None:
            return None
        try:
            obj = obj[key]
        except (KeyError, TypeError, AttributeError):
            return None
    return obj


class RateLimiter:
    """Simple in-memory sliding-window limiter, keyed by client IP."""

    def __init__(self, window_s: float, limit: int):
        self.window, self.limit = window_s, limit
        self.hits: dict[str, deque] = {}
        self.lock = threading.Lock()
        self.last_sweep = time.monotonic()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            if now - self.last_sweep > 300:
                for k in [k for k, q in self.hits.items() if not q or now - q[-1] > self.window]:
                    del self.hits[k]
                self.last_sweep = now
            q = self.hits.setdefault(key, deque())
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True


fix_limiter = RateLimiter(60, 40)
export_limiter = RateLimiter(600, 30)
action_limiter = RateLimiter(60, 20)
TOO_MANY = "Too many requests — please slow down and try again shortly."


def limited(limiter: RateLimiter, request: Request) -> JSONResponse | None:
    if limiter.allow(client_ip(request)):
        return None
    return JSONResponse({"error": TOO_MANY}, status_code=429, headers={"Retry-After": str(int(limiter.window))})


# ---------------------------------------------------------------------------
# Middleware: security headers, device cookie, URL normalisation, CSRF, noindex
# ---------------------------------------------------------------------------
CSP = "; ".join([
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "media-src 'self'",
    "font-src 'self'", "connect-src 'self'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
    "base-uri 'self'", "object-src 'none'",
] + (["upgrade-insecure-requests"] if HTTPS else []))

SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "X-DNS-Prefetch-Control": "off",
}
if HTTPS:
    SECURITY_HEADERS["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"


@app.middleware("http")
async def site_middleware(request: Request, call_next):
    path = request.url.path
    method = request.method

    if method in ("GET", "HEAD"):
        # One URL per page: canonical host and no trailing slash.
        if config.canonical_redirect and path != "/healthz":
            want = urlsplit(config.app_url).netloc
            if request.headers.get("host") and request.headers["host"] != want:
                target = config.app_url + path + (f"?{request.url.query}" if request.url.query else "")
                return RedirectResponse(target, status_code=301)
        if len(path) > 1 and path.endswith("/"):
            target = path.rstrip("/") + (f"?{request.url.query}" if request.url.query else "")
            return RedirectResponse(target, status_code=301)
    elif path.startswith("/api/") and path != "/api/stripe/webhook":
        # CSRF defence: reject cross-site state-changing requests.
        site = request.headers.get("sec-fetch-site")
        if site and site not in ("same-origin", "none"):
            return error(403, "Cross-site request blocked.")
        origin = request.headers.get("origin")
        if origin and origin != config.app_origin:
            return error(403, "Cross-origin request blocked.")

    device = request.cookies.get(DEVICE_COOKIE, "")
    new_device = not DEVICE_ID.match(device)
    if new_device:
        device = secrets.token_urlsafe(24)
    request.state.device_id = device

    response = await call_next(request)

    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    if path.startswith("/download") or path.startswith("/api"):
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
    if new_device:
        response.set_cookie(DEVICE_COOKIE, device, max_age=60 * 60 * 24 * 400, path="/", httponly=True, samesite="lax", secure=HTTPS)
    return response


# ---------------------------------------------------------------------------
# Pages & SEO
# ---------------------------------------------------------------------------
PAGES = {
    "/": ("index", "1.0", "weekly"),
    "/app": ("app", "0.9", "monthly"),
    "/shopify-csv-errors": ("shopify-csv-errors", "0.9", "monthly"),
    "/shopify-csv-template": ("shopify-csv-template", "0.8", "monthly"),
    "/terms": ("terms", "0.3", "yearly"),
    "/privacy": ("privacy", "0.3", "yearly"),
    "/cookies": ("cookies", "0.2", "yearly"),
    "/refunds": ("refunds", "0.3", "yearly"),
    "/legal": ("legal", "0.2", "yearly"),
}
TODO_LABELS = {
    "LEGAL_NAME": "Legal business name — set LEGAL_NAME",
    "COMPANY_NUMBER": "Company number — set COMPANY_NUMBER",
    "REGISTERED_ADDRESS": "Registered / business address — set REGISTERED_ADDRESS",
    "CONTACT_EMAIL": "Contact email — set CONTACT_EMAIL",
    "CONTACT_EMAIL_LINK": "Contact email — set CONTACT_EMAIL",
    "VAT_NUMBER": 'VAT number, or "Not VAT registered" — set VAT_NUMBER',
    "ICO_NUMBER": "ICO registration number — set ICO_NUMBER",
    "HOSTING_PROVIDER": "Hosting provider — set HOSTING_PROVIDER",
    "HOSTING_LOCATION": "Hosting location (e.g. United Kingdom) — set HOSTING_LOCATION",
}
RAW_TOKENS = {"CONTACT_EMAIL_LINK"}
TOKEN = re.compile(r"\{\{([A-Z_]+)\}\}")
_page_cache: dict[str, str] = {}


def page_tokens() -> dict[str, str]:
    email = config.legal.get("CONTACT_EMAIL", "")
    esc = html.escape(email)
    return {
        **config.legal,
        "CONTACT_EMAIL_LINK": f'<a href="mailto:{esc}">{esc}</a>' if email else "",
        "APP_URL": config.app_url,
        "PRICE": config.price_label,
        "FREE_PER_DAY": str(config.free_downloads_per_day),
        "EXPORT_TTL_HOURS": str(config.export_ttl_hours),
    }


def render_page(name: str) -> str:
    if name in _page_cache:
        return _page_cache[name]
    tokens = page_tokens()

    def sub(m: re.Match) -> str:
        key = m.group(1)
        value = tokens.get(key)
        if value:
            return value if key in RAW_TOKENS else html.escape(value)
        return f'<mark class="todo">[{html.escape(TODO_LABELS.get(key, key))}]</mark>'

    out = TOKEN.sub(sub, (PUBLIC / f"{name}.html").read_text(encoding="utf-8"))
    if config.is_prod:
        _page_cache[name] = out
    return out


def _page_route(name: str):
    async def handler():
        return HTMLResponse(render_page(name), headers={"Cache-Control": "no-cache"})

    return handler


def _redirect_route(target: str):
    async def handler():
        return RedirectResponse(target, status_code=301)

    return handler


for _route, (_name, _prio, _freq) in PAGES.items():
    app.add_api_route(_route, _page_route(_name), methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route(f"/{_name}.html", _redirect_route(_route), methods=["GET", "HEAD"], include_in_schema=False)


@app.get("/download/{export_id}", include_in_schema=False)
async def download_page(export_id: str):
    return FileResponse(PUBLIC / "download.html", headers={"Cache-Control": "no-cache"})


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True}


AI_AND_SEARCH_BOTS = [
    "Googlebot", "Bingbot", "Google-Extended", "Applebot", "Applebot-Extended", "DuckDuckBot",
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
    "PerplexityBot", "Perplexity-User", "Amazonbot", "meta-externalagent", "CCBot",
]


@app.get("/robots.txt", include_in_schema=False)
async def robots():
    rules = "Allow: /\nDisallow: /api/\nDisallow: /download/\n"
    parts = [f"User-agent: *\n{rules}", "# Search engines and AI assistants: you are welcome to index and cite our public pages."]
    parts += [f"User-agent: {b}\n{rules}" for b in AI_AND_SEARCH_BOTS]
    parts.append(f"Sitemap: {config.app_url}/sitemap.xml")
    return PlainTextResponse("\n".join(parts) + "\n")


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap():
    urls = []
    for route, (name, prio, freq) in PAGES.items():
        mtime = datetime.fromtimestamp((PUBLIC / f"{name}.html").stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")
        urls.append(f"  <url><loc>{config.app_url}{route}</loc><lastmod>{mtime}</lastmod><changefreq>{freq}</changefreq><priority>{prio}</priority></url>")
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(urls) + "\n</urlset>\n"
    return Response(body, media_type="application/xml")


@app.get("/llms.txt", include_in_schema=False)
async def llms():
    text = (PUBLIC / "llms.txt").read_text(encoding="utf-8").replace("{{APP_URL}}", config.app_url).replace("{{PRICE}}", config.price_label)
    return PlainTextResponse(text)


@app.get("/.well-known/security.txt", include_in_schema=False)
async def security_txt():
    expires = (datetime.now(timezone.utc) + timedelta(days=180)).strftime("%Y-%m-%dT%H:%M:%SZ")
    email = config.legal.get("CONTACT_EMAIL")
    contact = f"mailto:{email}" if email else f"{config.app_url}/legal"
    return PlainTextResponse(
        f"Contact: {contact}\nExpires: {expires}\nPreferred-Languages: en\n"
        f"Canonical: {config.app_url}/.well-known/security.txt\nPolicy: {config.app_url}/legal#security\n"
    )


if config.indexnow_key:

    @app.get(f"/{config.indexnow_key}.txt", include_in_schema=False)
    async def indexnow_key():
        return PlainTextResponse(config.indexnow_key)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/config")
async def api_config():
    return {
        "priceLabel": config.price_label,
        "paymentsEnabled": config.payments_enabled,
        "freePerDay": config.free_downloads_per_day,
        "maxUploadBytes": config.max_upload_bytes,
    }


def _fix_upload(data: bytes):
    text, encoding, notes = decode_bytes(data)
    if "\u0000" in text:
        return 400, {"error": "That doesn't look like a CSV file (it contains binary data). If it's an Excel file, use File → Save As → CSV UTF-8 first."}
    delimiter = sniff_delimiter(text)
    rows, unterminated = parse(text, delimiter)
    if not rows:
        return 400, {"error": "No rows found in the file."}
    if len(rows) > MAX_ROWS + 1:
        return 413, {"error": f"Files are limited to {MAX_ROWS:,} rows."}
    if len(rows[0]) > MAX_COLS:
        return 413, {"error": f"Files are limited to {MAX_COLS} columns."}
    pre = list(notes)
    if delimiter != ",":
        label = "tabs" if delimiter == "\t" else f'"{delimiter}"'
        pre.append(f"File used {label} between columns — converted to commas, which Shopify requires.")
    if unterminated:
        pre.append("The file ended inside an unclosed quote — the last cell may be incomplete. Check the final row.")
    result = fix_shopify_csv(rows[0], rows[1:], pre)
    result["meta"] = {"encoding": encoding, "delimiter": delimiter}
    return 200, result


@app.post("/api/fix/upload")
async def api_fix_upload(request: Request):
    if (r := limited(fix_limiter, request)) is not None:
        return r
    data = await read_body(request, config.max_upload_bytes)
    if data is None:
        return error(413, "That file is too large. Shopify accepts CSV files up to 15 MB.")
    if not data:
        return error(400, "The file is empty.")
    status, payload = await run_in_threadpool(_fix_upload, data)
    return JSONResponse(payload, status_code=status)


def validate_table(body) -> tuple[list, list] | str:
    if not isinstance(body, dict):
        return "Missing data."
    headers, rows = body.get("headers"), body.get("rows")
    if not isinstance(headers, list) or not headers or len(headers) > MAX_COLS:
        return "Invalid headers."
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        return f"Invalid rows (max {MAX_ROWS:,})."
    if not all(isinstance(h, str) and len(h) <= 255 for h in headers):
        return "Invalid headers."
    for r in rows:
        if not isinstance(r, list) or len(r) > MAX_COLS:
            return "Invalid row."
        if not all(isinstance(c, str) for c in r):
            return "Cells must be text."
    return headers, rows


async def read_json(request: Request, limit: int):
    data = await read_body(request, limit)
    if data is None:
        return None, error(413, "That file is too large. Shopify accepts CSV files up to 15 MB.")
    try:
        return json.loads(data or b"{}"), None
    except ValueError:
        return None, error(400, "Malformed request.")


@app.post("/api/fix/data")
async def api_fix_data(request: Request):
    if (r := limited(fix_limiter, request)) is not None:
        return r
    body, err = await read_json(request, 25 * 1024 * 1024)
    if err:
        return err
    table = validate_table(body)
    if isinstance(table, str):
        return error(400, table)
    return JSONResponse(await run_in_threadpool(fix_shopify_csv, table[0], table[1]))


def safe_filename(name) -> str:
    base = re.split(r"[\\/]", str(name or "products.csv"))[-1]
    base = re.sub(r"\.(csv|tsv|txt)$", "", base, flags=re.I)
    base = re.sub(r"[^A-Za-z0-9._ -]", "", base)
    base = re.sub(r"\s+", "-", base)
    base = re.sub(r"^[.-]+", "", base)[:80] or "products"
    return f"{base}-fixed.csv"


@app.post("/api/exports")
async def api_create_export(request: Request):
    if (r := limited(export_limiter, request)) is not None:
        return r
    body, err = await read_json(request, 25 * 1024 * 1024)
    if err:
        return err
    table = validate_table(body)
    if isinstance(table, str):
        return error(400, table)

    def build():
        fixed = fix_shopify_csv(table[0], table[1])
        return fixed, serialize(fixed["headers"], fixed["rows"]).encode("utf-8")

    fixed, data = await run_in_threadpool(build)
    if len(data) > config.max_upload_bytes:
        return error(413, "The fixed file is larger than Shopify's 15 MB import limit. Split it into smaller files.")
    fc = body.get("fixedCount")
    fixed_count = max(0, min(10_000_000, int(fc))) if isinstance(fc, (int, float)) and not isinstance(fc, bool) else fixed["summary"]["fixed"]
    export_id = secrets.token_urlsafe(18)
    db.insert_export(export_id, request.state.device_id, safe_filename(body.get("filename")), data,
                     fixed["summary"]["rows"], fixed["summary"]["products"], fixed_count)
    return JSONResponse({"id": export_id, "url": f"/download/{export_id}"}, status_code=201)


def owned_export(request: Request, export_id: str):
    """Fetch an export belonging to this browser; otherwise a 404 that reveals nothing about other users' files."""
    if not EXPORT_ID.match(export_id):
        return None, error(404, "Download not found.")
    exp = db.get_export_meta(export_id)
    if exp is None or exp["owner"] != request.state.device_id:
        return None, error(404, "This download link has expired or was created in a different browser. Re-upload your CSV to continue.")
    return exp, None


@app.get("/api/exports/{export_id}")
async def api_export_status(request: Request, export_id: str):
    exp, err = owned_export(request, export_id)
    if err:
        return err
    return JSONResponse({
        "id": exp["id"],
        "filename": exp["filename"],
        "rows": exp["row_count"],
        "products": exp["product_count"],
        "fixed": exp["fixed_count"],
        "expiresAt": exp["expires_at"],
        "unlocked": exp["unlocked_at"] is not None,
        "unlockMethod": exp["unlock_method"],
        "freeRemaining": quota.free_remaining(client_ip(request), request.state.device_id),
        "freePerDay": config.free_downloads_per_day,
        "priceLabel": config.price_label,
        "paymentsEnabled": config.payments_enabled,
    }, headers={"Cache-Control": "no-store"})


@app.post("/api/exports/{export_id}/claim-free")
async def api_claim_free(request: Request, export_id: str):
    if (r := limited(action_limiter, request)) is not None:
        return r
    exp, err = owned_export(request, export_id)
    if err:
        return err
    if exp["unlocked_at"] is not None:
        return {"ok": True, "unlocked": True}
    ok, reason = quota.claim_free(client_ip(request), request.state.device_id, exp["id"])
    if not ok and reason == "free_used":
        return error(402, f"You've used your free download for today. Download this file for {config.price_label}, or come back tomorrow.")
    return {"ok": True, "unlocked": True}


@app.post("/api/exports/{export_id}/checkout")
async def api_checkout(request: Request, export_id: str):
    if (r := limited(action_limiter, request)) is not None:
        return r
    exp, err = owned_export(request, export_id)
    if err:
        return err
    if exp["unlocked_at"] is not None:
        return {"unlocked": True}
    if not config.payments_enabled:
        return error(503, "Payments are not configured yet. Add your Stripe keys to the server .env file.")
    body, err = await read_json(request, 2048)
    if err:
        return err
    # UK Consumer Contracts Regulations 2013 (reg. 37): the 14-day cancellation right for digital content
    # only ends if the customer expressly consents to immediate supply and acknowledges losing that right.
    if not isinstance(body, dict) or body.get("consent") is not True:
        return error(400, "Please tick the box to confirm you want your file straight away.")

    line_item = (
        {"price": config.stripe_price_id, "quantity": 1}
        if config.stripe_price_id
        else {
            "price_data": {
                "currency": config.price_currency,
                "unit_amount": config.price_amount,
                "product_data": {"name": "CSV Medic — fixed Shopify CSV (single file)"},
            },
            "quantity": 1,
        }
    )
    params = {
        "mode": "payment",
        "line_items": [line_item],
        "client_reference_id": exp["id"],
        "metadata": {"export_id": exp["id"], "consent": CONSENT_VERSION, "consent_at": datetime.now(timezone.utc).isoformat()},
        "payment_intent_data": {"metadata": {"export_id": exp["id"], "consent": CONSENT_VERSION}},
        "custom_text": {
            "submit": {
                "message": "Your fixed CSV is unlocked as soon as payment succeeds. You agreed to immediate supply and that this "
                "ends your 14-day right to cancel. Your rights if the file is faulty are not affected."
            }
        },
        "success_url": f"{config.app_url}/download/{exp['id']}?session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": f"{config.app_url}/download/{exp['id']}?cancelled=1",
        "expires_at": int(time.time()) + 3600,
    }
    try:
        session = await run_in_threadpool(lambda: stripe.checkout.Session.create(api_key=config.stripe_secret_key, **params))
    except stripe.StripeError:
        log.exception("Stripe checkout failed")
        return error(502, "Could not start checkout. Please try again in a moment.")
    return {"url": _get(session, "url")}


def record_paid_session(session) -> None:
    export_id = _get(session, "metadata", "export_id")
    if not export_id or not EXPORT_ID.match(str(export_id)):
        return
    pi = _get(session, "payment_intent")
    db.insert_payment(_get(session, "id"), export_id, _get(session, "amount_total"), _get(session, "currency"), pi if isinstance(pi, str) else None)
    db.unlock_export(None, export_id, "stripe")


@app.post("/api/exports/{export_id}/verify")
async def api_verify(request: Request, export_id: str):
    """Called when Stripe redirects back, so the file unlocks instantly even if the webhook is delayed."""
    if (r := limited(action_limiter, request)) is not None:
        return r
    exp, err = owned_export(request, export_id)
    if err:
        return err
    if exp["unlocked_at"] is not None:
        return {"unlocked": True}
    body, err = await read_json(request, 2048)
    if err:
        return err
    session_id = str((body or {}).get("sessionId", "")) if isinstance(body, dict) else ""
    if not config.payments_enabled or not re.fullmatch(r"cs_(test|live)_[A-Za-z0-9]{10,200}", session_id):
        return error(400, "Invalid payment session.")
    try:
        session = await run_in_threadpool(lambda: stripe.checkout.Session.retrieve(session_id, api_key=config.stripe_secret_key))
    except stripe.StripeError:
        log.exception("Stripe verify failed")
        return error(502, "Could not confirm the payment yet. Please refresh in a moment.")
    if _get(session, "metadata", "export_id") != exp["id"]:
        return error(400, "That payment is for a different file.")
    if _get(session, "payment_status") != "paid":
        return {"unlocked": False, "status": _get(session, "payment_status")}
    record_paid_session(session)
    return {"unlocked": True}


@app.get("/api/exports/{export_id}/file")
async def api_download_file(request: Request, export_id: str):
    if not EXPORT_ID.match(export_id):
        return Response(status_code=404)
    row = db.get_export_csv(export_id, request.state.device_id)
    if row is None:
        return error(403, "This file is locked or has expired.")
    return Response(
        bytes(row["csv"]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{row["filename"]}"', "Cache-Control": "no-store"},
    )


@app.post("/api/stripe/webhook")
async def stripe_webhook(request: Request):
    if not config.payments_enabled or not config.stripe_webhook_secret:
        return Response(status_code=503)
    payload = await read_body(request, 1024 * 1024)
    if payload is None:
        return Response(status_code=413)
    try:
        event = stripe.Webhook.construct_event(payload, request.headers.get("stripe-signature", ""), config.stripe_webhook_secret)
    except (ValueError, stripe.SignatureVerificationError):
        return PlainTextResponse("Invalid signature", status_code=400)
    if _get(event, "type") in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        session = _get(event, "data", "object")
        if _get(session, "payment_status") == "paid":
            record_paid_session(session)
    return {"received": True}


# ---------------------------------------------------------------------------
# Static files (last) + 404
# ---------------------------------------------------------------------------
_PUBLIC_ROOT = PUBLIC.resolve()


@app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
async def static_files(path: str):
    if path.startswith("api/"):
        return error(404, "Not found.")
    if path and not any(part.startswith(".") for part in path.split("/")):
        candidate = (PUBLIC / path).resolve()
        if candidate.is_file() and _PUBLIC_ROOT in candidate.parents:
            suffix = candidate.suffix.lower()
            if suffix == ".html":
                cache = "no-cache"
            elif suffix in (".css", ".js"):
                cache = "public, max-age=3600, stale-while-revalidate=86400" if config.is_prod else "no-cache"
            else:
                cache = "public, max-age=604800" if config.is_prod else "no-cache"
            return FileResponse(candidate, headers={"Cache-Control": cache})
    return HTMLResponse((PUBLIC / "404.html").read_text(encoding="utf-8"), status_code=404)


@app.exception_handler(404)
async def not_found(request: Request, exc):
    if request.url.path.startswith("/api/"):
        return error(404, "Not found.")
    return HTMLResponse((PUBLIC / "404.html").read_text(encoding="utf-8"), status_code=404)


@app.exception_handler(405)
async def method_not_allowed(request: Request, exc):
    return error(405, "Method not allowed.")


@app.exception_handler(Exception)
async def server_error(request: Request, exc: Exception):
    log.exception("Unhandled error on %s", request.url.path)
    return error(500, "Something went wrong on our side. Please try again.")
