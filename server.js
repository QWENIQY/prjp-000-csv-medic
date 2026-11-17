'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');

const config = require('./src/config');
const { stmts, cleanup } = require('./src/db');
const { decodeBuffer, sniffDelimiter, parse, serialize } = require('./src/csv');
const { fixShopifyCsv } = require('./src/fixer');
const quota = require('./src/quota');

const stripe = config.paymentsEnabled ? require('stripe')(config.stripeSecretKey) : null;

const app = express();
const PUBLIC = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

/* ------------------------------------------------------------------ */
/* Security headers                                                    */
/* ------------------------------------------------------------------ */
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

/* ------------------------------------------------------------------ */
/* Stripe webhook — must read the RAW body, so it's mounted before     */
/* any JSON parsing or compression.                                    */
/* ------------------------------------------------------------------ */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  if (!stripe || !config.stripeWebhookSecret) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
  } catch {
    return res.status(400).send('Invalid signature');
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    if (session.payment_status === 'paid') recordPaidSession(session);
  }
  res.json({ received: true });
});

app.use(compression());

/* ------------------------------------------------------------------ */
/* Device cookie (identifies the browser for ownership + quota)        */
/* ------------------------------------------------------------------ */
const DEVICE_COOKIE = 'cm_did';
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies[DEVICE_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{32,64}$/.test(id)) {
    id = crypto.randomBytes(24).toString('base64url');
    res.append(
      'Set-Cookie',
      `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 400}; HttpOnly; SameSite=Lax${config.isProd ? '; Secure' : ''}`,
    );
  }
  req.deviceId = id;
  next();
});

/* ------------------------------------------------------------------ */
/* CSRF defence for state-changing API calls: reject cross-site POSTs. */
/* ------------------------------------------------------------------ */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Cross-site request blocked.' });
  const origin = req.headers.origin;
  if (origin && origin !== config.appOrigin) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  next();
});

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */
const limiter = (windowMs, limit) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests — please slow down and try again shortly.' } });
const fixLimiter = limiter(60_000, 40);
const exportLimiter = limiter(10 * 60_000, 30);
const actionLimiter = limiter(60_000, 20);

/* ------------------------------------------------------------------ */
/* Pages & SEO                                                         */
/* ------------------------------------------------------------------ */

// Normalise URLs so search engines see exactly one address per page.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (config.canonicalRedirect && req.path !== '/healthz') {
    const host = new URL(config.appUrl).host;
    if (req.headers.host && req.headers.host !== host) return res.redirect(301, config.appUrl + req.originalUrl);
  }
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const q = req.originalUrl.slice(req.path.length);
    return res.redirect(301, req.path.replace(/\/+$/, '') + q);
  }
  next();
});

