'use strict';
// Vercel serverless function. Mirrors the /api/deals route of the local dev
// server in server.js; both call into lib/snappfood.js.

const { fetchAllDeals } = require('../lib/snappfood');

module.exports = async function handler(req, res) {
  const { lat = '35.715', long = '51.404', deep } = req.query || {};
  try {
    const data = await fetchAllDeals({ lat, long, deep: deep === '1' });
    // Deals rotate through the day; a short shared cache keeps the upstream
    // request count sane without showing anyone a stale list.
    res.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
