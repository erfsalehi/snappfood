'use strict';

const { fetch: uFetch, ProxyAgent } = require('undici');

const TARGET = 'https://snappfood.ir/search/api/v4/food-party'
  + '?lat=35.715&long=51.404&deal_project_list_id=34&page=0&page_size=1'
  + '&optionalClient=PWA&client=PWA&deviceType=PWA&appVersion=6.0.0'
  + '&UDID=7b24bd12-66d8-4015-b90c-fd0ab7a18e22&Bonyan=true';

async function fetchCandidates() {
  const list = new Set([
    'http://195.181.40.34:8080',
    'http://185.109.244.69:8080',
    'http://31.47.38.2:80',
    'http://80.191.46.62:1090',
    'http://109.230.83.178:5060',
    'http://178.252.171.226:8080',
    'http://217.219.83.186:2222',
  ]);

  try {
    const res = await uFetch('https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IR/data.txt', { signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('http://')) list.add(trimmed);
      else if (!trimmed.includes('://') && trimmed.includes(':')) list.add('http://' + trimmed);
    }
  } catch (e) {
    console.error('Proxifly fetch error:', e.message);
  }

  try {
    const res = await uFetch('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=IR&ssl=all&anonymity=all', { signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes(':')) list.add('http://' + trimmed);
    }
  } catch (e) {
    console.error('Proxyscrape fetch error:', e.message);
  }

  try {
    const res = await uFetch('https://proxylist.geonode.com/api/proxy-list?country=IR&protocols=http%2Chttps&limit=50&page=1&sort_by=lastChecked&sort_type=desc', { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    for (const item of (data.data || [])) {
      list.add('http://' + item.ip + ':' + item.port);
    }
  } catch (e) {
    console.error('GeoNode fetch error:', e.message);
  }

  return Array.from(list);
}

async function testProxy(uri, timeoutMs = 6000) {
  const start = Date.now();
  const dispatcher = new ProxyAgent({ uri, connectTimeout: timeoutMs, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  try {
    const res = await uFetch(TARGET, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && (json.success === true || json.data)) {
      return {
        proxy: uri,
        ms: Date.now() - start,
        title: json.data?.title || 'OK',
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    dispatcher.close().catch(() => {});
  }
}

async function main() {
  console.log('Fetching candidate Iranian proxies...');
  const candidates = await fetchCandidates();
  console.log(`Gathered ${candidates.length} unique candidates. Testing...`);

  const working = [];
  const CONCURRENCY = 15;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((p) => testProxy(p, 6000)));
    for (const r of results) {
      if (r) {
        console.log(`[WORKING] ${r.proxy} (${r.ms}ms) - ${r.title}`);
        working.push(r);
      }
    }
    if (working.length >= 6) {
      console.log('Found enough working proxies.');
      break;
    }
  }

  working.sort((a, b) => a.ms - b.ms);
  console.log('\n--- RESULTS ---');
  console.log(`Found ${working.length} working proxies.`);
  for (const w of working) {
    console.log(`  ${w.proxy} (${w.ms}ms)`);
  }

  if (working.length > 0) {
    const envValue = working.map((w) => w.proxy).join(',');
    console.log('\nReady-to-use SNAPPFOOD_PROXIES:\n' + envValue);
  }
}

main().catch(console.error);