// Private / transactional URLs must never appear in search results.
app.use(['/download', '/api'], (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Public pages: clean URL -> file in /public. Templates use {{TOKENS}} (APP_URL, business details…).
const PAGES = {
  '/': { file: 'index', priority: '1.0', changefreq: 'weekly' },
  '/app': { file: 'app', priority: '0.9', changefreq: 'monthly' },
  '/shopify-csv-errors': { file: 'shopify-csv-errors', priority: '0.9', changefreq: 'monthly' },
  '/shopify-csv-template': { file: 'shopify-csv-template', priority: '0.8', changefreq: 'monthly' },
  '/terms': { file: 'terms', priority: '0.3', changefreq: 'yearly' },
  '/privacy': { file: 'privacy', priority: '0.3', changefreq: 'yearly' },
  '/cookies': { file: 'cookies', priority: '0.2', changefreq: 'yearly' },
  '/refunds': { file: 'refunds', priority: '0.3', changefreq: 'yearly' },
  '/legal': { file: 'legal', priority: '0.2', changefreq: 'yearly' },
};
const TODO_LABELS = {
  LEGAL_NAME: 'Legal business name — set LEGAL_NAME',
  COMPANY_NUMBER: 'Company number — set COMPANY_NUMBER',
  REGISTERED_ADDRESS: 'Registered / business address — set REGISTERED_ADDRESS',
  CONTACT_EMAIL: 'Contact email — set CONTACT_EMAIL',
  CONTACT_EMAIL_LINK: 'Contact email — set CONTACT_EMAIL',
  VAT_NUMBER: 'VAT number, or "Not VAT registered" — set VAT_NUMBER',
  ICO_NUMBER: 'ICO registration number — set ICO_NUMBER',
  HOSTING_PROVIDER: 'Hosting provider — set HOSTING_PROVIDER',
  HOSTING_LOCATION: 'Hosting location (e.g. United Kingdom) — set HOSTING_LOCATION',
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pageTokens = () => ({
  ...config.legal,
  CONTACT_EMAIL_LINK: config.legal.CONTACT_EMAIL ? `<a href="mailto:${escapeHtml(config.legal.CONTACT_EMAIL)}">${escapeHtml(config.legal.CONTACT_EMAIL)}</a>` : '',
  APP_URL: config.appUrl,
  PRICE: config.priceLabel,
  FREE_PER_DAY: String(config.freeDownloadsPerDay),
  EXPORT_TTL_HOURS: String(config.exportTtlHours),
});
const RAW_TOKENS = new Set(['CONTACT_EMAIL_LINK']);
const pageCache = new Map();
function renderPage(file) {
  if (pageCache.has(file)) return pageCache.get(file);
  const tokens = pageTokens();
  const html = fs.readFileSync(path.join(PUBLIC, `${file}.html`), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    const v = tokens[key];
    if (v) return RAW_TOKENS.has(key) ? v : escapeHtml(v);
    return `<mark class="todo">[${escapeHtml(TODO_LABELS[key] || key)}]</mark>`;
  });
  if (config.isProd) pageCache.set(file, html);
  return html;
}
for (const [route, { file }] of Object.entries(PAGES)) {
  app.get(route, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(renderPage(file));
  });
  app.get(`/${file}.html`, (req, res) => res.redirect(301, route));
}
app.get('/download/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC, 'download.html'));
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

if (config.isProd) {
  const missing = Object.entries(config.legal).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.warn(`[legal] These business details are not set and show as placeholders on the legal pages: ${missing.join(', ')}`);
}

/* robots.txt — search engines and AI assistants are welcome on public pages. */
const AI_AND_SEARCH_BOTS = [
  'Googlebot', 'Bingbot', 'Google-Extended', 'Applebot', 'Applebot-Extended', 'DuckDuckBot',
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Amazonbot', 'meta-externalagent', 'CCBot',
];
app.get('/robots.txt', (req, res) => {
  const rules = 'Allow: /\nDisallow: /api/\nDisallow: /download/\n';
  const body = [
    `User-agent: *\n${rules}`,
    '# Search engines and AI assistants: you are welcome to index and cite our public pages.',
    ...AI_AND_SEARCH_BOTS.map((b) => `User-agent: ${b}\n${rules}`),
    `Sitemap: ${config.appUrl}/sitemap.xml`,
  ].join('\n');
  res.type('text/plain').send(body + '\n');
});

/* sitemap.xml — generated from PAGES, with lastmod from each file's modification time. */
app.get('/sitemap.xml', (req, res) => {
  const urls = Object.entries(PAGES).map(([route, p]) => {
    const lastmod = fs.statSync(path.join(PUBLIC, `${p.file}.html`)).mtime.toISOString().slice(0, 10);
    return `  <url><loc>${config.appUrl}${route === '/' ? '/' : route}</loc><lastmod>${lastmod}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`;
  });
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
});

/* llms.txt — a plain-language summary for AI assistants (https://llmstxt.org). */
app.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(
    fs.readFileSync(path.join(PUBLIC, 'llms.txt'), 'utf8').replaceAll('{{APP_URL}}', config.appUrl).replaceAll('{{PRICE}}', config.priceLabel),
  );
});

/* IndexNow key file (Bing, Yandex, Seznam…; Bing's index also powers ChatGPT search and Copilot). */
if (config.indexNowKey) {
  app.get(`/${config.indexNowKey}.txt`, (req, res) => res.type('text/plain').send(config.indexNowKey));
}

/* security.txt (RFC 9116) so researchers know how to report vulnerabilities. */
app.get('/.well-known/security.txt', (req, res) => {
  const expires = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString();
  const contact = config.legal.CONTACT_EMAIL ? `mailto:${config.legal.CONTACT_EMAIL}` : `${config.appUrl}/legal`;
  res.type('text/plain').send(`Contact: ${contact}\nExpires: ${expires}\nPreferred-Languages: en\nCanonical: ${config.appUrl}/.well-known/security.txt\nPolicy: ${config.appUrl}/legal#security\n`);
});

app.use(
  express.static(PUBLIC, {
    index: false,
    extensions: false,
    maxAge: config.isProd ? '7d' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      // CSS/JS aren't fingerprinted, so let browsers revalidate them quickly; images/fonts can cache longer.
      else if (/\.(css|js)$/.test(filePath)) res.setHeader('Cache-Control', config.isProd ? 'public, max-age=3600, stale-while-revalidate=86400' : 'no-cache');
    },
  }),
);

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
const MAX_ROWS = 200_000;
const MAX_COLS = 500;

