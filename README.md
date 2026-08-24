# Snappfood discount browser

Snappfood lists discounted items in carousels with no sorting. This fetches
every discount section for a location, merges them into one table, and lets you
sort on any column.

## Run

```
node server.js
```

Then open http://localhost:5173

No dependencies, no build step, no account needed — Snappfood's discount API is
public and only needs a location.

## Setting your location

Deals are location-scoped, and the difference is large - central Tehran returns
~428 items, Isfahan ~298, Mashhad ~122, Shiraz ~59, with entirely different
vendors. Three ways to set it, in the top-left of the toolbar:

- **شهر** - pick from 15 city presets. Reloads immediately.
- **موقعیت من** - uses the browser's geolocation for your actual neighbourhood.
  This is the accurate option: Snappfood filters by delivery radius, so a city
  centre still misses vendors that would deliver to you.
- **عرض / طول** - type coordinates directly; the city dropdown switches to
  «دلخواه» when they don't match a preset.

Whichever you use, the coordinates are remembered in localStorage.

To find coordinates by hand: open your address on Google Maps and read them out
of the URL, or open snappfood.ir with your address selected and look at the
`lat` / `long` query parameters on any request in DevTools → Network.

## Columns you can sort by

Click any header to sort; click again to reverse. Numeric columns start
high-to-low, text columns start alphabetically.

name · restaurant · section · rating · original price · discounted price ·
discount % · saving · delivery fee · **total payable** · minimum order · stock

`total payable` is discounted price + delivery fee, which is the number that
actually decides whether a deal is good. It is not shown anywhere on Snappfood.

## Filters

Free-text search over name and restaurant, section, minimum rating, minimum
discount %, maximum total payable, free-delivery-only, in-stock-only.

«دانلود CSV» exports whatever is currently filtered and sorted (UTF-8 BOM, so
Excel opens Persian text correctly).

## How it works

- `GET /search/api/v4/food-party?lat&long&deal_project_list_id&page&page_size`
  is the endpoint behind every discount carousel.
- Section ids are not published. `KNOWN_SECTION_IDS` in `server.js` holds the
  ones that existed at the time of writing; ticking «جست‌وجوی کامل بخش‌ها»
  probes ids 1–80 instead, which finds sections added since (slower).
- `page_size` is capped at 200 server-side, so larger sections are paged.
- The same product appears in several sections. Items are deduplicated by
  `productVariationId` and every section it belongs to is kept.
- `rating` comes back on a 0–10 scale and is halved to match the 0–5 stars the
  site displays.
- The field the API calls `discount` is the *post-discount price*, not the
  amount off. `price` is the original.
- The browser cannot call snappfood.ir directly (CORS), which is why the Node
  process proxies.

## Caveats

- Deals are live and rotate through the day; two refreshes minutes apart will
  differ.
- Stock counts are per vendor daily deal and can go stale within minutes.

## Hosting outside Iran

Snappfood only answers requests originating in Iran, and its API sends no CORS
headers - so a foreign host cannot fetch it server-side (`fetch failed`, no
HTTP response), and the visitor's browser cannot fetch it directly either
(blocked by CORS). Traffic has to physically originate from an Iranian IP.

Running `node server.js` on an Iranian connection needs nothing further; it
connects directly.

Anywhere else, requests are tunnelled through an Iranian HTTP proxy.
`lib/snappfood.js` tries a direct connection first and only falls back to the
proxy pool if that fails, so the same code covers both cases. The chosen
connection is reported as `via: "direct" | "proxy"` in the API response.

### Refreshing the proxies

Free public proxies die within hours or days. When the site starts returning
`{"unreachable": true}`, get fresh candidates from a list such as
proxy5.net/free-proxy/iran (filter to Iran, HTTP/HTTPS) and test them:

    /api/proxytest?list=1.2.3.4:8080,5.6.7.8:3128

The response separates `working` from `failed` and hands back a ready-to-paste
`SNAPPFOOD_PROXIES` value. Set that as an environment variable on the project
and redeploy. Expect roughly one in four candidates to work.

Two things the test guards against: proxies that simply time out, and proxies
that hijack the request and answer 200 with their own page. Only a response
that parses as Snappfood's JSON counts as working.

### Cost of the proxy path

A cold fetch through a proxy takes ~20-25s, against ~1.3s direct. The function
is allowed 60s and the response is cached at the edge for 5 minutes, so only
the first visitor in each window pays it - cached responses return in ~150ms.

To keep it inside the limit, each section is fetched in a single request
(page 0 carries `total_count` and the title, so no separate discovery round
trip) - about 11 upstream requests per refresh rather than 30.

### Trusting a proxy

The proxy operator can see these requests and could serve fabricated
responses. Nothing sensitive passes through - no login, no account data, only
public discount listings - but prices shown via an untrusted proxy are worth a
sanity check against the Snappfood app before ordering. Running locally from
an Iranian connection avoids the question entirely.
