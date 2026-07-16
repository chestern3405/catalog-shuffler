/**
 * Catalog Shuffler (Trakt edition) — proxy addon for Nuvio/Stremio.
 *
 * Same as the base addon — aggregates other addons' catalogs in random
 * order, plus a "🎲 Shuffle" row of random-episode shows — except the
 * shuffle show list is pulled from a PUBLIC TRAKT LIST instead of being
 * edited by hand. Curate the list on trakt.tv; the row mirrors it.
 *
 * The /config page is READ-ONLY here: it shows what's currently pulled
 * from Trakt and whether the connection is healthy. There is no in-app
 * or web adding — Trakt is the single source of truth.
 *
 * Zero dependencies — runs on Node 18+ with `node server.js`.
 */

// 1) Manifest URLs of the addons whose catalogs you want aggregated:
const UPSTREAM_MANIFESTS = [
  "https://bingecat.com/stremio/fc240269-f369-43c4-ae76-1e95bfc480ee/nuvio/manifest.json?bcv=78",
  "https://aiometadata.viren070.me/stremio/5ec91dc1-27ba-4165-8d77-c42d9b77cd35/manifest.json",
];

const ADDON_ID = "org.chase.catalog-shuffler.trakt";
const ADDON_NAME = "Catalog Shuffler (Trakt)";
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

// 4) The 🎲 Shuffle row is populated from a PUBLIC Trakt list. Set these
// as environment variables on Render (service → Environment tab):
//   TRAKT_CLIENT_ID  the Client ID from your Trakt API app
//                    (trakt.tv/oauth/applications)
//   TRAKT_USER       the user slug from the list URL
//   TRAKT_LIST       the list slug from the list URL
// e.g. for https://trakt.tv/users/chestern3405/lists/shuffle
//   TRAKT_USER = chestern3405   TRAKT_LIST = shuffle
// The list must be Public. Shows are matched by their IMDb id, so your
// stream addons (BingeCat) resolve episodes normally.
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";
const TRAKT_USER = process.env.TRAKT_USER || "";
const TRAKT_LIST = process.env.TRAKT_LIST || "";
const TRAKT_API = "https://api.trakt.tv";
const TRAKT_TTL_MS = 10 * 60 * 1000; // re-check the Trakt list every 10 min

const SHUFFLE_ROW_NAME = "🎲 Shuffle";      // home-screen row title
const SHUFFLE_CATALOG_ID = "shuffle-shows"; // internal catalog id
const SHUFFLE_ALL_POSTER = "https://files.catbox.moe/xwbu5e.jpg";     // "All" tile
const SHUFFLE_ALL_BACKGROUND = "https://files.catbox.moe/sgidvf.jpg"; // "All" backdrop
const SHUFFLE_EPISODE_COUNT = 20;           // episodes per visit
const SHUFFLE_INCLUDE_SPECIALS = false;     // include Season 0?

// Episode lists come from Cinemeta (Stremio's public metadata addon)
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const CINEMETA_TTL_MS = 12 * 60 * 60 * 1000; // cache episode lists 12h

