'use strict';
// Data layer for Snappfood's public discount API. Shared by the local dev
// server (server.js) and the Vercel serverless function (api/deals.js).
//
// Snappfood only answers requests from inside Iran. Run this from an Iranian
// connection and no proxy is involved; run it from anywhere else and every
// request has to be tunnelled through an Iranian proxy (see DEFAULT_PROXIES).

const { fetch: uFetch, ProxyAgent } = require('undici');

const API = 'https://snappfood.ir/search/api/v4/food-party';
const COMMON = {
  optionalClient: 'PWA',
  client: 'PWA',
  deviceType: 'PWA',
  appVersion: '6.0.0',
  UDID: '7b24bd12-66d8-4015-b90c-fd0ab7a18e22',
  Bonyan: 'true',
};

// Section ids are not published anywhere. These are the ones that existed at
// the time of writing; `deep` probes a wider range to find newer ones.
const KNOWN_SECTION_IDS = [7, 28, 29, 30, 33, 34, 46, 49, 56, 57];
const PROBE_MAX = 80;
const PAGE_SIZE = 200; // Snappfood caps page_size at 200 whatever you ask for.

// Iranian proxies, used only when a direct connection fails. Free public
// proxies churn within hours, so this list goes stale - override it without a
// code change by setting SNAPPFOOD_PROXIES to a comma-separated list.
const DEFAULT_PROXIES = [
  'http://185.4.29.243:7887',
  'http://5.200.72.62:3128',
];

function proxyList() {
  const fromEnv = (process.env.SNAPPFOOD_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_PROXIES;
}

function apiUrl(params) {
  return API + '?' + new URLSearchParams({ ...COMMON, ...params }).toString();
}

// ---- connection selection --------------------------------------------------

// null means "connect directly". Cached in module scope so warm serverless
// invocations skip re-selection.
let cachedDispatcher;

function makeProxy(uri) {
  return new ProxyAgent({ uri, connectTimeout: 8000, headersTimeout: 15000, bodyTimeout: 15000 });
}

async function canReach(dispatcher) {
  try {
    const url = apiUrl({
      lat: '35.715', long: '51.404',
      deal_project_list_id: '34', page: '0', page_size: '1',
    });
    const res = await uFetch(url, {
      dispatcher: dispatcher || undefined,
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return false;
    // A hijacking proxy answers 200 with its own page, so require real JSON.
    const j = await res.json();
    return typeof j?.data?.total_count === 'number';
  } catch {
    return false;
  }
}

async function selectDispatcher() {
  if (cachedDispatcher !== undefined) return cachedDispatcher;

  // Direct first: instant from an Iranian connection, and it avoids handing
  // the traffic to a third party.
  if (await canReach(undefined)) {
    cachedDispatcher = null;
    return cachedDispatcher;
  }

  const candidates = proxyList().map(makeProxy);
  try {
    // First proxy to return real JSON wins.
    cachedDispatcher = await Promise.any(
      candidates.map(async (d) => {
        if (await canReach(d)) return d;
        throw new Error('unusable');
      })
    );
  } catch {
    for (const d of candidates) d.close().catch(() => {});
    const err = new Error(
      'Snappfood is unreachable: no direct connection, and none of the '
      + candidates.length + ' configured proxies worked'
    );
    err.unreachable = true;
    throw err;
  }

  for (const d of candidates) if (d !== cachedDispatcher) d.close().catch(() => {});
  return cachedDispatcher;
}

async function getJson(url) {
  const dispatcher = await selectDispatcher();
  const res = await uFetch(url, {
    dispatcher: dispatcher || undefined,
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

// ---- concurrency -----------------------------------------------------------

// Runs `worker` over `items` with at most `limit` in flight. Failures are
// collected rather than thrown, so one dead section cannot sink the request -
// but they are reported, so a total failure is never mistaken for "no deals".
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  const errors = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          results[i] = await worker(items[i]);
        } catch (err) {
          results[i] = null;
          errors.push(err.message);
        }
      }
    })
  );
  results.errors = errors;
  return results;
}

