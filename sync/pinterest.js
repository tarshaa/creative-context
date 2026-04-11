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
 *   GET /v3/users/me/              → username + user info
 *   GET /v3/users/me/boards/       → all boards including secret (paginated)
 *   GET /v3/users/me/pins/         → public + protected pins (paginated)
 *   GET /v3/boards/{id}/pins/      → pins on secret boards (per-board, paginated)
 *
 * Secret boards: the /users/me/pins/ endpoint omits pins that live on secret
 * boards. We detect secret boards from the boards response and fetch their pins
 * separately via the per-board endpoint, then merge everything by pin ID.
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

const API_BASE      = 'https://api.pinterest.com/v3';
const RESOURCE_BASE = 'https://www.pinterest.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildHeaders(cookieHeader, csrfToken) {
  const h = {
    'User-Agent':      USER_AGENT,
    'Accept':          'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://www.pinterest.com/',
    'Cookie':          cookieHeader,
  };
  // Pinterest requires X-CSRFToken for many authenticated endpoints
  if (csrfToken) h['X-CSRFToken'] = csrfToken;
  return h;
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

/**
 * Fetch boards via Pinterest's /resource/ API at www.pinterest.com using POST.
 *
 * GET requests to this endpoint return 403 when made from outside a browser.
 * POST with the correct browser-style headers (Origin, Sec-Fetch-*, etc.) returns
 * all boards including secret ones — this is the endpoint the Pinterest web app
 * actually uses.
 *
 * Requires the FULL cookie jar for the domain (not just the 6 auth cookies).
 */
