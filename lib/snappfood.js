'use strict';
// Data layer for Snappfood's public discount API. Shared by the local dev
// server (server.js) and the Vercel serverless function (api/deals.js).

const API = 'https://snappfood.ir/search/api/v4/food-party';
const COMMON = {
  optionalClient: 'PWA',
  client: 'PWA',
  deviceType: 'PWA',
  appVersion: '6.0.0',
  UDID: '7b24bd12-66d8-4015-b90c-fd0ab7a18e22',
  Bonyan: 'true',
};

// Section ids are not published anywhere, so they get probed. These are the
// ones that existed when this was written; the probe range covers new ones.
const KNOWN_SECTION_IDS = [7, 28, 29, 30, 33, 34, 46, 49, 56, 57];
const PROBE_MAX = 80;
const PAGE_SIZE = 200; // Snappfood caps page_size at 200 regardless of what is asked for.

function apiUrl(params) {
  return API + '?' + new URLSearchParams({ ...COMMON, ...params }).toString();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

// Runs `worker` over `items` with at most `limit` in flight.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          results[i] = await worker(items[i]);
        } catch {
          results[i] = null;
        }
      }
    })
  );
  return results;
}

async function discoverSections(lat, long, deep) {
  const ids = deep
    ? Array.from({ length: PROBE_MAX }, (_, i) => i + 1)
    : KNOWN_SECTION_IDS;
  const probes = await mapLimit(ids, 10, async (id) => {
    const j = await getJson(apiUrl({ lat, long, deal_project_list_id: String(id), page: '0', page_size: '1' }));
    const total = j?.data?.total_count || 0;
    return total > 0 ? { id, title: j.data.title || ('لیست ' + id), total } : null;
  });
  return probes.filter(Boolean);
}

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

async function fetchAllDeals({ lat, long, deep }) {
  const sections = await discoverSections(lat, long, deep);
  const pages = await mapLimit(sections, 6, async (s) => {
    // page_size is capped server-side at 200, so anything larger has to be paged.
    const products = [];
    for (let page = 0; page * PAGE_SIZE < s.total; page++) {
      const j = await getJson(apiUrl({
        lat, long,
        deal_project_list_id: String(s.id),
        page: String(page),
        page_size: String(PAGE_SIZE),
      }));
      const batch = j?.data?.products || [];
      products.push(...batch);
      if (batch.length < PAGE_SIZE) break; // list shrank between calls
    }
    return { section: s, products };
  });

  // The same product shows up in more than one section; keep the first and
  // remember every section it appeared in.
  const byId = new Map();
  for (const page of pages) {
    if (!page) continue;
    for (const raw of page.products) {
      const item = normalize(raw, page.section.title);
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
    sections: sections.map((s) => ({ id: s.id, title: s.title, total: s.total })),
    count: items.length,
    items,
  };
}

module.exports = { fetchAllDeals };
