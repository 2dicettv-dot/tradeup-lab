// CS2 Trade-Up Lab updater.
// GitHub runs this every 10 minutes. It:
//   1. downloads every CS2 price from Skinport's free public feed and saves site/prices.json
//   2. once a day, downloads the full CS2 skin list (every collection, rarity, float cap and
//      knife/glove pool) from the free ByMykel CSGO-API and saves site/items.json
//   3. copies the app (index.html) next to them
// If a download fails, it keeps what the site published last time.

import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SOURCE_URL = process.env.SKINPORT_URL || 'https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0';
const DB_SOURCES = process.env.DB_URL
  ? [process.env.DB_URL]
  : ['https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/', 'https://bymykel.github.io/CSGO-API/api/en/'];
const SITE_URL = process.env.SITE_URL || '';
const ITEMS_MAX_AGE_HOURS = Number(process.env.ITEMS_MAX_AGE_HOURS) || 24;
const OUT = 'site';
const UA = 'cs2-tradeup-lab-updater';

const price = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const siteFile = (name) => SITE_URL.replace(/\/?$/, '/') + name + '?t=' + Date.now();

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- prices ----------
async function fetchSkinport() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Skinport requires Brotli for this endpoint; Node decodes it automatically.
      const data = await getJson(SOURCE_URL, { 'Accept-Encoding': 'br' });
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

async function loadPrices() {
  try {
    const data = await fetchSkinport();
    const items = {};
    for (const it of data) {
      if (!it || typeof it.market_hash_name !== 'string') continue;
      items[it.market_hash_name] = [price(it.min_price), price(it.median_price), price(it.suggested_price), Number(it.quantity) || 0];
    }
    const payload = { source: 'Skinport', currency: String(data[0].currency || 'USD'), fetchedAt: new Date().toISOString(), count: Object.keys(items).length, items };
    console.log(`Saved ${payload.count} prices from Skinport.`);
    return payload;
  } catch (e) {
    console.log(`::warning::Couldn't reach Skinport (${e.message}). Keeping the last published prices.`);
    if (!SITE_URL) return null;
    try {
      const payload = await getJson(siteFile('prices.json'));
      console.log(`Kept the prices saved at ${payload.fetchedAt}.`);
      return payload;
    } catch (e2) {
      console.log(`No earlier prices to keep (${e2.message}). The app will show sample prices until the next run.`);
      return null;
    }
  }
}

// ---------- full skin list ----------
const RARITY_IDS = {
  rarity_common_weapon: 0, rarity_uncommon_weapon: 1, rarity_rare_weapon: 2,
  rarity_mythical_weapon: 3, rarity_legendary_weapon: 4, rarity_ancient_weapon: 5,
};
function rarityOf(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.id in RARITY_IDS) return RARITY_IDS[r.id];
  const n = String(r.name || '').toLowerCase();
  if (n.startsWith('consumer')) return 0;
  if (n.startsWith('industrial')) return 1;
  if (n.startsWith('mil-spec') || n.startsWith('mil spec')) return 2;
  if (n.startsWith('restricted')) return 3;
  if (n.startsWith('classified')) return 4;
  if (n.startsWith('covert')) return 5;
  return null;
}
const slug = (s) => String(s).toLowerCase().replace(/♥/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Keeps the ids the app used before the full list existed.
const COMPAT_IDS = { 'dreams-nightmares': 'dreams' };
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : d);
const r4 = (v) => Math.round(v * 10000) / 10000;
// "★ Karambit | Doppler (Phase 2)" → "★ Karambit | Doppler": phases come from the pattern, not the item.
const baseName = (n) => String(n).trim().replace(/\s*\((?:Phase \d|Ruby|Sapphire|Black Pearl|Emerald)\)$/i, '');
const isGloveName = (name, cat) => /\b(gloves?|hand wraps)\b/i.test(name) || /glove/i.test(String(cat || ''));

