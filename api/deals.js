'use strict';
// Vercel serverless function. Mirrors the /api/deals route of the local dev
// server in server.js; both call into lib/snappfood.js.

const { fetchAllDeals } = require('../lib/snappfood');

module.exports = async function handler(req, res) {
  const { lat = '35.715', long = '51.404', deep } = req.query || {};
  try {
    const data = await fetchAllDeals({ lat, long, deep: deep === '1' });
    // Shown in the UI so "am I looking at the current build?" is answerable
    // at a glance rather than by comparing behaviour.
    data.build = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);
    // Stock sells out during the day, so this is deliberately short: two
    // minutes bounds how wrong the remaining counts can be, while still
    // sparing the (slow, flaky) proxy path from every single visitor.
    // stale-while-revalidate keeps the refresh off the critical path.
    res.setHeader('cache-control', 's-maxage=120, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message, unreachable: Boolean(err.unreachable) });
  }
};
