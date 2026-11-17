'use strict';
/**
 * Tell Bing (and other IndexNow engines) that your pages changed, so they're recrawled within hours.
 * Bing's index also powers ChatGPT search and Microsoft Copilot.
 *
 * Usage (after deploying):  npm run indexnow
 * Requires APP_URL (your live https URL) and INDEXNOW_KEY in .env, and the site to be live.
 */
const config = require('../src/config');

(async () => {
  if (!config.indexNowKey) throw new Error('Set INDEXNOW_KEY in .env (8–128 letters, numbers or dashes).');
  if (!config.appUrl.startsWith('https://')) throw new Error('APP_URL must be your live https:// URL.');
  const res = await fetch(`${config.appUrl}/sitemap.xml`);
  const xml = await res.text();
  const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const body = { host: new URL(config.appUrl).host, key: config.indexNowKey, keyLocation: `${config.appUrl}/${config.indexNowKey}.txt`, urlList };
  const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  console.log(`IndexNow: submitted ${urlList.length} URLs → HTTP ${r.status} ${r.status < 300 ? '(accepted)' : await r.text()}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