app.get('/api/config', (req, res) => {
  res.json({
    priceLabel: config.priceLabel,
    paymentsEnabled: config.paymentsEnabled,
    freePerDay: config.freeDownloadsPerDay,
    maxUploadBytes: config.maxUploadBytes,
  });
});

/** Upload a raw CSV file (body = file bytes) and get it back fixed + a list of issues. */
app.post(
  '/api/fix/upload',
  fixLimiter,
  express.raw({ type: () => true, limit: config.maxUploadBytes }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'The file is empty.' });
    const { text, encoding, notes } = decodeBuffer(req.body);
    if (text.includes('\u0000')) return res.status(400).json({ error: "That doesn't look like a CSV file (it contains binary data). If it's an Excel file, use File → Save As → CSV UTF-8 first." });
    const delimiter = sniffDelimiter(text);
    const { rows, unterminated } = parse(text, delimiter);
    if (rows.length === 0) return res.status(400).json({ error: 'No rows found in the file.' });
    if (rows.length > MAX_ROWS + 1) return res.status(413).json({ error: `Files are limited to ${MAX_ROWS.toLocaleString('en-GB')} rows.` });
    if (rows[0].length > MAX_COLS) return res.status(413).json({ error: `Files are limited to ${MAX_COLS} columns.` });

    const preNotes = [...notes];
    if (delimiter !== ',') preNotes.push(`File used ${delimiter === '\t' ? 'tabs' : `"${delimiter}"`} between columns — converted to commas, which Shopify requires.`);
    if (unterminated) preNotes.push('The file ended inside an unclosed quote — the last cell may be incomplete. Check the final row.');

    const [headers, ...data] = rows;
    const result = fixShopifyCsv({ headers, rows: data, preNotes });
    res.json({ ...result, meta: { encoding, delimiter } });
  },
);

/** Re-check data that has been edited in the browser. */
app.post('/api/fix/data', fixLimiter, express.json({ limit: '25mb' }), (req, res) => {
  const table = validateTable(req.body);
  if (table.error) return res.status(400).json({ error: table.error });
  res.json(fixShopifyCsv(table));
});

/** Store the (re-fixed) CSV server-side and return a download page id. The file itself is locked until paid / free claim. */
app.post('/api/exports', exportLimiter, express.json({ limit: '25mb' }), (req, res) => {
  const table = validateTable(req.body);
  if (table.error) return res.status(400).json({ error: table.error });

  const fixed = fixShopifyCsv(table);
  const csv = serialize(fixed.headers, fixed.rows);
  const bytes = Buffer.from(csv, 'utf8');
  if (bytes.length > config.maxUploadBytes) return res.status(413).json({ error: 'The fixed file is larger than Shopify\'s 15 MB import limit. Split it into smaller files.' });

  const id = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  const fixedCount = Number.isFinite(req.body.fixedCount) ? Math.max(0, Math.min(1e7, Math.floor(req.body.fixedCount))) : fixed.summary.fixed;
  stmts.insertExport.run(
    id,
    req.deviceId,
    safeFilename(req.body.filename),
    bytes,
    fixed.summary.rows,
    fixed.summary.products,
    fixedCount,
    now,
    now + config.exportTtlHours * 3600_000,
  );
  res.status(201).json({ id, url: `/download/${id}` });
});

app.get('/api/exports/:id', (req, res) => {
  const exp = loadOwnedExport(req, res);
  if (!exp) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: exp.id,
    filename: exp.filename,
    rows: exp.row_count,
    products: exp.product_count,
    fixed: exp.fixed_count,
    expiresAt: exp.expires_at,
    unlocked: Boolean(exp.unlocked_at),
    unlockMethod: exp.unlock_method,
    freeRemaining: quota.freeRemaining(req.ip, req.deviceId),
    freePerDay: config.freeDownloadsPerDay,
    priceLabel: config.priceLabel,
    paymentsEnabled: config.paymentsEnabled,
  });
});

app.post('/api/exports/:id/claim-free', actionLimiter, (req, res) => {
  const exp = loadOwnedExport(req, res);
  if (!exp) return;
  if (exp.unlocked_at) return res.json({ ok: true, unlocked: true });
  const result = quota.claimFree(req.ip, req.deviceId, exp.id);
  if (!result.ok && result.reason === 'free_used') {
    return res.status(402).json({ error: `You've used your free download for today. Download this file for ${config.priceLabel}, or come back tomorrow.` });
  }
  res.json({ ok: true, unlocked: true });
});

// Version of the digital-content cancellation waiver wording shown on the download page.
const CONSENT_VERSION = 'digital-content-waiver-2026-11-17';

