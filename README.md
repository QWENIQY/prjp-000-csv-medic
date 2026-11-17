# CSV Medic — by QWENIQY

Fix Shopify product CSV files in seconds. Upload a CSV, review every automatic fix in an editor, then download a clean
file. Each visitor gets 1 free download per day, then pays £5 per file through Stripe.

Built with Python and FastAPI.

## Run it

```bash
python3 run.py
```

That's all. On first run, `run.py`:

1. checks you have Python 3.10 or newer;
2. creates a private virtual environment in `.venv` and installs `requirements.txt` (it re-installs automatically when that file changes);
3. creates `.env` from `.env.example` and generates the secret key;
4. starts the website on port 3000. Open http://localhost:3000.

Other commands:

| Command | What it does |
| --- | --- |
| `python3 run.py dev` | Development mode. Reloads automatically when you edit Python code. |
| `python3 run.py test` | Runs the test suite. |
| `python3 run.py indexnow` | Tells Bing (which also powers ChatGPT search and Copilot) that your pages changed. |

Your settings live in `.env`: Stripe keys, business details for the legal pages, and so on. Every option is explained in `.env.example`.

## Putting it online

### Option A: any Linux server or VPS

```bash
git clone https://github.com/YOU/csv-medic.git && cd csv-medic
python3 run.py            # first run creates .env, then press Ctrl+C
nano .env                 # set APP_URL=https://yourdomain, Stripe keys, business details, TRUST_PROXY=1
python3 run.py
```

On Ubuntu or Debian, if it says it can't create a virtual environment, run `sudo apt install python3-venv` first.

Put Caddy or Nginx in front of it to get HTTPS, and keep it running with systemd. Example `/etc/systemd/system/csvmedic.service`:

```ini
[Unit]
Description=CSV Medic
After=network.target

[Service]
WorkingDirectory=/home/YOU/csv-medic
ExecStart=/usr/bin/python3 run.py
Restart=always
User=YOU

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now csvmedic`. With Caddy, HTTPS is two lines in `/etc/caddy/Caddyfile`:

```
yourdomain.co.uk {
    reverse_proxy localhost:3000
}
```

### Option B: Render (free plan)

Push to GitHub. In Render choose **New → Blueprint** and select this repo; `render.yaml` configures everything.
The free plan has two limits:

- It sleeps after 15 minutes without visitors, so the next visit takes 30–60 seconds to load.
- It has no permanent disk, so the database resets on restarts.

For a permanent disk, switch to the `starter` plan and uncomment the disk in `render.yaml`.

## How it works

| Page | Path | What it does |
| --- | --- | --- |
| Home | `/` | Hero with demo video placeholder, about, features, Shopify errors, before/after, pricing, FAQ |
| Editor | `/app` | Upload a file. Fixed data appears in a fast virtualised grid with an issue panel, inline editing, undo and live re-checks |
| Download | `/download/:id` | Free daily download, or £5 one-time Stripe payment, then the file downloads |
| Guides | `/shopify-csv-errors`, `/shopify-csv-template` | SEO content pages |
| Legal | `/terms`, `/privacy`, `/cookies`, `/refunds`, `/legal` | Filled from your business details in `.env` |

1. The browser uploads the CSV.
2. The server decodes it (UTF-8, UTF-16 or Windows-1252), detects the delimiter and runs the fixer in `csvmedic/fixer.py`.
3. The editor shows the results.
4. On **Download**, the server re-runs the fixer, stores the CSV for 24 hours and returns a locked download page.
5. The file is only served after a free claim or a confirmed Stripe payment, and only to the browser that created it.

### Free download limit

A free download is refused if **either** the visitor's IP address **or** their device cookie has already used today's
allowance. The allowance resets at midnight UK time. IPv6 addresses are grouped by their /64 prefix. IP addresses are
stored only as HMAC hashes and deleted after 3 days. Set `TRUST_PROXY` to the number of proxies in front of the app:
1 on Render, or behind Nginx or Caddy. Otherwise every visitor shares one IP address.

### Payments (Stripe Checkout)

1. Put your **secret key** (`sk_test_…` while testing) in `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint `https://YOURDOMAIN/api/stripe/webhook` for the events `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`, then put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Test with card `4242 4242 4242 4242`. Then switch to live keys and turn on Stripe's email receipts.

The checkout requires the UK 14-day cancellation-waiver consent, and the consent is recorded in the Stripe session metadata.

## Security

- Strict Content-Security-Policy with no inline scripts and no third-party origins, plus HSTS on https, frame blocking and `nosniff`.
- Cross-site requests to the API are blocked (`Sec-Fetch-Site` and `Origin` checks), and the cookie is HttpOnly with `SameSite=Lax`.
- Every API route is rate-limited, request sizes are capped (15 MB uploads), and all input is strictly validated.
- Download IDs are unguessable (144 bits), work only in the browser that created them, and files are deleted after 24 hours.
- Stripe webhook signatures are verified, and each payment session is checked against its file.
- Client IPs are resolved using exactly `TRUST_PROXY` hops, so spoofed `X-Forwarded-For` headers are ignored.

## SEO and AI search

- Server-rendered pages, gzip compression, no third-party scripts.
- Canonical URLs, Open Graph cards and JSON-LD structured data (Organization, WebApplication with both prices, FAQPage, TechArticle).
- `/robots.txt` welcomes Google, Bing and AI crawlers. `/sitemap.xml` is generated automatically. `/llms.txt` gives AI assistants a plain-language summary.

After launch:

1. Add the site to Google Search Console and Bing Webmaster Tools, and submit `/sitemap.xml`.
2. Set `INDEXNOW_KEY`, then run `python3 run.py indexnow` after content changes.
3. Set `CANONICAL_REDIRECT=true` once your domain works.

## Before launch checklist

- [ ] Add the demo video: put it at `public/media/demo.mp4` and swap the placeholder (see the comment in `public/index.html`).
- [ ] Fill in your business details in `.env`. Have the legal pages reviewed.
- [ ] Register with the ICO (ico.org.uk/fee).
- [ ] Switch Stripe to live keys, create the live webhook and enable email receipts.
- [ ] Set `APP_URL` to your https address and `TRUST_PROXY` correctly.

## Project layout

```
run.py               One command: sets up .venv, .env, and runs the server / tests / indexnow
requirements.txt     Python dependencies (FastAPI, Uvicorn, Stripe)
csvmedic/app.py      Web app: pages, API, Stripe, security, SEO endpoints
csvmedic/fixer.py    Shopify CSV rules engine (pure, idempotent, unit tested)
csvmedic/csvio.py    Encoding detection, delimiter sniffing, CSV parse/serialise
csvmedic/quota.py    Free daily download tracking (hashed IP + device cookie)
csvmedic/db.py       SQLite storage (built into Python)
csvmedic/config.py   Settings from .env / environment
public/              Website files: pages, CSS, browser JavaScript for the editor
tests/               Unit tests
```
