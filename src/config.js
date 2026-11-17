'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const isProd = process.env.NODE_ENV === 'production';

function required(name, fallbackForDev) {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return fallbackForDev;
}

const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

const config = {
  isProd,
  port: Number(process.env.PORT || 3000),
  appUrl,
  appOrigin: new URL(appUrl).origin,
  // Number of proxy hops in front of the app (e.g. 1 behind Render/Fly/Nginx). Needed for correct client IPs.
  trustProxy: process.env.TRUST_PROXY ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY) : false,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'csvmedic.db'),
  // Secret used to hash IP addresses — we never store raw IPs.
  ipHashSecret: required('IP_HASH_SECRET', crypto.randomBytes(32).toString('hex')),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceId: process.env.STRIPE_PRICE_ID || '', // optional: use a Price from your Stripe dashboard
  priceAmount: Number(process.env.PRICE_AMOUNT_PENCE || 500), // £5.00
  priceCurrency: (process.env.PRICE_CURRENCY || 'gbp').toLowerCase(),
  freeDownloadsPerDay: Number(process.env.FREE_DOWNLOADS_PER_DAY || 1),
  quotaTimeZone: process.env.QUOTA_TIMEZONE || 'Europe/London',
  exportTtlHours: Number(process.env.EXPORT_TTL_HOURS || 24),
  maxUploadBytes: 15 * 1024 * 1024, // Shopify's own CSV import limit is 15 MB
  contactEmail: process.env.CONTACT_EMAIL || '',
  // 301-redirect any other hostname (e.g. www. or the host's default *.onrender.com URL) to APP_URL.
  canonicalRedirect: process.env.CANONICAL_REDIRECT === 'true',
  indexNowKey: /^[A-Za-z0-9-]{8,128}$/.test(process.env.INDEXNOW_KEY || '') ? process.env.INDEXNOW_KEY : '',
  // Business details shown on the legal pages (/terms, /privacy, /cookies, /refunds, /legal).
  // Anything left blank shows as a highlighted [placeholder] so it can't be missed.
  legal: {
    LEGAL_NAME: process.env.LEGAL_NAME || '',
    COMPANY_NUMBER: process.env.COMPANY_NUMBER || '',
    REGISTERED_ADDRESS: process.env.REGISTERED_ADDRESS || '',
    CONTACT_EMAIL: process.env.CONTACT_EMAIL || '',
    VAT_NUMBER: process.env.VAT_NUMBER || '',
    ICO_NUMBER: process.env.ICO_NUMBER || '',
    HOSTING_PROVIDER: process.env.HOSTING_PROVIDER || '',
    HOSTING_LOCATION: process.env.HOSTING_LOCATION || '',
  },
};

config.priceLabel = new Intl.NumberFormat('en-GB', { style: 'currency', currency: config.priceCurrency.toUpperCase() }).format(config.priceAmount / 100);
config.paymentsEnabled = Boolean(config.stripeSecretKey);

module.exports = config;
