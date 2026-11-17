# CSV Medic — by QWENIQY

Fix Shopify product CSV files in seconds. Upload a CSV, review every automatic fix in an editor,
then download a clean file — 1 free download per day, then £5 per file via Stripe.

## Quick start

```bash
npm install
cp .env.example .env      # fill in IP_HASH_SECRET and your Stripe test keys
npm run dev               # http://localhost:3000
npm test                  # fixer unit tests
```

Requires Node.js 22.13+ (uses the built-in `node:sqlite` — no native modules to compile).

## How it works

| Page | Path | What it does |
| --- | --- | --- |
| Home | `/` | Hero + demo video placeholder, about, features, before/after, how it works, pricing, FAQ |
| Editor | `/app` | Upload → fixed data in a fast virtualised grid, issue panel, inline editing, undo, live re-check |
| Download | `/download/:id` | Free daily download **or** £5 one-time Stripe payment, then the file downloads |

**Flow:** the browser uploads the CSV → server decodes (UTF-8 / UTF-16 / Windows-1252), detects the delimiter,
and runs the fixer (`src/fixer.js`) → editor shows results → on *Download*, the server re-runs the fixer,
stores the CSV for 24 h, and returns a locked download page. The file is only served after
a free claim or a confirmed Stripe payment, and only to the browser that created it.

### Free download limit (1 per day)

A free download is refused if **either** the visitor's IP **or** their device cookie has already used today's allowance
(midnight-to-midnight, UK time). Clearing cookies doesn't help (same IP); switching network doesn't help (same cookie).
IPv6 addresses are grouped by /64 so people can't rotate through addresses on one connection.
IPs are stored only as HMAC hashes and purged after 3 days. Someone determined (VPN + private window) can still get
an extra free file — that's true of every IP-based limit, and the cost to you is negligible.

### Payments (Stripe Checkout)

Stripe Checkout is used because it supports cards, Apple Pay and Google Pay, handles UK Strong Customer
Authentication, and card details never touch your server.

1. Create a Stripe account → copy the **secret key** into `STRIPE_SECRET_KEY` (`sk_test_…` while testing).
2. Add a webhook endpoint `https://YOURDOMAIN/api/stripe/webhook` with events
   `checkout.session.completed` and `checkout.session.async_payment_succeeded` → put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Local testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook` (Stripe CLI) and pay with card `4242 4242 4242 4242`.

The file is unlocked both by the webhook *and* by verifying the Checkout Session when the customer is redirected back,
so the download is instant even if the webhook is delayed.

## Security

- Strict Content-Security-Policy (no inline scripts/styles, no third-party origins), HSTS in production, frame blocking, `nosniff`.
- CSRF protection: cross-site/cross-origin POSTs rejected (`Sec-Fetch-Site` + `Origin` checks) and `SameSite=Lax` HttpOnly cookie.
- Rate limits on every API route; request size limits (15 MB — Shopify's own import cap); strict input validation.
- Unguessable 144-bit download IDs, bound to the uploading browser; files deleted after 24 h.
- Stripe webhook signatures verified; payment sessions checked against the file they were created for.
- All user data rendered with `textContent` (no HTML injection).

## Deploying

Any Node host with a persistent disk works (Render, Railway, Fly.io, a VPS). Set:

```
NODE_ENV=production
APP_URL=https://csvmedic.yourdomain.com
IP_HASH_SECRET=<64 random hex chars>
TRUST_PROXY=1            # if behind a load balancer / Cloudflare — required for correct IPs
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
DB_PATH=/data/csvmedic.db   # on the persistent disk
```

Then `npm ci --omit=dev && npm start`. Always serve over HTTPS.

## SEO and AI search

Built in:

- Fast server-rendered pages (no JavaScript needed to read them), with gzip compression and no third-party scripts.
- A unique title, meta description and canonical URL on every page. Absolute URLs come from `APP_URL`.
- Open Graph and Twitter share cards (`public/img/og-image.png`).
- JSON-LD structured data: Organization, WebSite, WebApplication with both prices, FAQPage, TechArticle and BreadcrumbList.
- `/robots.txt` explicitly welcomes Google, Bing and AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and others), and blocks `/api/` and `/download/`.
- `/sitemap.xml`, generated automatically, and `/llms.txt`, a plain-language summary for AI assistants.
- Guide pages that answer what people search for:
  - `/shopify-csv-errors`: every Shopify import error message explained.
  - `/shopify-csv-template`: a free template download and every column explained.
- Private pages (`/download/*`, `/api/*`) are sent `X-Robots-Tag: noindex`. Trailing slashes and `.html` URLs 301-redirect to the clean URL.

After you go live:

1. **Google Search Console**: add your domain, then submit `https://YOURDOMAIN/sitemap.xml`. Use URL Inspection → Request indexing on `/`, `/shopify-csv-errors` and `/shopify-csv-template`.
2. **Bing Webmaster Tools**: import from Search Console with one click. Bing powers ChatGPT search and Copilot. Then set `INDEXNOW_KEY` and run `npm run indexnow` after each deploy that changes content.
3. Set `CANONICAL_REDIRECT=true` once your custom domain works.
4. Check the structured data at https://search.google.com/test/rich-results.

## Before launch checklist

- [ ] Add the demo video: `public/media/demo.mp4` and swap the placeholder (see the comment in `public/index.html`).
- [ ] Fill in your business address and contact email in `public/privacy.html` and `public/terms.html`, and have them reviewed.
- [ ] Switch Stripe to live keys and create the live webhook.
- [ ] Set `TRUST_PROXY` correctly for your host (check that `/api/exports/:id` shows the free download as used after claiming one).

## Project layout

```
server.js            Express app: pages, API, Stripe, security middleware
src/fixer.js         Shopify CSV rules engine (pure, idempotent, unit tested)
src/csv.js           Encoding detection, delimiter sniffing, RFC 4180 parse/serialise
src/quota.js         Free daily download tracking (hashed IP + device cookie)
src/db.js            SQLite schema + queries
public/              Static site (home, editor, download page, legal pages)
test/                node:test unit tests
```
