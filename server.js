/**
 * Catalog Shuffler — proxy addon for Nuvio/Stremio (Node.js / Render version)
 *
 * Aggregates the catalogs from your other addons into one addon,
 * and serves them in a RANDOM order every time the manifest is fetched.
 * Catalog requests are proxied straight through to the original addon.
 *
 * Zero dependencies — runs on Node 18+ with `node server.js`.
 */

// 1) Manifest URLs of the addons whose catalogs you want aggregated:
const UPSTREAM_MANIFESTS = [
  "https://bingecat.com/stremio/fc240269-f369-43c4-ae76-1e95bfc480ee/nuvio/manifest.json?bcv=78",
  "https://aiometadata.viren070.me/stremio/5ec91dc1-27ba-4165-8d77-c42d9b77cd35/manifest.json",
];

const ADDON_ID = "org.chase.catalog-shuffler";
const ADDON_NAME = "Catalog Shuffler";
const UPSTREAM_TTL_MS = 60 * 60 * 1000; // re-fetch upstream manifests hourly
const PORT = process.env.PORT || 3000;

// 2) Also randomize the order of ITEMS within each row?
const SHUFFLE_ITEMS = true;

// Catalogs to leave in their original order (case-insensitive match against
// the catalog's name or id). Useful for ranked/chronological rows.
const SHUFFLE_EXCLUDE = [
  "latest",
  "because",
  "for you",
];

// 3) Catalogs to REMOVE entirely — they won't appear on the home screen at
// all (case-insensitive match against the catalog's name or id).
const CATALOG_EXCLUDE = [
  "90 day",
  "below deck",
  "Competition",
  "Love Island",
  "Netflix Reality",
  "Other Reality",
  "latest reality",
];

// ---------------------------------------------------------------------------

const http = require("http");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

let _cache = { at: 0, upstreams: null };

function sendJson(res, body, extraHeaders = {}) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS,
    ...extraHeaders,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain", ...CORS });
  res.end("Not found");
}

// Fisher–Yates shuffle (non-mutating)
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Fetch all upstream manifests (cached). Failed upstreams become null so
// that array indices stay stable — catalog IDs encode the upstream index.
async function loadUpstreams() {
  const now = Date.now();
  if (_cache.upstreams && now - _cache.at < UPSTREAM_TTL_MS) {
    return _cache.upstreams;
  }

  const results = await Promise.allSettled(
    UPSTREAM_MANIFESTS.map(async (url) => {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const manifest = await res.json();
      return { base: url.replace(/\/manifest\.json.*$/, ""), manifest };
    })
  );

  const upstreams = results.map((r) =>
    r.status === "fulfilled" ? r.value : null
  );

  _cache = { at: now, upstreams };
  return upstreams;
}