export function buildItemsDb(skins, crates) {
  if (!Array.isArray(skins) || !skins.length) throw new Error('the skin list is empty');
  const specialsByName = new Map();
  const colByKey = new Map();
  const cols = [];
  const usedIds = new Set();
  const crateNames = new Map();
  const crateKey = (c) => String(c.id || c.name);
  const colRecord = (c) => {
    const key = String(c.id || c.name);
    let rec = colByKey.get(key);
    if (rec) return rec;
    const name = String(c.name || c.id).trim();
    let id = slug(name.replace(/^the\s+/i, '').replace(/\s+collection$/i, '')) || 'collection';
    id = COMPAT_IDS[id] || id;
    let uniq = id;
    for (let n = 2; usedIds.has(uniq); n++) uniq = id + '-' + n;
    usedIds.add(uniq);
    rec = { id: uniq, name, crates: new Set(), rows: new Map() };
    colByKey.set(key, rec);
    cols.push(rec);
    return rec;
  };
  for (const sk of skins) {
    if (!sk || typeof sk.name !== 'string') continue;
    const name = baseName(sk.name);
    if (name.startsWith('★')) {
      if (!specialsByName.has(name)) specialsByName.set(name, sk);
      continue;
    }
    const r = rarityOf(sk.rarity);
    if (r == null || !name.includes(' | ')) continue;
    const owners = Array.isArray(sk.collections) ? sk.collections.filter((c) => c && (c.id || c.name)) : [];
    if (!owners.length) continue;
    let min = num(sk.min_float, 0);
    let max = num(sk.max_float, 1);
    if (max < min) [min, max] = [max, min];
    const flags = (sk.stattrak ? 1 : 0) | (sk.souvenir ? 2 : 0);
    for (const c of owners) {
      const rec = colRecord(c);
      if (!rec.rows.has(name)) rec.rows.set(name, [r, name, r4(min), r4(max), flags]);
      for (const cr of Array.isArray(sk.crates) ? sk.crates : []) {
        if (!cr || !(cr.id || cr.name)) continue;
        rec.crates.add(crateKey(cr));
        if (cr.name) crateNames.set(crateKey(cr), String(cr.name));
      }
    }
  }
  // Which knives and gloves each case can give.
  const rareByKey = new Map();
  const rareByName = new Map();
  const caseKeys = new Set();
  for (const cr of Array.isArray(crates) ? crates : []) {
    if (!cr || !(cr.id || cr.name)) continue;
    const key = crateKey(cr);
    if (cr.name) crateNames.set(key, String(cr.name));
    if (/^case$/i.test(String(cr.type || ''))) caseKeys.add(key);
    const names = [...new Set((Array.isArray(cr.contains_rare) ? cr.contains_rare : []).map((x) => (x && typeof x.name === 'string' ? baseName(x.name) : null)).filter(Boolean))];
    if (!names.length) continue;
    rareByKey.set(key, names);
    if (cr.name) rareByName.set(String(cr.name), names);
  }
  if (!rareByKey.size) {
    // No case list: knives and gloves name the cases they come from.
    for (const [name, sk] of specialsByName) {
      for (const cr of Array.isArray(sk.crates) ? sk.crates : []) {
        if (!cr || !(cr.id || cr.name)) continue;
        const key = crateKey(cr);
        if (!rareByKey.has(key)) rareByKey.set(key, []);
        rareByKey.get(key).push(name);
        if (cr.name) {
          crateNames.set(key, String(cr.name));
          rareByName.set(String(cr.name), rareByKey.get(key));
        }
      }
    }
  }
  const specials = [];
  const specialIdx = new Map();
  const specialIndex = (name) => {
    if (specialIdx.has(name)) return specialIdx.get(name);
    const sk = specialsByName.get(name) || {};
    const glove = isGloveName(name, sk.category && sk.category.name);
    const bare = name.replace(/^★\s*/, '');
    const vanilla = !bare.includes(' | ') || /^skin-vanilla-/.test(String(sk.id || ''));
    let min = num(sk.min_float, glove ? 0.06 : 0);
    let max = num(sk.max_float, glove ? 0.8 : 1);
    if (max < min) [min, max] = [max, min];
    const flags = (glove ? 4 : 0) | (vanilla ? 8 : 0) | (!glove && sk.stattrak !== false ? 1 : 0);
    specialIdx.set(name, specials.length);
    specials.push(vanilla && !glove ? [name, 0, 0, flags] : [name, r4(min), r4(max), flags]);
    return specialIdx.get(name);
  };
  const pools = [];
  const poolByKey = new Map();
  const poolFor = (names, label) => {
    const list = [...new Set(names)].sort();
    const key = list.join('\n');
    let p = poolByKey.get(key);
    if (!p) {
      const base = slug(label) || 'pool';
      let id = base;
      for (let n = 2; pools.some((x) => x.id === id); n++) id = base + '-' + n;
      p = { id, labels: [], idx: list.map(specialIndex) };
      poolByKey.set(key, p);
      pools.push(p);
    }
    if (!p.labels.includes(label)) p.labels.push(label);
    return p;
  };
  const out = [];
  for (const rec of cols) {
    if (!rec.rows.size) continue;
    const names = [];
    const labels = [];
    for (const key of rec.crates) {
      const list = rareByKey.get(key) || rareByName.get(crateNames.get(key));
      if (!list || !list.length) continue;
      names.push(...list);
      labels.push(crateNames.get(key) || key);
    }
    const gold = names.length ? poolFor(names, labels.join(' · ')).id : null;
    const caseNames = [...new Set([...rec.crates].filter((k) => caseKeys.has(k) || /case$/i.test(crateNames.get(k) || '')).map((k) => crateNames.get(k)).filter(Boolean))];
    const display = caseNames.length === 1 ? caseNames[0] : rec.name;
    out.push({ rec, row: [rec.id, display, caseNames.length || gold ? 'case' : 'collection', gold, display !== rec.name ? rec.name : null] });
  }
  const skinRows = [];
  out.forEach(({ rec }, ci) => {
    for (const [r, name, min, max, flags] of rec.rows.values()) skinRows.push([ci, r, name, min, max, flags]);
  });
  if (out.length < 20 || skinRows.length < 300) throw new Error(`the skin list looks incomplete (${out.length} collections, ${skinRows.length} skins)`);
  return {
    v: 1,
    source: 'ByMykel CSGO-API',
    fetchedAt: new Date().toISOString(),
    collections: out.map((x) => x.row),
    pools: pools.map((p) => [p.id, p.labels.join(' · '), p.idx]),
    skins: skinRows,
    specials,
  };
}

