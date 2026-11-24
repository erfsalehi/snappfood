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
  'http://185.109.244.69:8080',
  'http://5.200.72.62:3128',
  'http://78.39.253.48:8080',
  'http://195.181.40.34:8080',
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
let dispatcherPromise;

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
      signal: AbortSignal.timeout(9000),
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return false;
    // A hijacking proxy answers 200 with its own page, so require real JSON.
    const j = await res.json();
    return Boolean(
      j && (j.success === true || j.data) &&
      (typeof j?.data?.title === 'string' || Array.isArray(j?.data?.products) || typeof j?.data?.total_count === 'number')
    );
  } catch {
    return false;
  }
}

async function doSelectDispatcher() {
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

async function selectDispatcher() {
  if (cachedDispatcher !== undefined) return cachedDispatcher;
  if (!dispatcherPromise) {
    dispatcherPromise = doSelectDispatcher().finally(() => {
      dispatcherPromise = null;
    });
  }
  return dispatcherPromise;
}

async function getJson(url) {
  const dispatcher = await selectDispatcher();
  const res = await uFetch(url, {
    dispatcher: dispatcher || undefined,
    signal: AbortSignal.timeout(15000),
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
  // `discount` is the amount taken off, not the resulting price: it always
  // equals price * discountRatio / 100. Confirmed against 278 items whose
  // ratio is not 50% - at exactly 50% the two readings are the same number,
  // which is what made this easy to get backwards.
  const saving = Number(raw.discount) || 0;
  const finalPrice = price - saving;
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
    saving,
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
  const total = first && first.data ? (first.data.total_count ?? (first.data.products?.length || 0)) : 0;
  if (total === 0) return null;

  const products = (first && first.data && first.data.products) || [];
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

function normalizeVendor(raw) {
  const deliveryFee = Number(raw.deliveryFee) || 0;
  const deliveryFeeAfterDiscount = Number(raw.deliveryFeeAfterDiscount) || 0;
  const isDeliveryFeeHasDiscount = Boolean(raw.isDeliveryFeeHasDiscount);
  const deliveryNow = isDeliveryFeeHasDiscount ? deliveryFeeAfterDiscount : deliveryFee;
  const rawRate = Number(raw.rate) || (Number(raw.rating) ? Number(raw.rating) / 2 : 0);
  const rate = Math.round(rawRate * 10) / 10;

  let cuisines = [];
  if (Array.isArray(raw.cuisinesArray)) {
    cuisines = raw.cuisinesArray.map((c) => (typeof c === 'string' ? c : c.title)).filter(Boolean);
  } else if (typeof raw.description === 'string' && raw.description.includes(',')) {
    cuisines = raw.description.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const code = raw.vendorCode || raw.code || '';
  return {
    id: raw.id,
    code,
    title: raw.title || '',
    description: raw.description || '',
    rate,
    voteCount: Number(raw.voteCount || raw.commentCount) || 0,
    isOpen: Boolean(raw.isOpen ?? raw.is_open),
    logo: raw.logo || raw.featured || raw.defLogo || '',
    cover: raw.backgroundImageCustom || raw.backgroundImage || raw.coverPath || '',
    deliveryFee,
    deliveryNow,
    deliveryFeeDiscounted: isDeliveryFeeHasDiscount,
    deliveryTime: Number(raw.deliveryTime || raw.eta || raw.total_time) || 0,
    minOrder: Number(raw.minOrder) || 0,
    address: raw.address || '',
    cuisines,
    hasCoupon: Boolean(raw.has_coupon),
    bestCoupon: raw.best_coupon || '',
    discountValue: Number(raw.discountValue) || 0,
    isExpress: Boolean(raw.isZFExpress || raw.is_express),
    url: 'https://snappfood.ir/restaurant/menu/-r-' + code + '/',
  };
}

async function fetchNearbyVendors({ lat, long, page = 0, pageSize = 30, superTypeAlias = 'RESTAURANT', category }) {
  const params = {
    ...COMMON,
    lat: String(lat),
    long: String(long),
    page: String(page),
    page_size: String(pageSize),
  };
  if (superTypeAlias && superTypeAlias !== 'ALL') {
    params.superTypeAlias = superTypeAlias;
  }
  if (category) {
    params.category = category;
  }
  const url = 'https://snappfood.ir/mobile/v3/restaurant/vendors-list?' + new URLSearchParams(params).toString();
  const data = await getJson(url);

  const finalResult = data?.data?.finalResult || [];
  const vendors = finalResult
    .filter((item) => item.type === 'VENDOR' && item.data)
    .map((item) => normalizeVendor(item.data));

  return {
    fetchedAt: new Date().toISOString(),
    location: { lat, long },
    via: cachedDispatcher ? 'proxy' : 'direct',
    count: Number(data?.data?.count) || vendors.length,
    openCount: Number(data?.data?.open_count) || 0,
    page: Number(page),
    pageSize: Number(pageSize),
    vendors,
  };
}

async function searchSnappfood({ lat, long, query, page = 0, pageSize = 40 }) {
  if (!query || !query.trim()) {
    return {
      fetchedAt: new Date().toISOString(),
      location: { lat, long },
      via: cachedDispatcher ? 'proxy' : 'direct',
      query: '',
      vendorTotal: 0,
      productTotal: 0,
      vendors: [],
      products: [],
    };
  }
  const params = {
    ...COMMON,
    lat: String(lat),
    long: String(long),
    query: query.trim(),
    page: String(page),
    page_size: String(pageSize),
  };
  const url = 'https://snappfood.ir/search/api/v1/desktop/search?' + new URLSearchParams(params).toString();
  const res = await getJson(url);
  const data = res?.data || {};

  const rawVendors = data?.vendor?.items || [];
  const vendors = rawVendors.map(normalizeVendor);

  const rawProducts = data?.product_variation?.items || [];
  const products = rawProducts.map((p) => {
    const price = Number(p.price) || 0;
    const d = p.discount;
    let saving = 0;
    let discountRatio = Number(p.discountRatio) || 0;
    if (d && typeof d === 'object') {
      saving = Number(d.amount ?? d.value ?? d.discount) || 0;
      if (!discountRatio) discountRatio = Number(d.ratio ?? d.discountRatio) || 0;
    } else if (typeof d === 'number' || (typeof d === 'string' && d.trim() !== '')) {
      saving = Number(d) || 0;
    }
    if (!discountRatio && price > 0 && saving > 0) {
      discountRatio = Math.round((saving / price) * 100);
    }
    const finalPrice = saving > 0 && saving < price ? price - saving : price;
    const rawVendorRate = Number(p.vendor?.rating) ? Number(p.vendor.rating) / 2 : 0;
    const vendorRate = Math.round(rawVendorRate * 10) / 10;
    const productRate = Number(p.rating) ? Math.round(Number(p.rating) * 5 * 10) / 10 : 0;

    return {
      id: p.id,
      title: p.title || '',
      description: p.description || '',
      price,
      finalPrice,
      saving,
      discountRatio,
      image: p.image || (p.images && p.images[0]?.src) || '',
      rate: productRate,
      vendor: p.vendor
        ? {
            id: p.vendor.id,
            code: p.vendor.code || '',
            title: p.vendor.title || '',
            address: p.vendor.address || '',
            rate: vendorRate,
            deliveryFee: Number(p.vendor.deliveryFee) || 0,
            isOpen: Boolean(p.vendor.is_open),
            logo: p.vendor.featured || p.vendor.logo || '',
            url: 'https://snappfood.ir/restaurant/menu/-r-' + (p.vendor.code || '') + '/',
          }
        : null,
    };
  });

  return {
    fetchedAt: new Date().toISOString(),
    location: { lat, long },
    via: cachedDispatcher ? 'proxy' : 'direct',
    query: query.trim(),
    vendorTotal: Number(data?.vendor?.total) || vendors.length,
    productTotal: Number(data?.product_variation?.total) || products.length,
    vendors,
    products,
  };
}

async function fetchVendorMenu({ vendorCode }) {
  if (!vendorCode) throw new Error('vendorCode is required');
  const cleanCode = String(vendorCode).trim().replace(/^-r-/, '').replace(/\/$/, '');
  const url = `https://apigw.snappfood.ir/menu-read-model/${encodeURIComponent(cleanCode)}`;
  const res = await getJson(url);
  const menuCategories = res?.data?.menuCategories || [];

  const categories = menuCategories
    .map((cat) => {
      const rawProducts = cat.products || [];
      const products = rawProducts.map((p) => {
        const v = (p.variations && p.variations.find((x) => x.discount && (x.discount.amount || x.discount.ratio)))
          || (p.variations && p.variations[0])
          || {};
        const price = Number(v.price) || 0;

        let saving = 0;
        let discountRatio = 0;
        const d = v.discount || p.discount || v.discountPro;
        if (d && typeof d === 'object') {
          saving = Number(d.amount ?? d.value ?? d.discount) || 0;
          discountRatio = Number(d.ratio ?? d.discountRatio ?? d.percent) || 0;
        } else if (typeof d === 'number' || (typeof d === 'string' && d.trim() !== '')) {
          saving = Number(d) || 0;
        }

        if (!discountRatio) {
          discountRatio = Number(v.discountRatio ?? p.discountRatio) || 0;
        }
        if (!discountRatio && price > 0 && saving > 0) {
          discountRatio = Math.round((saving / price) * 100);
        }
        if (!saving && price > 0 && discountRatio > 0) {
          saving = Math.round((price * discountRatio) / 100);
        }

        const finalPrice = saving > 0 && saving < price ? price - saving : price;
        const image = (p.images && p.images[0]?.src) || (v.images && v.images[0]?.src) || '';
        const rawRate = Number(p.rate || v.rate) || 0;
        const rate = rawRate > 5 ? Math.round((rawRate / 2) * 10) / 10 : Math.round(rawRate * 10) / 10;

        return {
          id: v.id || p.id,
          title: p.title || v.title || '',
          description: p.description || v.description || '',
          price,
          finalPrice,
          saving,
          discountRatio,
          image,
          rate,
          active: Boolean(v.active ?? true),
          disabledUntil: Boolean(v.disabledUntil),
        };
      });
      return {
        id: cat.id || cat.title,
        title: cat.title || '',
        products,
      };
    })
    .filter((c) => c.products.length > 0);

  return {
    fetchedAt: new Date().toISOString(),
    via: cachedDispatcher ? 'proxy' : 'direct',
    vendorCode: cleanCode,
    categories,
    totalProducts: categories.reduce((sum, c) => sum + c.products.length, 0),
  };
}

module.exports = {
  fetchAllDeals,
  fetchNearbyVendors,
  searchSnappfood,
  fetchVendorMenu,
};
