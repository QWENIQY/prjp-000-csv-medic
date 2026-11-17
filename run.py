#!/usr/bin/env python3
"""
CSV Medic — one command to set up and run everything.

    python3 run.py            start the website (production mode)
    python3 run.py dev        start in development mode (auto-reload on code changes)
    python3 run.py test       run the test suite
    python3 run.py indexnow   tell Bing / ChatGPT search that your pages changed

On first run this script:
  1. checks your Python version (3.10+),
  2. creates a private virtual environment in .venv and installs the requirements
     (and re-installs automatically whenever requirements.txt changes),
  3. creates your .env settings file from .env.example and generates the secret keys,
  4. starts the web server.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
REQUIREMENTS = ROOT / "requirements.txt"
STAMP = VENV / ".requirements.sha256"
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"


def say(msg: str) -> None:
    print(f"[csv-medic] {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"\n[csv-medic] ERROR: {msg}\n", file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# 1. Python version
# ---------------------------------------------------------------------------
if sys.version_info < (3, 10):
    fail(f"Python 3.10 or newer is required (you have {sys.version.split()[0]}). Install a newer Python and run again.")


# ---------------------------------------------------------------------------
# 2. Virtual environment + dependencies
# ---------------------------------------------------------------------------
def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def requirements_hash() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def in_our_venv() -> bool:
    return Path(sys.prefix).resolve() == VENV.resolve()


def deps_importable() -> bool:
    try:
        import fastapi  # noqa: F401
        import stripe  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError:
        return False
    return True


def ensure_environment() -> None:
    """Make sure we're running with the right packages; re-launch inside .venv if needed."""
    if in_our_venv():
        if not STAMP.exists() or STAMP.read_text().strip() != requirements_hash():
            install_requirements(Path(sys.executable))
        return
    # Hosts like Render/Heroku install requirements themselves — use their environment directly.
    if os.environ.get("CSVMEDIC_NO_VENV") == "1" and deps_importable():
        return

    py = venv_python()
    if not py.exists():
        say("First run: creating a virtual environment in .venv …")
        try:
            venv.EnvBuilder(with_pip=True, clear=True).create(VENV)
        except Exception as exc:  # e.g. Debian/Ubuntu without python3-venv
            shutil.rmtree(VENV, ignore_errors=True)
            hint = " On Ubuntu/Debian run:  sudo apt install python3-venv" if sys.platform.startswith("linux") else ""
            fail(f"Could not create a virtual environment ({exc}).{hint}")
    if not STAMP.exists() or STAMP.read_text().strip() != requirements_hash():
        install_requirements(py)
    # Re-run this script with the venv's Python.
    args = [str(py), str(Path(__file__).resolve()), *sys.argv[1:]]
    if os.name == "nt":
        sys.exit(subprocess.call(args))
    os.execv(str(py), args)


def install_requirements(py: Path) -> None:
    say("Installing requirements (this only happens when requirements.txt changes) …")
    cmd = [str(py), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", str(REQUIREMENTS)]
    if subprocess.call(cmd) != 0:
        fail("Installing requirements failed — see the pip output above.")
    STAMP.write_text(requirements_hash())


# ---------------------------------------------------------------------------
# 3. .env settings file
# ---------------------------------------------------------------------------
def ensure_env_file() -> None:
    if not ENV_FILE.exists():
        if ENV_EXAMPLE.exists():
            shutil.copy(ENV_EXAMPLE, ENV_FILE)
        else:
            ENV_FILE.write_text("")
        say("Created .env from .env.example — open it to add your Stripe keys and business details.")
        try:
            os.chmod(ENV_FILE, 0o600)
        except OSError:
            pass
    fill_secret("IP_HASH_SECRET", lambda: secrets.token_hex(32))


def fill_secret(key: str, make) -> None:
    """Generate a value for `key` in .env if it's missing or blank (and not set in the real environment)."""
    if os.environ.get(key):
        return
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith(f"{key}="):
            if line.split("=", 1)[1].strip():
                return
            lines[i] = f"{key}={make()}"
            break
    else:
        lines.append(f"{key}={make()}")
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    say(f"Generated {key} in .env (keep it secret and don't change it).")


# ---------------------------------------------------------------------------
# 4. Commands
# ---------------------------------------------------------------------------
def start(dev: bool) -> None:
    os.environ["CSVMEDIC_ENV"] = "development" if dev else "production"
    sys.path.insert(0, str(ROOT))
    import uvicorn

    from csvmedic.config import config

    say(f"Starting CSV Medic on http://{'localhost' if config.host in ('0.0.0.0', '127.0.0.1') else config.host}:{config.port}  "
        f"({'development' if dev else 'production'} mode)")
    say(f"Public URL (APP_URL): {config.app_url}")
    if not config.payments_enabled:
        say("Note: STRIPE_SECRET_KEY is not set — the free download works, paid downloads are disabled.")
    elif not config.stripe_webhook_secret:
        say("Note: STRIPE_WEBHOOK_SECRET is not set — payments still unlock on redirect, but add the webhook for reliability.")
    if not dev and not config.app_url.startswith("https://") and "localhost" not in config.app_url:
        say("Warning: APP_URL is not https:// — set it to your real https address in .env before going live.")

    uvicorn.run(
        "csvmedic.app:app",
        host=config.host,
        port=config.port,
        reload=dev,
        reload_dirs=[str(ROOT / "csvmedic")] if dev else None,
        proxy_headers=False,  # client IPs are resolved by the app using TRUST_PROXY
        server_header=False,
        date_header=True,
        log_level="info",
        access_log=dev,
        timeout_keep_alive=10,
        limit_concurrency=500,
    )


def run_tests() -> None:
    import unittest

    sys.path.insert(0, str(ROOT))
    os.environ.setdefault("CSVMEDIC_ENV", "development")
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), top_level_dir=str(ROOT))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)


def run_indexnow() -> None:
    import json
    import re
    import urllib.request

    sys.path.insert(0, str(ROOT))
    from csvmedic.config import config

    if not config.indexnow_key:
        fail("Set INDEXNOW_KEY in .env (8–128 letters, numbers or dashes).")
    if not config.app_url.startswith("https://"):
        fail("APP_URL must be your live https:// URL.")
    with urllib.request.urlopen(f"{config.app_url}/sitemap.xml", timeout=20) as r:
        urls = re.findall(r"<loc>([^<]+)</loc>", r.read().decode())
    body = json.dumps({"host": config.app_url.split("//", 1)[1].split("/")[0], "key": config.indexnow_key,
                       "keyLocation": f"{config.app_url}/{config.indexnow_key}.txt", "urlList": urls}).encode()
    req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body, headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=20) as r:
        say(f"IndexNow: submitted {len(urls)} URLs → HTTP {r.status}")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "start"
    if command in ("-h", "--help", "help"):
        print(__doc__)
        return
    if command not in ("start", "dev", "test", "indexnow"):
        fail(f"Unknown command '{command}'. Use: start, dev, test or indexnow.")
    ensure_environment()
    os.chdir(ROOT)
    if command == "test":
        run_tests()
    ensure_env_file()
    if command == "indexnow":
        run_indexnow()
    else:
        start(dev=command == "dev")


if __name__ == "__main__":
    main()