async function loadItems() {
  let prev = null;
  if (SITE_URL) {
    try {
      prev = await getJson(siteFile('items.json'));
      if (!prev || prev.v !== 1 || !Array.isArray(prev.skins)) prev = null;
    } catch (e) {
      prev = null;
    }
  }
  const age = prev && Date.parse(prev.fetchedAt) ? (Date.now() - Date.parse(prev.fetchedAt)) / 3.6e6 : Infinity;
  if (prev && age < ITEMS_MAX_AGE_HOURS && !process.env.FORCE_ITEMS) {
    console.log(`Kept the skin list from ${prev.fetchedAt} (${prev.skins.length} skins). It refreshes once a day.`);
    return prev;
  }
  for (const base of DB_SOURCES) {
    try {
      const skins = await getJson(base + 'skins.json');
      let crates = null;
      try {
        crates = await getJson(base + 'crates.json');
      } catch (e) {
        console.log(`Couldn't get the case list (${e.message}); using the knife list instead.`);
      }
      const db = buildItemsDb(skins, crates);
      console.log(`Built the full skin list: ${db.skins.length} skins, ${db.specials.length} knives and gloves, ${db.collections.length} collections.`);
      return db;
    } catch (e) {
      console.log(`Couldn't build the skin list from ${base} (${e.message}).`);
    }
  }
  if (prev) {
    console.log('::warning::Kept the previous skin list.');
    return prev;
  }
  console.log('::warning::No skin list yet. The app uses its built-in collections until the next run.');
  return null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await copyFile('index.html', `${OUT}/index.html`);
  const [prices, items] = await Promise.all([loadPrices(), loadItems()]);
  if (prices) await writeFile(`${OUT}/prices.json`, JSON.stringify(prices));
  if (items) await writeFile(`${OUT}/items.json`, JSON.stringify(items));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