async function getBoardsViaResourceAPI(username, fullCookieHeader, csrfToken) {
  const ajaxHeaders = {
    'User-Agent':        USER_AGENT,
    'Accept':            'application/json, text/javascript, */*; q=0.01',
    'Accept-Language':   'en-US,en;q=0.9',
    'Content-Type':      'application/x-www-form-urlencoded',
    'Origin':            'https://www.pinterest.com',
    'Referer':           `https://www.pinterest.com/${username}/boards/`,
    'X-Requested-With':  'XMLHttpRequest',
    'Sec-Fetch-Site':    'same-origin',
    'Sec-Fetch-Mode':    'cors',
    'Sec-Fetch-Dest':    'empty',
    'Cookie':            fullCookieHeader,
  };
  if (csrfToken) ajaxHeaders['X-CSRFToken'] = csrfToken;

  const data = JSON.stringify({
    options: { username, page_size: 250, privacy_filter: 'all', field_set_key: 'detailed' },
    context: {},
  });
  const body = new URLSearchParams({ data, source_url: `/${username}/boards/` });

  const res = await fetch(`${RESOURCE_BASE}/resource/BoardsResource/get/`, {
    method:  'POST',
    headers: ajaxHeaders,
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BoardsResource POST ${res.status}: ${text.slice(0, 120)}`);
  }

  const json = await res.json();
  if (json.status === 'failure') throw new Error(`BoardsResource failure: ${json.message}`);

  return json.resource_response?.data ?? [];
}

/**
 * Fetch all boards — public and secret.
 *
 * The www.pinterest.com resource API (POST) is the only endpoint that returns
 * secret boards with cookie-based auth. The v3 API is tried as a fallback in
 * case the resource API is unavailable.
 */
async function getAllBoards(username, headers, fullCookieHeader, csrfToken) {
  const seen = new Map(); // board id → raw board object

  function merge(boards, label) {
    let added = 0;
    for (const board of boards) {
      if (board?.id && !seen.has(board.id)) {
        seen.set(board.id, board);
        added++;
      }
    }
    if (added > 0) console.log(`  [${label}] +${added} board(s)`);
    return added;
  }

  // ── Primary: resource API POST (returns secret boards) ───────────────────
  try {
    const boards = await getBoardsViaResourceAPI(username, fullCookieHeader, csrfToken);
    merge(boards, 'resource API (primary)');
  } catch (err) {
    console.log(`  [resource API] failed: ${err.message.slice(0, 120)}`);

    // ── Fallback: v3 API (public boards only) ────────────────────────────
    console.log('  Falling back to v3 API (secret boards will not be included)…');
    try {
      const boards = await fetchAllPages('/users/me/boards/', { privacy_filter: 'all', field_set_key: 'detailed' }, headers, { label: 'boards', pageSize: 100 });
      merge(boards, 'v3 fallback');
    } catch (err2) {
      console.log(`  [v3 fallback] failed: ${err2.message.slice(0, 80)}`);
    }
  }

  return Array.from(seen.values());
}


async function getAllPins(headers) {
  return fetchAllPages(
    '/users/me/pins/',
    { field_set_key: 'detailed' },
    headers,
    { label: 'pins', pageSize: 100 }
  );
}

/**
 * Fetch pins for a specific board via the v3 board pins endpoint.
 *
 * NOTE: This returns 401 for secret boards. Pinterest's API strictly requires
 * OAuth with `pins:read_secret` scope to read secret board pins — cookie-based
 * auth is explicitly blocked. Public board pins work fine here.
 */
async function getBoardPins(boardId, headers) {
  return fetchAllPages(
    `/boards/${boardId}/pins/`,
    { field_set_key: 'detailed' },
    headers,
    { label: `pins (board ${boardId})`, pageSize: 100 }
  );
}

/**
 * Returns true if a board from the v3 API response is secret.
 * Pinterest has used several field names across v3 API versions.
 */
function isBoardSecret(board) {
  if (board.privacy === 'secret') return true;
  if (board.is_secret === true) return true;
  if (board.type === 'secret') return true;
  // Some v3 responses nest privacy info under a "board_type" or "privacy_type" key
  if (board.board_type === 'secret') return true;
  if (board.privacy_type === 'secret') return true;
  return false;
}

/**
 * Log the raw privacy-related fields of each board so you can see exactly
 * what the API is returning. Activated by --debug flag.
 */
function debugBoards(boards) {
  const PRIVACY_FIELDS = ['privacy', 'is_secret', 'type', 'board_type', 'privacy_type', 'visibility'];
  console.log('\n  ── Raw board privacy fields ──');
  for (const b of boards) {
    const fields = PRIVACY_FIELDS
      .filter(f => b[f] !== undefined)
      .map(f => `${f}=${JSON.stringify(b[f])}`)
      .join('  ');
    console.log(`  [${b.id}] "${b.name}"  ${fields || '(none of the known fields present)'}`);
  }
  console.log('  ─────────────────────────────\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise a raw v3 pin into a clean local shape
// ─────────────────────────────────────────────────────────────────────────────

function normalisePin(pin, boardMap, secretBoardIds) {
  const boardId   = pin.board?.id ?? null;
  const boardName = boardMap.get(boardId) ?? pin.board?.name ?? null;
  const boardSecret = secretBoardIds.has(boardId);

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
    board_secret:   boardSecret,
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

async function checkAllBrowserSessions() {
  console.log('Scanning all browsers for Pinterest sessions…\n');
  const browsers = ['chrome', 'brave', 'arc', 'dia', 'firefox', 'safari'];
  for (const b of browsers) {
    try {
      const cookies = await readCookies('pinterest.com', [
        '_pinterest_sess', 'csrftoken', '_auth', '_b', '_routing_id', 'cm_sub',
      ], { browser: b });
      if (!cookies._pinterest_sess && !cookies._auth) {
        console.log(`  ${b.padEnd(8)} — cookies found but no session (_pinterest_sess/_auth missing)`);
        continue;
      }
      const headers = buildHeaders(buildCookieHeader(cookies), cookies.csrftoken);
      try {
        const me = await getMe(headers);
        console.log(`  ${b.padEnd(8)} — logged in as @${me.username}  (id: ${me.id})`);
      } catch {
        console.log(`  ${b.padEnd(8)} — session cookie present but API call failed (expired?)`);
      }
    } catch {
      console.log(`  ${b.padEnd(8)} — no Pinterest session found`);
    }
  }
  console.log('\nRun with --browser <name> to sync from a specific browser.');
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const browserArg = process.argv.indexOf('--browser');
  const browser    = browserArg !== -1 ? process.argv[browserArg + 1] : 'auto';
  const debug      = process.argv.includes('--debug');

  if (process.argv.includes('--check-browsers')) {
    return checkAllBrowserSessions();
  }

  console.log('Starting Pinterest sync…\n');
  console.log('Reading session cookies from browser…');

  // Read the specific auth cookies needed for the v3 API
  const cookies = await readCookies('pinterest.com', [
    '_pinterest_sess', 'csrftoken', '_auth', '_b', '_routing_id', 'cm_sub',
  ], { browser });

  // Read ALL Pinterest cookies for the resource API — it validates the full
  // cookie jar (same as what the browser sends) and rejects partial sets.
  const allCookies = await readCookies('pinterest.com', [], { browser });

  if (!cookies._pinterest_sess && !cookies._auth) {
    throw new Error(
      'No Pinterest session cookies found.\n' +
      'Please log into Pinterest in your browser and try again.'
    );
  }

  const cookieHeader = buildCookieHeader(cookies);
  const headers      = buildHeaders(cookieHeader, cookies.csrftoken);

  console.log('Fetching user info…');
  const me = await getMe(headers);
  console.log(`  Logged in as: @${me.username}  (id: ${me.id})\n`);

  // ── Fetch pins FIRST ──────────────────────────────────────────────────────
  // The resource API POST (used for board discovery below) degrades the v3
  // session, causing /users/me/pins/ to return only ~12 pins instead of the
  // full set. Fetching pins before the resource API call avoids this.
  console.log('Fetching pins…');
  const publicPins = await getAllPins(headers);
  console.log(`  Found ${publicPins.length} pin(s).\n`);

  // ── Then fetch boards (including the resource API POST) ───────────────────
  const fullCookieHeader = buildCookieHeader(allCookies);

  console.log('Fetching boards…');
  const rawBoards = await getAllBoards(me.username, headers, fullCookieHeader, cookies.csrftoken);

  if (debug) debugBoards(rawBoards);

  // Separate secret from public/protected boards
  const secretBoards = rawBoards.filter(isBoardSecret);
  const publicBoards  = rawBoards.filter(b => !isBoardSecret(b));
  console.log(`  Found ${rawBoards.length} board(s) total: ${publicBoards.length} public, ${secretBoards.length} secret.\n`);

  if (rawBoards.length > 0 && secretBoards.length === 0) {
    console.log('  ⚠  No secret boards detected. Run with --debug to inspect the raw board fields');
    console.log('     and verify which field Pinterest uses to mark boards as secret.\n');
  }

  // Build lookup maps
  const boardMap       = new Map(rawBoards.map(b => [b.id, b.name]));
  const secretBoardIds = new Set(secretBoards.map(b => b.id));

  // Fetch pins from each secret board separately — the user feed omits them
  const pinById = new Map(publicPins.map(p => [p.id, p]));

  if (secretBoards.length > 0) {
    console.log(
      `Note: ${secretBoards.length} secret board(s) found but cannot be synced.\n` +
      `Pinterest requires official OAuth for secret board access.\n` +
      `Only public boards are included.\n`
    );
  }

  const rawPins = Array.from(pinById.values());
  const pins = rawPins.map(p => normalisePin(p, boardMap, secretBoardIds));

  // Build per-board pin count for summary
  const pinsByBoard = new Map();
  for (const pin of pins) {
    const bid = pin.board_id;
    pinsByBoard.set(bid, (pinsByBoard.get(bid) ?? 0) + 1);
  }

  const boards = rawBoards.map(b => ({
    id:           b.id,
    name:         b.name,
    url:          b.url,
    category:     b.category,
    layout:       b.layout,
    secret:       isBoardSecret(b),
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

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('─'.repeat(52));
  console.log('Sync summary');
  console.log('─'.repeat(52));
  for (const board of boards) {
    if (board.secret) {
      console.log(`  ✗  "${board.name}"  (secret — skipped)`);
    } else {
      const count = pinsByBoard.get(board.id) ?? 0;
      console.log(`  ✓  "${board.name}"  ${count} pin(s)`);
    }
  }
  console.log('─'.repeat(52));
  console.log(`  ${pins.length} pin(s) synced from ${publicBoards.length} public board(s)`);
  if (secretBoards.length > 0) {
    console.log(`  ${secretBoards.length} secret board(s) skipped (Pinterest OAuth required)`);
  }
  console.log(`  Saved → ${PINS_FILE}`);
  console.log('─'.repeat(52));

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