// Case-insensitive substring match of a catalog's name/id against a term list
function matchesAny(terms, name, id) {
  if (!terms.length) return false;
  const haystack = `${id} ${name || ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

// Collect every catalog from every upstream, prefixing IDs with "u<i>~"
// so /catalog requests can be routed back to the right addon.
// Catalogs matching CATALOG_EXCLUDE are dropped entirely.
function buildCatalogs(upstreams) {
  const catalogs = [];
  upstreams.forEach((up, i) => {
    if (!up) return;
    for (const cat of up.manifest.catalogs || []) {
      if (matchesAny(CATALOG_EXCLUDE, cat.name, cat.id)) continue;
      catalogs.push({ ...cat, id: `u${i}~${cat.id}` });
    }
  });
  return catalogs;
}

async function handleManifest(res) {
  const upstreams = await loadUpstreams();
  const catalogs = shuffle(buildCatalogs(upstreams));
  const types = [...new Set(catalogs.map((c) => c.type))];

  sendJson(
    res,
    {
      id: ADDON_ID,
      version: "1.0.0",
      name: ADDON_NAME,
      description:
        "Aggregates catalogs from your other addons and serves them in a random order on every manifest fetch.",
      resources: ["catalog"],
      types,
      catalogs,
      behaviorHints: { configurable: false, adult: false },
    },
    // Ask clients not to cache the manifest, so re-fetches get a new order
    { "Cache-Control": "no-store, max-age=0" }
  );
}

// Should items in this catalog keep their original order?
function isShuffleExcluded(up, type, rawOriginalId) {
  if (SHUFFLE_EXCLUDE.length === 0) return false;
  let originalId = rawOriginalId;
  try {
    originalId = decodeURIComponent(rawOriginalId);
  } catch {}
  const cat = (up.manifest.catalogs || []).find(
    (c) => c.id === originalId && c.type === type
  );
  return matchesAny(SHUFFLE_EXCLUDE, cat && cat.name, originalId);
}

// Proxy /catalog/<type>/<id>.json (and /<extra>.json) to the original addon.
// Path segments are passed through raw to avoid any double-encoding issues.
// If SHUFFLE_ITEMS is on, the items in the response are randomized too.
async function handleCatalog(res, type, rawId, rawExtra) {
  const m = rawId.match(/^u(\d+)~(.+)$/);
  if (!m) return sendJson(res, { metas: [] });

  const upstreams = await loadUpstreams();
  const up = upstreams[Number(m[1])];
  if (!up) return sendJson(res, { metas: [] });

  const path =
    `/catalog/${type}/${m[2]}` + (rawExtra ? `/${rawExtra}` : "") + ".json";

  try {
    const upstreamRes = await fetch(up.base + path, {
      headers: { Accept: "application/json" },
    });
    if (!upstreamRes.ok) return sendJson(res, { metas: [] });
    const body = await upstreamRes.text();

    if (SHUFFLE_ITEMS && !isShuffleExcluded(up, type, m[2])) {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data.metas)) {
          data.metas = shuffle(data.metas);
          return sendJson(res, data, {
            "Cache-Control": "no-store, max-age=0",
          });
        }
      } catch {
        // Not valid JSON — fall through and pass it along untouched
      }
    }

    sendJson(res, body, { "Cache-Control": "max-age=300" });
  } catch {
    sendJson(res, { metas: [] });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    const pathname = new URL(req.url, "http://localhost").pathname;

    if (pathname === "/" || pathname === "") {
      const upstreams = await loadUpstreams();
      let total = 0;
      let out = `${ADDON_NAME}\n\nInstall URL: <this-domain>/manifest.json\n`;
      upstreams.forEach((up, i) => {
        if (!up) {
          out += `\n[u${i}] FAILED TO LOAD: ${UPSTREAM_MANIFESTS[i]}\n`;
          return;
        }
        const cats = up.manifest.catalogs || [];
        const served = cats.filter(
          (c) => !matchesAny(CATALOG_EXCLUDE, c.name, c.id)
        );
        total += served.length;
        out += `\n[u${i}] ${up.manifest.name || "Unnamed addon"} — serving ${served.length} of ${cats.length} catalog${cats.length === 1 ? "" : "s"}\n`;
        for (const c of cats) {
          const excluded = matchesAny(CATALOG_EXCLUDE, c.name, c.id);
          out += excluded
            ? `   x ${c.type} / ${c.name || c.id}  (EXCLUDED)\n`
            : `   • ${c.type} / ${c.name || c.id}\n`;
        }
      });
      out += `\nTotal: ${total} catalogs from ${upstreams.filter(Boolean).length} of ${UPSTREAM_MANIFESTS.length} addons\n`;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return res.end(out);
    }

    if (pathname === "/manifest.json") return await handleManifest(res);

    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "catalog" && parts.length >= 3) {
      const last = parts[parts.length - 1];
      if (!last.endsWith(".json")) return notFound(res);
      const type = parts[1];
      if (parts.length === 3) {
        return await handleCatalog(res, type, last.slice(0, -5), null);
      }
      if (parts.length === 4) {
        return await handleCatalog(res, type, parts[2], last.slice(0, -5));
      }
    }

    notFound(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain", ...CORS });
    res.end("Internal error");
  }
});

server.listen(PORT, () => {
  console.log(`${ADDON_NAME} running on port ${PORT}`);
});
