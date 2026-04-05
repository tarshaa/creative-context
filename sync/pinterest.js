/**
 * sync/pinterest.js
 *
 * Syncs all saved Pinterest pins using your existing browser session.
 * No API keys required — just be logged into Pinterest in any supported browser.
 *
 * Uses Pinterest's internal v3 API (api.pinterest.com/v3), which works with
 * the same session cookies your browser already has. The older /resource/ API
 * returns 403; v3 returns 200 with the same session.
 *
 * Endpoints used:
 *   GET /v3/users/me/          → username + user info
 *   GET /v3/users/me/boards/   → all boards (paginated)
 *   GET /v3/users/me/pins/     → all saved pins (paginated via bookmark)
 *
 * Usage:
 *   node sync/pinterest.js
 *   node sync/pinterest.js --browser safari
 *   node sync/pinterest.js --browser firefox
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readCookies, buildCookieHeader } from './browser-cookies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR      = join(__dirname, '..', 'data');
const PINS_FILE     = join(DATA_DIR, 'pins.json');
const LAST_SYNC_FILE = join(DATA_DIR, 'last_sync.json');

const API_BASE = 'https://api.pinterest.com/v3';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildHeaders(cookieHeader) {
  return {
    'User-Agent':      USER_AGENT,
    'Accept':          'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://www.pinterest.com/',
    'Cookie':          cookieHeader,
  };
}

async function apiGet(path, params, headers) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pinterest v3 API error ${res.status} at ${path}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.status === 'failure') {
    throw new Error(`Pinterest v3 API failure at ${path}: ${json.message}`);
  }
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paginated fetcher (handles bookmark-based pagination)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllPages(path, baseParams, headers, { label = 'items', pageSize = 100 } = {}) {
  const allItems = [];
  let bookmark = null;
  let page = 1;

  do {
    const params = { ...baseParams, page_size: pageSize };
    if (bookmark) params.bookmark = bookmark;

    const json = await apiGet(path, params, headers);
    const items = json.data ?? [];
    allItems.push(...items);

    bookmark = json.bookmark ?? null;

    process.stdout.write(`\r  Fetched ${allItems.length} ${label}…`);
    page++;

    // Safety valve — Pinterest v3 occasionally returns a bookmark even on the
    // last page; stop if a page comes back empty.
    if (items.length === 0) break;
  } while (bookmark);

  process.stdout.write('\n');
  return allItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// API calls
// ─────────────────────────────────────────────────────────────────────────────

async function getMe(headers) {
  const json = await apiGet('/users/me/', {}, headers);
  const data = json.data;
  if (!data?.id) throw new Error(
    'Could not retrieve Pinterest user info. ' +
    'Your session may have expired — please log in to Pinterest in your browser and try again.'
  );
  return data;
}

async function getBoards(headers) {
  return fetchAllPages(
    '/users/me/boards/',
    { privacy_filter: 'all', field_set_key: 'detailed' },
    headers,
    { label: 'boards', pageSize: 100 }
  );
}

async function getAllPins(headers) {
  return fetchAllPages(
    '/users/me/pins/',
    { field_set_key: 'detailed' },
    headers,
    { label: 'pins', pageSize: 100 }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise a raw v3 pin into a clean local shape
// ─────────────────────────────────────────────────────────────────────────────

function normalisePin(pin, boardMap) {
  const boardId   = pin.board?.id ?? null;
  const boardName = boardMap.get(boardId) ?? pin.board?.name ?? null;

  // v3 API exposes images as direct top-level URL fields rather than a nested object
  const imageUrl =
    pin.image_large_url  ??
    pin.image_medium_url ??
    pin.image_square_url ??
    null;

  const richMeta = pin.rich_metadata ?? pin.rich_metadata_v2 ?? null;

  return {
    id:             pin.id,
    title:          pin.title          ?? pin.grid_title ?? null,
    description:    pin.description    ?? pin.closeup_description ?? null,
    link:           pin.link           ?? pin.tracked_link ?? null,
    note:           pin.closeup_user_note ?? null,
    board_id:       boardId,
    board_name:     boardName,
    created_at:     pin.created_at     ?? null,
    dominant_color: pin.dominant_color ?? null,
    image_url:      imageUrl,
    image_large_url:  pin.image_large_url  ?? null,
    image_medium_url: pin.image_medium_url ?? null,
    image_square_url: pin.image_square_url ?? null,
    media_type:     pin.is_video ? 'video' : (pin.story_pin_data ? 'story' : 'pin'),
    alt_text:       pin.alt_text ?? pin.auto_alt_text ?? pin.seo_alt_text ?? null,
    rich_metadata:  richMeta ? {
      site_name:    richMeta.site_name    ?? null,
      display_name: richMeta.display_name ?? null,
      favicon_link: richMeta.favicon_link ?? null,
      article_publish_time: richMeta.article_publish_time ?? null,
    } : null,
    domain:         pin.domain ?? pin.link_domain ?? null,
    repin_count:    pin.repin_count  ?? null,
    synced_at:      new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const browserArg = process.argv.indexOf('--browser');
  const browser    = browserArg !== -1 ? process.argv[browserArg + 1] : 'auto';

  console.log('Starting Pinterest sync…\n');
  console.log('Reading session cookies from browser…');

  const cookies = await readCookies('pinterest.com', [
    '_pinterest_sess', 'csrftoken', '_auth', '_b', '_routing_id', 'cm_sub',
  ], { browser });

  if (!cookies._pinterest_sess && !cookies._auth) {
    throw new Error(
      'No Pinterest session cookies found.\n' +
      'Please log into Pinterest in your browser and try again.'
    );
  }

  const headers = buildHeaders(buildCookieHeader(cookies));

  console.log('Fetching user info…');
  const me = await getMe(headers);
  console.log(`  Logged in as: @${me.username}  (id: ${me.id})\n`);

  console.log('Fetching boards…');
  const rawBoards = await getBoards(headers);
  console.log(`  Found ${rawBoards.length} board(s).\n`);

  // Build board id → name lookup so we can annotate pins
  const boardMap = new Map(rawBoards.map(b => [b.id, b.name]));

  console.log('Fetching pins…');
  const rawPins = await getAllPins(headers);
  console.log(`  Found ${rawPins.length} pin(s).\n`);

  const pins = rawPins.map(p => normalisePin(p, boardMap));

  const boards = rawBoards.map(b => ({
    id:           b.id,
    name:         b.name,
    url:          b.url,
    category:     b.category,
    layout:       b.layout,
    is_collaborative: b.is_collaborative,
    created_at:   b.created_at,
  }));

  const output = {
    synced_at:    new Date().toISOString(),
    username:     me.username,
    total_boards: boards.length,
    total_pins:   pins.length,
    boards,
    pins,
  };

  writeFileSync(PINS_FILE, JSON.stringify(output, null, 2));
  console.log(`Saved ${pins.length} pins from ${boards.length} boards → ${PINS_FILE}`);

  let lastSync = {};
  try { lastSync = JSON.parse(readFileSync(LAST_SYNC_FILE, 'utf8')); } catch {}
  lastSync.pinterest = new Date().toISOString();
  writeFileSync(LAST_SYNC_FILE, JSON.stringify(lastSync, null, 2));

  console.log('Pinterest sync complete.');
}

main().catch(err => {
  console.error('\nSync failed:', err.message);
  process.exit(1);
});
