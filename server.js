/**
 * Catalog Shuffler — proxy addon for Nuvio/Stremio (Node.js / Render version)
 *
 * Aggregates the catalogs from your other addons into one addon,
 * and serves them in a RANDOM order every time the manifest is fetched.
 * Catalog requests are proxied straight through to the original addon.
 *
 * Shuffle Shows: a "🎲 Shuffle" home-screen row. Each show in it opens
 * with a freshly randomized episode list on every visit, so Auto-Play
 * Next chains random episodes indefinitely. Manage the show list from
 * <your-render-url>/config — no code edits needed (see section 5 below).
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
  // "tt0108778", // Friends
  // "tt0386676", // The Office (US)
];

const SHUFFLE_ROW_NAME = "🎲 Shuffle";      // home-screen row title
const SHUFFLE_CATALOG_ID = "shuffle-shows"; // internal catalog id
const SHUFFLE_EPISODE_COUNT = 20;           // episodes per visit
const SHUFFLE_INCLUDE_SPECIALS = false;     // include Season 0?

// In-app adding: the 🎲 row is searchable, so searching inside Nuvio also
// surfaces "🎲 <show>" results — opening one adds it to your list (up to
// the cap below). Remove shows from the /config page.
const SHUFFLE_MAX_SHOWS = 50;

// Episode lists come from Cinemeta (Stremio's public metadata addon)
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const CINEMETA_TTL_MS = 12 * 60 * 60 * 1000; // cache episode lists 12h

// 5) Remote config (recommended): manage the shuffle list from
// <your-render-url>/config instead of editing this file. Set these three
// environment variables on Render (service → Environment tab):
//   GITHUB_TOKEN     fine-grained personal access token with
//                    Contents: Read and write, on this repo only
//   GITHUB_REPO      this repo, e.g. "yourname/catalog-shuffler"
//   CONFIG_PASSWORD  a password of your choice for the /config page
// The list is stored as shows.json in the repo. Commits are tagged
// [skip render] so saving the list does NOT trigger a redeploy. Once
// storage is active, SHUFFLE_SHOWS above is only the seed for the first
// save and a fallback if GitHub is unreachable.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || ""; // "user/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SHOWS_FILE = process.env.SHOWS_FILE || "shows.json";
const CONFIG_PASSWORD = process.env.CONFIG_PASSWORD || "";
const GH_API = "https://api.github.com";
const SHOWS_TTL_MS = 5 * 60 * 1000; // re-check shows.json every 5 min

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
      extra: [{ name: "search", isRequired: false }],
      extraSupported: ["search"],
    });
  }
  const catalogs = shuffle(allCatalogs);
  const types = [...new Set(catalogs.map((c) => c.type))];

  sendJson(
    res,
    {
      id: ADDON_ID,
      version: "1.3.0",
      name: ADDON_NAME,
      description:
        "Aggregates catalogs from your other addons and serves them in a random order on every manifest fetch.",
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

// The "🎲 Shuffle" row: "All" first, then one entry per configured show.
// Also answers search requests (see handleShuffleSearch) so shows can be
// added from inside Nuvio.
async function handleShuffleCatalog(res, rawExtra) {
  const extra = rawExtra || "";
  const skip = extra.match(/(?:^|&)skip=(\d+)/);
  if (skip && Number(skip[1]) > 0) return sendJson(res, { metas: [] });

  const searchMatch = extra.match(/(?:^|&)search=([^&]+)/);
  if (searchMatch) {
    let q = searchMatch[1];
    try {
      q = decodeURIComponent(q);
    } catch {}
    return handleShuffleSearch(res, q.replace(/\+/g, " ").trim());
  }

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
    const posters = showMetas
      .filter(Boolean)
      .map((m) => m.poster)
      .filter(Boolean);
    metas.unshift({
      id: "shf~all",
      type: "series",
      name: "All",
      poster: posters.length
        ? posters[Math.floor(Math.random() * posters.length)]
        : undefined,
      posterShape: "poster",
      description:
        "Random episodes from every show in this row — reshuffles every visit.",
    });
  }

  sendJson(res, { metas }, { "Cache-Control": "no-store, max-age=0" });
}

// Shows recently returned by an in-app 🎲 search — opening one of these is
// the signal to add it to the list (see handleShuffleMeta). Keeping this
// window means stale entries (e.g. Continue Watching items for a removed
// show) never re-add themselves.
const _recentSearches = new Map(); // imdbId -> timestamp
const SEARCH_ADD_WINDOW_MS = 15 * 60 * 1000;

function noteSearched(ids) {
  const now = Date.now();
  for (const id of ids) _recentSearches.set(id, now);
  if (_recentSearches.size > 500) {
    for (const [id, t] of _recentSearches) {
      if (now - t > SEARCH_ADD_WINDOW_MS) _recentSearches.delete(id);
    }
  }
}

function wasRecentlySearched(id) {
  const t = _recentSearches.get(id);
  return Boolean(t && Date.now() - t < SEARCH_ADD_WINDOW_MS);
}

// In-app search results: 🎲-prefixed versions of Cinemeta's matches.
// Opening one adds the show to the list and starts shuffling it.
async function handleShuffleSearch(res, q) {
  if (q.length < 2) return sendJson(res, { metas: [] });
  try {
    const r = await fetch(
      `${CINEMETA_BASE}/catalog/series/top/search=${encodeURIComponent(q)}.json`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) throw new Error(`Cinemeta search -> HTTP ${r.status}`);
    const data = await r.json();
    const found = (data.metas || [])
      .filter((m) => m && /^tt\d+$/.test(m.id))
      .slice(0, 10);
    noteSearched(found.map((m) => m.id));
    const metas = found.map((m) => ({
      id: `shf~${m.id}`,
      type: "series",
      name: `🎲 ${m.name}`,
      poster: m.poster || undefined,
      posterShape: "poster",
      description:
        "Open to add this show to your 🎲 Shuffle row and play random episodes.",
    }));
    sendJson(res, { metas }, { "Cache-Control": "no-store, max-age=0" });
  } catch (err) {
    console.error(String(err));
    sendJson(res, { metas: [] });
  }
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
      decks.push({
        name: meta.name,
        poster: meta.poster,
        background: meta.background,
        eps,
      });
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

  const cover = decks[Math.floor(Math.random() * decks.length)];
  sendJson(
    res,
    {
      meta: {
        id: "shf~all",
        type: "series",
        name: "All · Shuffle",
        poster: cover.poster,
        background: cover.background,
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

  // In-app add: opening a 🎲 search result lands here with a show that may
  // not be in the list yet — persist it (bounded; failures are non-fatal).
  if (storageConfigured() && wasRecentlySearched(imdbId)) {
    try {
      const shows = await getShuffleShows();
      if (
        !shows.some((s) => s.id === imdbId) &&
        shows.length < SHUFFLE_MAX_SHOWS
      ) {
        await mutateShows("add", imdbId, src.name);
      }
    } catch (err) {
      console.error(String(err));
    }
  }

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

// --- Shuffle Shows storage (shows.json in your GitHub repo) -----------------

function storageConfigured() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "catalog-shuffler",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// The in-code list, in storage format. Used as the seed for the first save
// and as the fallback when storage is off or unreachable.
function codeSeedList() {
  return SHUFFLE_SHOWS.map((id) => ({ id, name: id }));
}

let _shows = { at: 0, list: null, sha: null };

async function readShowsFile() {
  const res = await fetch(
    `${GH_API}/repos/${GITHUB_REPO}/contents/${SHOWS_FILE}?ref=${GITHUB_BRANCH}`,
    { headers: ghHeaders() }
  );
  if (res.status === 404) return { list: null, sha: null }; // no file yet
  if (!res.ok) throw new Error(`GitHub read -> HTTP ${res.status}`);
  const data = await res.json();
  const text = Buffer.from(data.content, "base64").toString("utf8");
  const parsed = JSON.parse(text);
  const list = (Array.isArray(parsed.shows) ? parsed.shows : []).filter(
    (s) => s && typeof s.id === "string" && /^tt\d+$/.test(s.id)
  );
  return { list, sha: data.sha };
}

async function writeShowsFile(list, sha) {
  const content = Buffer.from(
    JSON.stringify({ shows: list }, null, 2) + "\n"
  ).toString("base64");
  const body = {
    message: "Update shuffle shows [skip render]",
    content,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
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
  return data.content.sha;
}

// The effective show list: shows.json when storage is configured, otherwise
// the in-code SHUFFLE_SHOWS. Cached in memory; force=true skips the cache.
async function getShuffleShows(force = false) {
  if (!storageConfigured()) return codeSeedList();
  const now = Date.now();
  if (!force && _shows.list && now - _shows.at < SHOWS_TTL_MS) {
    return _shows.list;
  }
  try {
    const { list, sha } = await readShowsFile();
    _shows =
      list === null
        ? { at: now, list: codeSeedList(), sha: null }
        : { at: now, list, sha };
  } catch (err) {
    console.error(String(err));
    if (!_shows.list) return codeSeedList(); // never loaded — fall back
    // otherwise keep serving the last known list
  }
  return _shows.list;
}

// Add/remove a show and commit the result. Retries once on a sha conflict
// (e.g. the file changed on GitHub since our last read).
async function mutateShows(action, id, name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await getShuffleShows(true);
    let list = (_shows.list || codeSeedList()).slice();
    if (action === "add") {
      if (!list.some((s) => s.id === id)) list.push({ id, name: name || id });
    } else {
      list = list.filter((s) => s.id !== id);
    }
    try {
      const newSha = await writeShowsFile(list, _shows.sha);
      _shows = { at: Date.now(), list, sha: newSha };
      return list;
    } catch (err) {
      if (attempt === 0 && /409|422/.test(String(err))) continue;
      throw err;
    }
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

// --- Config page + API -------------------------------------------------------

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
    const shows = await getShuffleShows(true);
    return sendApi(res, 200, {
      ok: true,
      storage: storageConfigured() ? GITHUB_REPO : null,
      shows: await enrichShows(shows),
    });
  }

  if (pathname === "/api/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) {
      return sendApi(res, 400, { ok: false, error: "Type at least 2 characters" });
    }
    try {
      const r = await fetch(
        `${CINEMETA_BASE}/catalog/series/top/search=${encodeURIComponent(q)}.json`,
        { headers: { Accept: "application/json" } }
      );
      if (!r.ok) throw new Error(`Cinemeta search -> HTTP ${r.status}`);
      const data = await r.json();
      const results = (data.metas || [])
        .filter((m) => m && /^tt\d+$/.test(m.id))
        .slice(0, 20)
        .map((m) => ({
          id: m.id,
          name: m.name,
          poster: m.poster || null,
          releaseInfo: m.releaseInfo || "",
        }));
      return sendApi(res, 200, { ok: true, results });
    } catch (err) {
      console.error(String(err));
      return sendApi(res, 502, { ok: false, error: "Search failed — try again" });
    }
  }

  if (
    (pathname === "/api/add" || pathname === "/api/remove") &&
    req.method === "POST"
  ) {
    if (!storageConfigured()) {
      return sendApi(res, 400, {
        ok: false,
        error: "Storage not configured — set GITHUB_TOKEN and GITHUB_REPO on Render",
      });
    }
    if (!CONFIG_PASSWORD) {
      return sendApi(res, 403, {
        ok: false,
        error: "CONFIG_PASSWORD env var is not set on Render",
      });
    }
    if ((req.headers["x-config-key"] || "") !== CONFIG_PASSWORD) {
      return sendApi(res, 401, { ok: false, error: "Wrong password" });
    }
    const id = (url.searchParams.get("id") || "").trim();
    if (!/^tt\d{2,10}$/.test(id)) {
      return sendApi(res, 400, { ok: false, error: "Invalid IMDb id" });
    }
    const name = (url.searchParams.get("name") || "").trim().slice(0, 120);
    try {
      const list = await mutateShows(
        pathname === "/api/add" ? "add" : "remove",
        id,
        name
      );
      return sendApi(res, 200, { ok: true, shows: await enrichShows(list) });
    } catch (err) {
      console.error(String(err));
      return sendApi(res, 502, {
        ok: false,
        error: `GitHub save failed: ${String(err.message || err)}`,
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
<title>Shuffle config</title>
<style>
:root { color-scheme: dark; }
body { font-family: -apple-system, system-ui, sans-serif; background: #101014; color: #eee; margin: 0 auto; padding: 16px; max-width: 640px; }
h1 { font-size: 20px; margin: 8px 0 16px; }
h2 { font-size: 13px; color: #9a9aa2; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: .06em; }
input { background: #1c1c22; border: 1px solid #2c2c34; color: #eee; border-radius: 10px; padding: 12px; font-size: 16px; width: 100%; box-sizing: border-box; }
.row { display: flex; gap: 8px; margin-bottom: 8px; }
button { background: #4f6ef7; color: #fff; border: 0; border-radius: 10px; padding: 12px 16px; font-size: 15px; font-weight: 600; }
button:disabled { opacity: .45; }
button.rm { background: #3a3a42; }
.card { display: flex; align-items: center; gap: 12px; background: #1c1c22; border-radius: 12px; padding: 10px; margin-bottom: 8px; }
.card img { width: 46px; height: 68px; object-fit: cover; border-radius: 6px; background: #2c2c34; flex: none; }
.card .nm { flex: 1; min-width: 0; }
.card .nm b { display: block; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .nm span { font-size: 12px; color: #9a9aa2; }
#msg { padding: 8px 0; font-size: 14px; color: #ff8a8a; min-height: 20px; }
#msg.ok { color: #7ddf9a; }
</style>
</head>
<body>
<h1>🎲 Shuffle config</h1>
<div class="row"><input id="pw" type="password" placeholder="Config password"></div>
<div class="row"><input id="q" type="search" placeholder="Search shows..."><button id="go">Search</button></div>
<div id="msg"></div>
<div id="results"></div>
<h2>Current shows</h2>
<div id="list">Loading...</div>
<script>
var current = {};
var pw = document.getElementById('pw');
pw.value = localStorage.getItem('cfgkey') || '';
pw.addEventListener('input', function () { localStorage.setItem('cfgkey', pw.value); });

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function msg(t, ok) {
  var m = document.getElementById('msg');
  m.textContent = t || '';
  m.className = ok ? 'ok' : '';
}
function api(path, method) {
  return fetch(path, { method: method || 'GET', headers: { 'x-config-key': pw.value } })
    .then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
}
function card(s, btn) {
  var img = s.poster ? '<img src="' + esc(s.poster) + '" loading="lazy" alt="">' : '<img alt="">';
  var sub = s.releaseInfo ? esc(s.releaseInfo) : esc(s.id);
  return '<div class="card">' + img +
    '<div class="nm"><b>' + esc(s.name) + '</b><span>' + sub + '</span></div>' +
    btn + '</div>';
}
function renderList(shows) {
  current = {};
  shows.forEach(function (s) { current[s.id] = true; });
  var el = document.getElementById('list');
  el.innerHTML = shows.length
    ? shows.map(function (s) {
        return card(s, '<button class="rm" data-act="remove" data-id="' + esc(s.id) + '">Remove</button>');
      }).join('')
    : 'No shows yet — search above to add some.';
  document.querySelectorAll('#results button[data-act="add"]').forEach(function (b) {
    if (current[b.getAttribute('data-id')]) { b.disabled = true; b.textContent = 'Added'; }
  });
}
function search() {
  var q = document.getElementById('q').value.trim();
  if (q.length < 2) return;
  msg('Searching...', true);
  api('/api/search?q=' + encodeURIComponent(q)).then(function (j) {
    msg('');
    document.getElementById('results').innerHTML = j.results.length
      ? j.results.map(function (s) {
          var b = current[s.id]
            ? '<button data-act="add" data-id="' + esc(s.id) + '" disabled>Added</button>'
            : '<button data-act="add" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '">Add</button>';
          return card(s, b);
        }).join('')
      : 'No results.';
  }).catch(function (e) { msg(e.message); });
}
document.body.addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!b || b.disabled) return;
  var id = b.getAttribute('data-id');
  if (b.getAttribute('data-act') === 'add') {
    b.disabled = true;
    api('/api/add?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(b.getAttribute('data-name') || ''), 'POST')
      .then(function (j) { msg('Added.', true); renderList(j.shows); })
      .catch(function (e2) { b.disabled = false; msg(e2.message); });
  } else {
    api('/api/remove?id=' + encodeURIComponent(id), 'POST')
      .then(function (j) { msg('Removed.', true); renderList(j.shows); })
      .catch(function (e2) { msg(e2.message); });
  }
});
document.getElementById('go').addEventListener('click', search);
document.getElementById('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
api('/api/shows').then(function (j) { renderList(j.shows); })
  .catch(function (e) { document.getElementById('list').textContent = ''; msg(e.message); });
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
      let out = `${ADDON_NAME}\n\nInstall URL: <this-domain>/manifest.json\nConfig page: <this-domain>/config\n`;
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
      if (shuffleShows.length || storageConfigured()) {
        if (shuffleShows.length) total += 1;
        const storageNote = storageConfigured()
          ? `storage: GitHub ${GITHUB_REPO}`
          : "storage: in-code list — set GITHUB_TOKEN & GITHUB_REPO to edit at /config";
        out += `\n[shuffle] ${SHUFFLE_ROW_NAME} — ${shuffleShows.length} show${shuffleShows.length === 1 ? "" : "s"} (${storageNote})\n`;
        for (const s of shuffleShows) {
          const meta = await getShowMeta(s.id);
          out += meta
            ? `   • ${meta.name} (${s.id})\n`
            : `   x ${s.name || s.id} (${s.id})  (FAILED TO LOAD from Cinemeta)\n`;
        }
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