// ---- fetching --------------------------------------------------------------

function normalize(raw, sectionTitle) {
  const price = Number(raw.price) || 0;
  const finalPrice = Number(raw.discount) || 0; // API calls the post-discount price "discount"
  const deliveryFee = Number(raw.deliveryFee) || 0;
  const deliveryDiscounted = Boolean(raw.isDeliveryFeeHasDiscount);
  const deliveryNow = deliveryDiscounted ? Number(raw.deliveryFeeAfterDiscount) || 0 : deliveryFee;
  return {
    id: raw.productVariationId,
    name: raw.productVariationTitle || '',
    description: raw.description || '',
    vendor: raw.vendorTitle || '',
    vendorCode: raw.vendorCode || '',
    vendorType: raw.vendorTypeTitle || '',
    section: sectionTitle,
    price,
    finalPrice,
    saving: price - finalPrice,
    discountRatio: Number(raw.discountRatio) || 0,
    deliveryFee,
    deliveryNow,
    deliveryDiscounted,
    // What you actually pay for one of these, delivered.
    total: finalPrice + deliveryNow,
    rating: (Number(raw.rating) || 0) / 2, // API is 0-10, the site shows 0-5
    votes: Number(raw.vote_count) || 0,
    remaining: Number(raw.remaining) || 0,
    totalStock: Number(raw.total_stock) || 0,
    minOrder: Number(raw.minOrder) || 0,
    image: raw.image || '',
    url: 'https://snappfood.ir/restaurant/menu/-r-' + (raw.vendorCode || '') + '/',
  };
}

// Fetches one section. The first page already carries total_count and the
// title, so no separate discovery request is needed - which matters when each
// round trip costs seconds through a proxy.
async function fetchSection(lat, long, id) {
  const first = await getJson(apiUrl({
    lat, long, deal_project_list_id: String(id), page: '0', page_size: String(PAGE_SIZE),
  }));
  const total = first && first.data ? first.data.total_count || 0 : 0;
  if (total === 0) return null;

  const products = first.data.products || [];
  for (let page = 1; page * PAGE_SIZE < total; page++) {
    const next = await getJson(apiUrl({
      lat, long, deal_project_list_id: String(id), page: String(page), page_size: String(PAGE_SIZE),
    }));
    const batch = (next && next.data && next.data.products) || [];
    products.push(...batch);
    if (batch.length < PAGE_SIZE) break; // list shrank between calls
  }

  return { id, title: first.data.title || ('list ' + id), total, products };
}

async function fetchAllDeals({ lat, long, deep }) {
  const ids = deep ? Array.from({ length: PROBE_MAX }, (_, i) => i + 1) : KNOWN_SECTION_IDS;
  const fetched = await mapLimit(ids, 6, (id) => fetchSection(lat, long, id));
  const sections = fetched.filter(Boolean);

  // Everything failing means Snappfood is unreachable, which is not the same
  // thing as there being no deals. Say so instead of returning [].
  if (sections.length === 0 && fetched.errors.length > 0) {
    const err = new Error('Snappfood is unreachable from this server: ' + fetched.errors[0]);
    err.unreachable = true;
    throw err;
  }

  // The same product appears in several sections; keep one copy and remember
  // every section it belongs to.
  const byId = new Map();
  for (const section of sections) {
    for (const raw of section.products) {
      const item = normalize(raw, section.title);
      const existing = byId.get(item.id);
      if (existing) {
        if (!existing.sections.includes(item.section)) existing.sections.push(item.section);
      } else {
        item.sections = [item.section];
        byId.set(item.id, item);
      }
    }
  }

  const items = [...byId.values()];
  return {
    fetchedAt: new Date().toISOString(),
    location: { lat, long },
    via: cachedDispatcher ? 'proxy' : 'direct',
    sections: sections.map((s) => ({ id: s.id, title: s.title, total: s.total })),
    count: items.length,
    items,
  };
}

module.exports = { fetchAllDeals };
