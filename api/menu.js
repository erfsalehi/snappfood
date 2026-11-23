'use strict';
const { fetchVendorMenu } = require('../lib/snappfood');

module.exports = async function handler(req, res) {
  const { code, vendorCode } = req.query || {};
  const targetCode = code || vendorCode;
  if (!targetCode) {
    res.status(400).json({ error: 'vendorCode query parameter is required' });
    return;
  }
  try {
    const data = await fetchVendorMenu({ vendorCode: targetCode });
    data.build = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);
    res.setHeader('cache-control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message, unreachable: Boolean(err.unreachable) });
  }
};
