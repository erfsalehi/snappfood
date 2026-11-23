'use strict';
// Zero-dependency local server for the Snappfood discount browser.
// Serves ./public and proxies Snappfood's food-party API (the browser cannot
// call snappfood.ir directly because of CORS).

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const { fetchAllDeals, fetchNearbyVendors, searchSnappfood, fetchVendorMenu } = require('./lib/snappfood');
const proxytestHandler = require('./api/proxytest');

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/deals') {
    const lat = url.searchParams.get('lat') || '35.715';
    const long = url.searchParams.get('long') || '51.404';
    const deep = url.searchParams.get('deep') === '1';
    try {
      const started = Date.now();
      const data = await fetchAllDeals({ lat, long, deep });
      console.log(`[deals] ${data.count} items from ${data.sections.length} sections in ${Date.now() - started}ms (lat=${lat} long=${long}${deep ? ' deep' : ''})`);
      sendJson(res, 200, data);
    } catch (err) {
      console.error('[deals] failed:', err.message);
      sendJson(res, 502, { error: err.message, unreachable: Boolean(err.unreachable) });
    }
    return;
  }

  if (url.pathname === '/api/restaurants') {
    const lat = url.searchParams.get('lat') || '35.715';
    const long = url.searchParams.get('long') || '51.404';
    const page = Number(url.searchParams.get('page')) || 0;
    const pageSize = Number(url.searchParams.get('pageSize')) || 30;
    const superTypeAlias = url.searchParams.get('superType') || 'RESTAURANT';
    const category = url.searchParams.get('category') || undefined;
    try {
      const started = Date.now();
      const data = await fetchNearbyVendors({ lat, long, page, pageSize, superTypeAlias, category });
      console.log(`[restaurants] ${data.vendors.length}/${data.count} vendors in ${Date.now() - started}ms (lat=${lat} long=${long})`);
      sendJson(res, 200, data);
    } catch (err) {
      console.error('[restaurants] failed:', err.message);
      sendJson(res, 502, { error: err.message, unreachable: Boolean(err.unreachable) });
    }
    return;
  }

  if (url.pathname === '/api/search') {
    const lat = url.searchParams.get('lat') || '35.715';
    const long = url.searchParams.get('long') || '51.404';
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    const page = Number(url.searchParams.get('page')) || 0;
    const pageSize = Number(url.searchParams.get('pageSize')) || 40;
    try {
      const started = Date.now();
      const data = await searchSnappfood({ lat, long, query, page, pageSize });
      console.log(`[search] "${query}" -> ${data.vendors.length} vendors, ${data.products.length} products in ${Date.now() - started}ms`);
      sendJson(res, 200, data);
    } catch (err) {
      console.error('[search] failed:', err.message);
      sendJson(res, 502, { error: err.message, unreachable: Boolean(err.unreachable) });
    }
    return;
  }

  if (url.pathname === '/api/menu') {
    const vendorCode = url.searchParams.get('code') || url.searchParams.get('vendorCode') || '';
    if (!vendorCode) {
      sendJson(res, 400, { error: 'vendorCode query parameter is required' });
      return;
    }
    try {
      const started = Date.now();
      const data = await fetchVendorMenu({ vendorCode });
      console.log(`[menu] ${vendorCode} -> ${data.categories.length} categories, ${data.totalProducts} products in ${Date.now() - started}ms`);
      sendJson(res, 200, data);
    } catch (err) {
      console.error(`[menu] ${vendorCode} failed:`, err.message);
      sendJson(res, 502, { error: err.message, unreachable: Boolean(err.unreachable) });
    }
    return;
  }

  if (url.pathname === '/api/proxytest') {
    const fakeReq = { query: Object.fromEntries(url.searchParams.entries()) };
    const fakeRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader(k, v) { res.setHeader(k, v); return this; },
      json(body) { sendJson(res, this.statusCode, body); },
    };
    try {
      await proxytestHandler(fakeReq, fakeRes);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Snappfood discount browser: http://localhost:${PORT}`);
});