// 5) Fallback cache (optional): if a GitHub token is set, the last Trakt
// list we successfully fetched is mirrored to a file in the repo, so the
// row survives a Trakt outage or a cold start. This is separate from the
// base addon's shows.json — set SHOWS_FILE to keep them apart. Leave the
// token blank to skip this; the addon still works, just without the
// offline safety net.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || ""; // "user/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SHOWS_FILE = process.env.SHOWS_FILE || "shows-trakt.json";
const GH_API = "https://api.github.com";

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
  const shuffleShows = await getShuffleShows();
  const allCatalogs = buildCatalogs(upstreams);
  if (shuffleShows.length) {
    allCatalogs.push({
      type: "series",
      id: SHUFFLE_CATALOG_ID,
      name: SHUFFLE_ROW_NAME,
      // Keep the row out of the home screen — it's reachable from the
      // catalog/collection view. If your client ignores this hint, hide
      // the row in the client's own catalog settings.
      behaviorHints: { hideOnHome: true },
    });
  }
  const catalogs = shuffle(allCatalogs);
  const types = [...new Set(catalogs.map((c) => c.type))];

  sendJson(
    res,
    {
      id: ADDON_ID,
      version: "2.0.0",
      name: ADDON_NAME,
      description:
        "Aggregates catalogs from your other addons in random order, plus a 🎲 Shuffle row driven by a public Trakt list.",
      resources: shuffleShows.length
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

// Cinemeta hands out metahub image URLs at modest sizes — posters at
// /small/ and backgrounds at /medium/ — which look soft and blocky on a
// TV. Metahub serves the same images at larger sizes, so bump the size
// segment. Non-metahub URLs (e.g. the "All" artwork) pass through as-is.
function bigImage(url, kind) {
  if (typeof url !== "string") return url;
  const want = kind === "background" ? "large" : "medium";
  return url.replace(
    /^(https?:\/\/images\.metahub\.space\/(?:background|poster|logo)\/)[^/]+\//,
    `$1${want}/`
  );
}

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
    const meta = data.meta;
    meta.poster = bigImage(meta.poster, "poster");
    meta.background = bigImage(meta.background, "background");
    meta.logo = bigImage(meta.logo, "logo");
    _showCache.set(imdbId, { at: now, meta });
    return meta;
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

// The "🎲 Shuffle" row: "All" first, then one entry per show in the Trakt
// list. Managed on trakt.tv — not searchable, nothing to add in-app.
async function handleShuffleCatalog(res, rawExtra) {
  const extra = rawExtra || "";
  const skip = extra.match(/(?:^|&)skip=(\d+)/);
  if (skip && Number(skip[1]) > 0) return sendJson(res, { metas: [] });
  if (/(?:^|&)search=/.test(extra)) return sendJson(res, { metas: [] });

  const shows = await getShuffleShows();
  const showMetas = await Promise.all(shows.map((s) => getShowMeta(s.id)));

  const metas = shows.map((s, i) => {
    const meta = showMetas[i];
    return {
      id: `shf~${s.id}`,
      type: "series",
      name: meta ? meta.name : s.name || s.id,
      poster: meta ? meta.poster : undefined,
      posterShape: "poster",
      description: meta
        ? `Random episodes of ${meta.name} — reshuffles every visit.`
        : `Could not load ${s.id} from Cinemeta (check the IMDb id).`,
    };
  });

  if (shows.length) {
    metas.unshift({
      id: "shf~all",
      type: "series",
      name: "All",
      poster: SHUFFLE_ALL_POSTER,
      posterShape: "poster",
      description:
        "Random episodes from every show in this row — reshuffles every visit.",
    });
  }

  sendJson(res, { metas }, { "Cache-Control": "no-store, max-age=0" });
}

// "All": one shuffled batch drawn evenly across every show in the list, so
// Auto-Play Next channel-surfs between shows.
async function handleAllShuffleMeta(res) {
  const shows = await getShuffleShows();
  const showMetas = await Promise.all(shows.map((s) => getShowMeta(s.id)));

  const decks = [];
  showMetas.forEach((meta) => {
    if (!meta) return;
    const eps = shuffle(eligibleEpisodes(meta));
    if (eps.length) {
      decks.push({ name: meta.name, eps });
    }
  });
  if (!decks.length) return sendJson(res, { meta: null });

  const picked = [];
  while (picked.length < SHUFFLE_EPISODE_COUNT) {
    const withLeft = decks.filter((d) => d.eps.length);
    if (!withLeft.length) break;
    const deck = withLeft[Math.floor(Math.random() * withLeft.length)];
    picked.push({ show: deck.name, v: deck.eps.pop() });
  }

  const videos = picked.map((p, i) => ({
    id: p.v.id,
    title: `${p.show} · S${pad2(p.v.season)}E${pad2(p.v.episode ?? p.v.number)} · ${
      p.v.title || p.v.name || "Episode"
    }`,
    season: 1,
    episode: i + 1,
    number: i + 1,
    released: p.v.released,
    thumbnail: p.v.thumbnail,
    overview: p.v.overview || p.v.description,
  }));

  sendJson(
    res,
    {
      meta: {
        id: "shf~all",
        type: "series",
        name: "All · Shuffle",
        poster: SHUFFLE_ALL_POSTER,
        background: SHUFFLE_ALL_BACKGROUND || undefined,
        description: `${videos.length} random episodes drawn from all ${decks.length} of your shuffle shows. Back out and reopen to reshuffle. Turn on Auto-Play Next and let it run.`,
        videos,
      },
    },
    { "Cache-Control": "no-store, max-age=0" }
  );
}

// A shuffled batch of real episodes, renumbered 1..N so the list order IS
// the play order — Auto-Play Next just walks down the random list. Each
// video keeps its real id (tt…:s:e) so stream addons resolve it normally.
async function handleShuffleMeta(res, imdbId) {
  if (imdbId === "all") return handleAllShuffleMeta(res);

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

// --- Shuffle Shows from a public Trakt list --------------------------------

function traktConfigured() {
  return Boolean(TRAKT_CLIENT_ID && TRAKT_USER && TRAKT_LIST);
}

function fallbackConfigured() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "catalog-shuffler-trakt",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Fetch the show list straight from the public Trakt list. Each item is
// { type, show: { ids: { imdb }, title, year } }; we keep the shows that
// carry an IMDb id, since that's what the shuffle engine and BingeCat use.
async function fetchTraktList() {
  const seen = new Set();
  const list = [];
  const limit = 100;
  let page = 1;
  let pageCount = 1;

  do {
    const res = await fetch(
      `${TRAKT_API}/users/${encodeURIComponent(TRAKT_USER)}/lists/${encodeURIComponent(
        TRAKT_LIST
      )}/items/show?page=${page}&limit=${limit}`,
      {
        headers: {
          "Content-Type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": TRAKT_CLIENT_ID,
          // Trakt rejects requests without a User-Agent (Node's fetch sends
          // none by default), so set one explicitly.
          "User-Agent": "catalog-shuffler-trakt",
        },
      }
    );
    if (res.status === 404) {
      throw new Error("Trakt list not found (check TRAKT_USER / TRAKT_LIST, and that the list is public)");
    }
    if (!res.ok) throw new Error(`Trakt -> HTTP ${res.status}`);

    // Trakt reports total pages in a response header; default page size is
    // small, so without paging we'd only see the first slice of the list.
    const headerCount = Number(res.headers.get("x-pagination-page-count"));
    if (Number.isFinite(headerCount) && headerCount > 0) pageCount = headerCount;

    const items = await res.json();
    if (!Array.isArray(items)) throw new Error("Trakt -> unexpected response");
    for (const it of items) {
      const show = it && it.show;
      const imdb = show && show.ids && show.ids.imdb;
      if (!imdb || !/^tt\d+$/.test(imdb) || seen.has(imdb)) continue;
      seen.add(imdb);
      list.push({ id: imdb, name: show.title || imdb });
    }
    page += 1;
  } while (page <= pageCount && page <= 20); // hard stop at 2000 items

  return list;
}

// --- Optional GitHub fallback cache (separate file from the base addon) -----

async function readFallback() {
  try {
    const res = await fetch(
      `${GH_API}/repos/${GITHUB_REPO}/contents/${SHOWS_FILE}?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders() }
    );
    if (res.status === 404) return { list: null, sha: null };
    if (!res.ok) throw new Error(`GitHub read -> HTTP ${res.status}`);
    const data = await res.json();
    const text = Buffer.from(data.content, "base64").toString("utf8");
    const parsed = JSON.parse(text);
    const list = (Array.isArray(parsed.shows) ? parsed.shows : []).filter(
      (s) => s && typeof s.id === "string" && /^tt\d+$/.test(s.id)
    );
    return { list, sha: data.sha };
  } catch (err) {
    console.error(String(err));
    return { list: null, sha: null };
  }
}

let _fallbackSha = null;

// Mirror the freshly fetched Trakt list to GitHub, but only when it actually
// changed, to avoid pointless commits. Tagged [skip render].
async function writeFallback(list) {
  const desired = JSON.stringify({ shows: list }, null, 2) + "\n";
  const current = await readFallback();
  _fallbackSha = current.sha;
  if (current.list && JSON.stringify({ shows: current.list }, null, 2) + "\n" === desired) {
    return; // unchanged — nothing to commit
  }
  const body = {
    message: "Cache Trakt shuffle list [skip render]",
    content: Buffer.from(desired).toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (current.sha) body.sha = current.sha;
  try {
    const res = await fetch(
      `${GH_API}/repos/${GITHUB_REPO}/contents/${SHOWS_FILE}`,
      {
        method: "PUT",
        headers: { ...ghHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error(`GitHub write -> HTTP ${res.status}`);
    const data = await res.json();
    _fallbackSha = data.content.sha;
  } catch (err) {
    console.error(String(err)); // caching is best-effort
  }
}

// The effective show list. Tries Trakt first (cached in memory for
// TRAKT_TTL_MS); on failure, serves the last good in-memory list, then the
// GitHub fallback cache, so the row never goes empty mid-binge.
let _shows = { at: 0, list: null, source: "none" };

async function getShuffleShows(force = false) {
  if (!traktConfigured()) return _shows.list || [];
  const now = Date.now();
  if (!force && _shows.list && now - _shows.at < TRAKT_TTL_MS) {
    return _shows.list;
  }
  try {
    const list = await fetchTraktList();
    _shows = { at: now, list, source: "trakt" };
    if (fallbackConfigured()) writeFallback(list); // fire-and-forget
    return list;
  } catch (err) {
    console.error(String(err));
    if (_shows.list) return _shows.list; // keep serving last good list
    if (fallbackConfigured()) {
      const fb = await readFallback();
      if (fb.list) {
        _shows = { at: now, list: fb.list, source: "fallback" };
        return fb.list;
      }
    }
    return [];
  }
}

// Names/posters for the config page, resolved through the Cinemeta cache
async function enrichShows(list) {
  return Promise.all(
    list.map(async (s) => {
      const meta = await getShowMeta(s.id);
      return {
        id: s.id,
        name: (meta && meta.name) || s.name || s.id,
        poster: meta ? meta.poster || null : null,
      };
    })
  );
}

// --- Read-only status page + API --------------------------------------------

function sendApi(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS,
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, url, pathname) {
  if (pathname === "/api/shows" && req.method === "GET") {
    if (!traktConfigured()) {
      return sendApi(res, 400, {
        ok: false,
        error:
          "Trakt not configured — set TRAKT_CLIENT_ID, TRAKT_USER and TRAKT_LIST on Render",
      });
    }
    try {
      const shows = await getShuffleShows(true);
      return sendApi(res, 200, {
        ok: true,
        source: _shows.source,
        list: `${TRAKT_USER}/${TRAKT_LIST}`,
        fallback: fallbackConfigured() ? `${GITHUB_REPO}/${SHOWS_FILE}` : null,
        shows: await enrichShows(shows),
      });
    } catch (err) {
      console.error(String(err));
      return sendApi(res, 502, {
        ok: false,
        error: `Could not read the Trakt list: ${String(err.message || err)}`,
      });
    }
  }

  return sendApi(res, 404, { ok: false, error: "Unknown API route" });
}

const CONFIG_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shuffle (Trakt) status</title>
<style>
:root { color-scheme: dark; }
body { font-family: -apple-system, system-ui, sans-serif; background: #101014; color: #eee; margin: 0 auto; padding: 16px; max-width: 640px; }
h1 { font-size: 20px; margin: 8px 0 4px; }
h2 { font-size: 13px; color: #9a9aa2; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: .06em; }
a { color: #7aa2ff; }
.status { background: #1c1c22; border-radius: 12px; padding: 12px 14px; font-size: 14px; line-height: 1.5; }
.status .ok { color: #7ddf9a; }
.status .bad { color: #ff8a8a; }
.card { display: flex; align-items: center; gap: 12px; background: #1c1c22; border-radius: 12px; padding: 10px; margin-bottom: 8px; }
.card img { width: 46px; height: 68px; object-fit: cover; border-radius: 6px; background: #2c2c34; flex: none; }
.card .nm { flex: 1; min-width: 0; }
.card .nm b { display: block; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .nm span { font-size: 12px; color: #9a9aa2; }
#msg { padding: 8px 0; font-size: 14px; color: #ff8a8a; min-height: 20px; }
</style>
</head>
<body>
<h1>🎲 Shuffle (Trakt)</h1>
<p style="color:#9a9aa2;font-size:13px;margin:0 0 8px">Read-only. Curate the row on <span id="listlink"></span>.</p>
<div id="status" class="status">Loading…</div>
<div id="msg"></div>
<h2>Shows in the row</h2>
<div id="list">Loading…</div>
<script>
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function card(s) {
  var img = s.poster ? '<img src="' + esc(s.poster) + '" loading="lazy" alt="">' : '<img alt="">';
  return '<div class="card">' + img +
    '<div class="nm"><b>' + esc(s.name) + '</b><span>' + esc(s.id) + '</span></div></div>';
}
fetch('/api/shows').then(function (r) {
  return r.json().then(function (j) { return { ok: r.ok, j: j }; });
}).then(function (res) {
  var j = res.j;
  var statusEl = document.getElementById('status');
  if (!res.ok || !j.ok) {
    statusEl.innerHTML = '<span class="bad">' + esc(j.error || 'Error') + '</span>';
    document.getElementById('list').textContent = '';
    return;
  }
  var parts = j.list.split('/');
  var href = 'https://trakt.tv/users/' + parts[0] + '/lists/' + parts[1];
  document.getElementById('listlink').innerHTML = '<a href="' + href + '" target="_blank">Trakt</a>';
  var srcLabel = j.source === 'trakt'
    ? '<span class="ok">Live from Trakt</span>'
    : (j.source === 'fallback'
        ? '<span class="bad">Trakt unreachable — serving cached list</span>'
        : '<span class="bad">No list loaded</span>');
  statusEl.innerHTML =
    'Source: ' + srcLabel + '<br>' +
    'List: <a href="' + href + '" target="_blank">' + esc(j.list) + '</a><br>' +
    'Shows: ' + j.shows.length +
    (j.fallback ? '<br>Fallback cache: ' + esc(j.fallback) : '<br>Fallback cache: off');
  document.getElementById('list').innerHTML = j.shows.length
    ? j.shows.map(card).join('')
    : 'The Trakt list is empty — add shows on Trakt and refresh.';
}).catch(function (e) {
  document.getElementById('status').innerHTML = '<span class="bad">' + esc(e.message) + '</span>';
  document.getElementById('list').textContent = '';
});
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------

// Proxy /catalog/<type>/<id>.json (and /<extra>.json) to the original addon.
// Path segments are passed through raw to avoid any double-encoding issues.
// If SHUFFLE_ITEMS is on, the items in the response are randomized too.
async function handleCatalog(res, type, rawId, rawExtra) {
  if (type === "series" && rawId === SHUFFLE_CATALOG_ID) {
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

    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "") {
      const upstreams = await loadUpstreams();
      let total = 0;
      let out = `${ADDON_NAME}\n\nInstall URL: <this-domain>/manifest.json\nStatus page: <this-domain>/config\n`;
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
      const shuffleShows = await getShuffleShows();
      if (traktConfigured()) {
        if (shuffleShows.length) total += 1;
        const srcNote =
          _shows.source === "trakt"
            ? "live from Trakt"
            : _shows.source === "fallback"
            ? "Trakt unreachable — cached list"
            : "no list loaded";
        out += `\n[shuffle] ${SHUFFLE_ROW_NAME} — ${shuffleShows.length} show${shuffleShows.length === 1 ? "" : "s"} (${TRAKT_USER}/${TRAKT_LIST}, ${srcNote})\n`;
        for (const s of shuffleShows) {
          const meta = await getShowMeta(s.id);
          out += meta
            ? `   • ${meta.name} (${s.id})\n`
            : `   x ${s.name || s.id} (${s.id})  (FAILED TO LOAD from Cinemeta)\n`;
        }
      } else {
        out += `\n[shuffle] ${SHUFFLE_ROW_NAME} — not configured (set TRAKT_CLIENT_ID, TRAKT_USER, TRAKT_LIST)\n`;
      }
      out += `\nTotal: ${total} catalogs from ${upstreams.filter(Boolean).length} of ${UPSTREAM_MANIFESTS.length} addons\n`;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return res.end(out);
    }

    if (pathname === "/manifest.json") return await handleManifest(res);

    if (pathname === "/config") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ...CORS,
        "Cache-Control": "no-store",
      });
      return res.end(CONFIG_HTML);
    }

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, url, pathname);
    }

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
