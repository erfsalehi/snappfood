'use strict';
// Diagnostic: which Iranian proxies can actually reach Snappfood from here?
//
// Free proxies die constantly, so this is the tool for refreshing the list.
// Paste candidates from a source like proxy5.net/free-proxy/iran:
//
//   /api/proxytest?list=1.2.3.4:8080,5.6.7.8:3128
//
// Then put whatever comes back under "working" into the SNAPPFOOD_PROXIES
// environment variable. With no ?list, it tests the currently configured set.

const { fetch: uFetch, ProxyAgent } = require('undici');

const TARGET = 'https://snappfood.ir/search/api/v4/food-party'
  + '?lat=35.715&long=51.404&deal_project_list_id=34&page=0&page_size=1'
  + '&optionalClient=PWA&client=PWA&deviceType=PWA&appVersion=6.0.0'
  + '&UDID=7b24bd12-66d8-4015-b90c-fd0ab7a18e22&Bonyan=true';

function normalizeUri(s) {
  const trimmed = s.trim();
  if (!trimmed) return null;
  return /^\w+:\/\//.test(trimmed) ? trimmed : 'http://' + trimmed;
}

async function tryProxy(uri) {
  const started = Date.now();
  const dispatcher = new ProxyAgent({ uri, connectTimeout: 8000, headersTimeout: 15000, bodyTimeout: 15000 });
  try {
    const res = await uFetch(TARGET, {
      dispatcher,
      signal: AbortSignal.timeout(9000),
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    const text = await res.text();
    let isOk = false;
    let total = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && (parsed.success === true || parsed.data)) {
        isOk = Boolean(
          typeof parsed.data?.title === 'string' ||
          Array.isArray(parsed.data?.products) ||
          typeof parsed.data?.total_count === 'number'
        );
        total = parsed.data?.total_count ?? (parsed.data?.products?.length || 0);
      }
    } catch (e) { /* proxy returned something that is not JSON */ }
    return {
      proxy: uri,
      ok: isOk,
      status: res.status,
      total,
      ms: Date.now() - started,
      // Shown only on failure, to distinguish a dead proxy from a hijacking one.
      sample: isOk ? undefined : text.slice(0, 80),
    };
  } catch (err) {
    return { proxy: uri, ok: false, error: err.code || err.message, ms: Date.now() - started };
  } finally {
    dispatcher.close().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  const raw = (req.query && req.query.list) || process.env.SNAPPFOOD_PROXIES || '';
  const uris = raw.split(',').map(normalizeUri).filter(Boolean);

  if (uris.length === 0) {
    res.status(400).json({
      error: 'No proxies to test.',
      usage: '/api/proxytest?list=ip:port,ip:port',
    });
    return;
  }

  const results = await Promise.all(uris.map(tryProxy));
  const working = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);

  res.setHeader('cache-control', 'no-store');
  res.status(200).json({
    tested: uris.length,
    working,
    failed: results.filter((r) => !r.ok),
    // Ready to paste straight into the environment variable.
    SNAPPFOOD_PROXIES: working.map((r) => r.proxy).join(','),
  });
};
