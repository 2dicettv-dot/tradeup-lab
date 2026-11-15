// CS2 Trade-Up Lab price updater.
// GitHub runs this every 10 minutes. It downloads every CS2 price from Skinport's free
// public feed, saves a compact copy as site/prices.json, and copies the app next to it.
// If Skinport can't be reached, it keeps the prices the site published last time.

import { mkdir, writeFile, copyFile } from 'node:fs/promises';

const SOURCE_URL = process.env.SKINPORT_URL || 'https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0';
const SITE_URL = process.env.SITE_URL || '';
const OUT = 'site';

const price = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchSkinport() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await getJson(SOURCE_URL, {
        // Skinport requires Brotli for this endpoint; Node decodes it automatically.
        'Accept-Encoding': 'br',
        Accept: 'application/json',
        'User-Agent': 'cs2-tradeup-lab-price-updater',
      });
      if (!Array.isArray(data) || !data.length) throw new Error('the feed was empty');
      return data;
    } catch (e) {
      lastError = e;
      console.log(`Skinport attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await wait((Number(process.env.RETRY_WAIT_MS) || 20000) * attempt);
    }
  }
  throw lastError;
}

await mkdir(OUT, { recursive: true });
await copyFile('index.html', `${OUT}/index.html`);

let payload = null;
try {
  const data = await fetchSkinport();
  const items = {};
  for (const it of data) {
    if (!it || typeof it.market_hash_name !== 'string') continue;
    items[it.market_hash_name] = [price(it.min_price), price(it.median_price), price(it.suggested_price), Number(it.quantity) || 0];
  }
  payload = {
    source: 'Skinport',
    currency: String(data[0].currency || 'USD'),
    fetchedAt: new Date().toISOString(),
    count: Object.keys(items).length,
    items,
  };
  console.log(`Saved ${payload.count} prices from Skinport.`);
} catch (e) {
  console.log(`::warning::Couldn't reach Skinport (${e.message}). Keeping the last published prices.`);
  if (SITE_URL) {
    try {
      payload = await getJson(SITE_URL.replace(/\/?$/, '/') + 'prices.json?t=' + Date.now());
      console.log(`Kept the prices saved at ${payload.fetchedAt}.`);
    } catch (e2) {
      console.log(`No earlier prices to keep (${e2.message}). The app will show sample prices until the next run.`);
    }
  }
}

if (payload) await writeFile(`${OUT}/prices.json`, JSON.stringify(payload));