app.post('/api/exports/:id/checkout', actionLimiter, express.json({ limit: '2kb' }), async (req, res, next) => {
  try {
    const exp = loadOwnedExport(req, res);
    if (!exp) return;
    if (exp.unlocked_at) return res.json({ unlocked: true });
    // UK Consumer Contracts Regulations 2013 (reg. 37): the 14-day cancellation right for digital content
    // only ends if the customer expressly consents to immediate supply and acknowledges losing that right.
    if (req.body?.consent !== true) return res.status(400).json({ error: 'Please tick the box to confirm you want your file straight away.' });
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured yet. Add your Stripe keys to the server .env file.' });

    const lineItem = config.stripePriceId
      ? { price: config.stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: config.priceCurrency,
            unit_amount: config.priceAmount,
            product_data: { name: 'CSV Medic — fixed Shopify CSV (single file)' },
          },
          quantity: 1,
        };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      client_reference_id: exp.id,
      metadata: { export_id: exp.id, consent: CONSENT_VERSION, consent_at: new Date().toISOString() },
      payment_intent_data: { metadata: { export_id: exp.id, consent: CONSENT_VERSION } },
      custom_text: {
        submit: {
          message:
            'Your fixed CSV is unlocked as soon as payment succeeds. You agreed to immediate supply and that this ends your 14-day right to cancel. Your rights if the file is faulty are not affected.',
        },
      },
      success_url: `${config.appUrl}/download/${exp.id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.appUrl}/download/${exp.id}?cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
    });
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

/** Called when Stripe redirects back, so the file unlocks instantly even if the webhook is delayed. */
app.post('/api/exports/:id/verify', actionLimiter, express.json({ limit: '2kb' }), async (req, res, next) => {
  try {
    const exp = loadOwnedExport(req, res);
    if (!exp) return;
    if (exp.unlocked_at) return res.json({ unlocked: true });
    const sessionId = String(req.body?.sessionId || '');
    if (!stripe || !/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid payment session.' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.export_id !== exp.id) return res.status(400).json({ error: 'That payment is for a different file.' });
    if (session.payment_status !== 'paid') return res.json({ unlocked: false, status: session.payment_status });
    recordPaidSession(session);
    res.json({ unlocked: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/exports/:id/file', (req, res) => {
  if (!isValidId(req.params.id)) return res.status(404).end();
  const row = stmts.getExportCsv.get(req.params.id, req.deviceId, Date.now());
  if (!row) return res.status(403).json({ error: 'This file is locked or has expired.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(row.csv));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* 404 + errors */
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large. Shopify accepts CSV files up to 15 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{24}$/.test(id);
}

/** Fetch an export that belongs to this browser; respond 404 otherwise (no info leak about other users' files). */
function loadOwnedExport(req, res) {
  if (!isValidId(req.params.id)) {
    res.status(404).json({ error: 'Download not found.' });
    return null;
  }
  const exp = stmts.getExportMeta.get(req.params.id, Date.now());
  if (!exp || exp.owner !== req.deviceId) {
    res.status(404).json({ error: 'This download link has expired or was created in a different browser. Re-upload your CSV to continue.' });
    return null;
  }
  return exp;
}

function validateTable(body) {
  if (!body || typeof body !== 'object') return { error: 'Missing data.' };
  const { headers, rows } = body;
  if (!Array.isArray(headers) || headers.length === 0 || headers.length > MAX_COLS) return { error: 'Invalid headers.' };
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return { error: `Invalid rows (max ${MAX_ROWS.toLocaleString('en-GB')}).` };
  if (!headers.every((h) => typeof h === 'string' && h.length <= 255)) return { error: 'Invalid headers.' };
  for (const r of rows) {
    if (!Array.isArray(r) || r.length > MAX_COLS) return { error: 'Invalid row.' };
    for (const c of r) if (typeof c !== 'string') return { error: 'Cells must be text.' };
  }
  return { headers, rows };
}

function safeFilename(name) {
  let base = String(name || 'products.csv').split(/[\\/]/).pop().replace(/\.(csv|tsv|txt)$/i, '');
  base = base.replace(/[^A-Za-z0-9._ -]/g, '').replace(/\s+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'products';
  return `${base}-fixed.csv`;
}

function recordPaidSession(session) {
  const exportId = session.metadata?.export_id;
  if (!exportId || !isValidId(exportId)) return;
  stmts.insertPayment.run(session.id, exportId, session.amount_total ?? null, session.currency ?? null, typeof session.payment_intent === 'string' ? session.payment_intent : null, Date.now());
  stmts.unlockExport.run(Date.now(), 'stripe', exportId);
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
cleanup();
const cleanupTimer = setInterval(cleanup, 10 * 60_000);
cleanupTimer.unref();

if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`CSV Medic running at ${config.appUrl} (payments ${config.paymentsEnabled ? 'enabled' : 'NOT configured'})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
