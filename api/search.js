'use strict';
const { searchSnappfood } = require('../lib/snappfood');

module.exports = async function handler(req, res) {
  const { lat = '35.715', long = '51.404', q, query, page = '0', pageSize = '40' } = req.query || {};
  const searchQuery = q || query || '';
  try {
    const data = await searchSnappfood({
      lat,
      long,
      query: searchQuery,
      page: Number(page) || 0,
      pageSize: Number(pageSize) || 40,
    });
    data.build = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);
    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message, unreachable: Boolean(err.unreachable) });
  }
};
