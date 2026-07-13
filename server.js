/**
 * Catalog Shuffler — proxy addon for Nuvio/Stremio (Node.js / Render version)
 *
 * Aggregates the catalogs from your other addons into one addon,
 * and serves them in a RANDOM order every time the manifest is fetched.
 * Catalog requests are proxied straight through to the original addon.
 *
 * Shuffle Shows: a "🎲 Shuffle" home-screen row. Each show in it opens
 * with a freshly randomized episode list on every visit, so Auto-Play
 * Next chains random episodes indefinitely.
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

// 4) Shuffle Shows — shows that get a "random episode" mode. Each one
// appears in a dedicated home-screen row; opening it shows a freshly
// shuffled batch of episodes (re-randomized every visit). Episodes keep
// their real IDs, so your stream addons (BingeCat) resolve them normally.
// Use IMDb series IDs — the tt… code from the show's IMDb URL.
const SHUFFLE_SHOWS = [
  "tt0108778", // Friends
  "tt0386676", // The Office (US)
];

const SHUFFLE_ROW_NAME = "🎲 Shuffle";      // home-screen row title
const SHUFFLE_CATALOG_ID = "shuffle-shows"; // internal catalog id
const SHUFFLE_EPISODE_COUNT = 10;           // episodes per visit
const SHUFFLE_INCLUDE_SPECIALS = false;     // include Season 0?

// Episode lists come from Cinemeta (Stremio's public metadata addon)
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const CINEMETA_TTL_MS = 12 * 60 * 60 * 1000; // cache episode lists 12h

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
  const allCatalogs = buildCatalogs(upstreams);
  if (SHUFFLE_SHOWS.length) {
    allCatalogs.push({
      type: "series",
      id: SHUFFLE_CATALOG_ID,
      name: SHUFFLE_ROW_NAME,
    });
  }
  const catalogs = shuffle(allCatalogs);
  const types = [...new Set(catalogs.map((c) => c.type))];

  sendJson(
    res,
    {
      id: ADDON_ID,
      version: "1.1.0",
      name: ADDON_NAME,
      description:
        "Aggregates catalogs from your other addons and serves them in a random order on every manifest fetch.",
      resources: SHUFFLE_SHOWS.length
        ? ["catalog", { name: "meta", types: ["series"], idPrefixes: ["shf~"] }]
        : ["catalog"],
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

// --- Shuffle Shows ---------------------------------------------------------

// In-memory cache of Cinemeta series metadata, keyed by IMDb id
const _showCache = new Map();

async function getShowMeta(imdbId) {
  const now = Date.now();
  const hit = _showCache.get(imdbId);
  if (hit && now - hit.at < CINEMETA_TTL_MS) return hit.meta;
  try {
    const res = await fetch(`${CINEMETA_BASE}/meta/series/${imdbId}.json`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Cinemeta ${imdbId} -> HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.meta) throw new Error(`Cinemeta ${imdbId} -> no meta`);
    _showCache.set(imdbId, { at: now, meta: data.meta });
    return data.meta;
  } catch (err) {
    console.error(String(err));
    return hit ? hit.meta : null; // serve a stale copy over nothing
  }
}

// Real, already-aired episodes (drops specials unless enabled)
function eligibleEpisodes(meta) {
  const now = Date.now();
  return (meta.videos || []).filter((v) => {
    const season = Number(v.season);
    const episode = Number(v.episode ?? v.number);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return false;
    if (!SHUFFLE_INCLUDE_SPECIALS && season === 0) return false;
    if (v.released && Date.parse(v.released) > now) return false; // unaired
    return true;
  });
}

const pad2 = (n) => String(n).padStart(2, "0");

// The "🎲 Shuffle" row: one entry per configured show
async function handleShuffleCatalog(res, rawExtra) {
  const skip = rawExtra && rawExtra.match(/skip=(\d+)/);
  if (skip && Number(skip[1]) > 0) return sendJson(res, { metas: [] });

  const metas = await Promise.all(
    SHUFFLE_SHOWS.map(async (imdbId) => {
      const meta = await getShowMeta(imdbId);
      return {
        id: `shf~${imdbId}`,
        type: "series",
        name: meta ? meta.name : imdbId,
        poster: meta ? meta.poster : undefined,
        posterShape: "poster",
        description: meta
          ? `Random episodes of ${meta.name} — reshuffles every visit.`
          : `Could not load ${imdbId} from Cinemeta (check the IMDb id).`,
      };
    })
  );

  sendJson(res, { metas }, { "Cache-Control": "no-store, max-age=0" });
}

// A shuffled batch of real episodes, renumbered 1..N so the list order IS
// the play order — Auto-Play Next just walks down the random list. Each
// video keeps its real id (tt…:s:e) so stream addons resolve it normally.
async function handleShuffleMeta(res, imdbId) {
  const src = await getShowMeta(imdbId);
  if (!src) return sendJson(res, { meta: null });

  const picked = shuffle(eligibleEpisodes(src)).slice(0, SHUFFLE_EPISODE_COUNT);

  const videos = picked.map((v, i) => ({
    id: v.id,
    title: `S${pad2(v.season)}E${pad2(v.episode ?? v.number)} · ${
      v.title || v.name || "Episode"
    }`,
    season: 1,
    episode: i + 1,
    number: i + 1,
    released: v.released,
    thumbnail: v.thumbnail,
    overview: v.overview || v.description,
  }));

  sendJson(
    res,
    {
      meta: {
        id: `shf~${imdbId}`,
        type: "series",
        name: `${src.name} · Shuffle`,
        poster: src.poster,
        background: src.background,
        logo: src.logo,
        description: `${videos.length} random episodes of ${src.name}. Back out and reopen to reshuffle. Turn on Auto-Play Next and let it run.`,
        videos,
      },
    },
    { "Cache-Control": "no-store, max-age=0" }
  );
}

// ---------------------------------------------------------------------------

// Proxy /catalog/<type>/<id>.json (and /<extra>.json) to the original addon.
// Path segments are passed through raw to avoid any double-encoding issues.
// If SHUFFLE_ITEMS is on, the items in the response are randomized too.
async function handleCatalog(res, type, rawId, rawExtra) {
  if (SHUFFLE_SHOWS.length && type === "series" && rawId === SHUFFLE_CATALOG_ID) {
    return handleShuffleCatalog(res, rawExtra);
  }

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
      if (SHUFFLE_SHOWS.length) {
        total += 1;
        out += `\n[shuffle] ${SHUFFLE_ROW_NAME} — ${SHUFFLE_SHOWS.length} show${SHUFFLE_SHOWS.length === 1 ? "" : "s"}\n`;
        for (const imdbId of SHUFFLE_SHOWS) {
          const meta = await getShowMeta(imdbId);
          out += meta
            ? `   • ${meta.name} (${imdbId})\n`
            : `   x ${imdbId}  (FAILED TO LOAD from Cinemeta)\n`;
        }
      }
      out += `\nTotal: ${total} catalogs from ${upstreams.filter(Boolean).length} of ${UPSTREAM_MANIFESTS.length} addons\n`;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return res.end(out);
    }

    if (pathname === "/manifest.json") return await handleManifest(res);

    const parts = pathname.split("/").filter(Boolean);

    if (parts[0] === "meta" && parts.length === 3) {
      const last = parts[2];
      if (!last.endsWith(".json")) return notFound(res);
      let id = last.slice(0, -5);
      try {
        id = decodeURIComponent(id);
      } catch {}
      if (parts[1] === "series" && id.startsWith("shf~")) {
        return await handleShuffleMeta(res, id.slice(4));
      }
      return sendJson(res, { meta: null });
    }

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
