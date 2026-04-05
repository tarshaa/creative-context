/**
 * sync/youtube.js
 *
 * Syncs all liked YouTube videos using your existing browser session.
 * No API keys required — just be logged into YouTube in any supported browser.
 *
 * Uses YouTube's internal InnerTube API (the same one the browser uses at
 * youtube.com/youtubei/v1). Authenticates via the SAPISID cookie + a
 * SAPISIDHASH Authorization header, exactly as the browser does.
 *
 * Usage:
 *   node sync/youtube.js
 *   node sync/youtube.js --browser safari
 *   node sync/youtube.js --browser firefox
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readCookies, buildCookieHeader } from './browser-cookies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const VIDEOS_FILE = join(DATA_DIR, 'videos.json');
const LAST_SYNC_FILE = join(DATA_DIR, 'last_sync.json');

const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1';
const INNERTUBE_ORIGIN = 'https://www.youtube.com';

// YouTube embeds this key in the page source; it's the same for all web clients.
// Update if requests start returning 403.
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Web client context — update clientVersion if requests fail
const INNERTUBE_CONTEXT = {
  client: {
    hl: 'en',
    gl: 'US',
    clientName: 'WEB',
    clientVersion: '2.20240415.01.00',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36,gzip(gfe)',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the SAPISIDHASH Authorization header that YouTube's web client
 * sends on every authenticated request.
 *
 * Format: SAPISIDHASH {timestamp}_{SHA1(timestamp + " " + SAPISID + " " + origin)}
 */
function buildSAPISIDHASH(sapisid) {
  const ts = Math.floor(Date.now() / 1000);
  const hash = createHash('sha1')
    .update(`${ts} ${sapisid} ${INNERTUBE_ORIGIN}`)
    .digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

function buildHeaders(cookies, sapisid) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': INNERTUBE_ORIGIN,
    'Referer': INNERTUBE_ORIGIN + '/',
    'Authorization': buildSAPISIDHASH(sapisid),
    'X-Youtube-Bootstrap-Logged-In': 'true',
    'X-Goog-AuthUser': '0',
    'X-Origin': INNERTUBE_ORIGIN,
    'Cookie': buildCookieHeader(cookies),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// InnerTube request wrapper
// ─────────────────────────────────────────────────────────────────────────────

async function innerTubePost(endpoint, body, headers) {
  const url = `${INNERTUBE_BASE}/${endpoint}?key=${INNERTUBE_API_KEY}&prettyPrint=false`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ context: INNERTUBE_CONTEXT, ...body }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`InnerTube ${endpoint} error ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract video items from an InnerTube browse response
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate the deeply nested InnerTube response to find the
 * playlistVideoListRenderer that contains video items.
 */
function extractVideoList(json) {
  // Initial browse response path
  const tabs =
    json?.contents?.twoColumnBrowseResultsRenderer?.tabs ??
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];

  for (const tab of tabs) {
    const content = tab?.tabRenderer?.content;
    const sections =
      content?.sectionListRenderer?.contents ??
      content?.richGridRenderer?.contents ?? [];

    for (const section of sections) {
      const items =
        section?.itemSectionRenderer?.contents ??
        section?.richSectionRenderer?.content?.richShelfRenderer?.contents ?? [];

      for (const item of items) {
        const pvl = item?.playlistVideoListRenderer;
        if (pvl) return pvl;
      }
    }
  }
  return null;
}

/**
 * From a continuation (paginated) response, extract the list of items
 * returned by the appendContinuationItemsAction.
 */
function extractContinuationItems(json) {
  const actions = json?.onResponseReceivedActions ?? [];
  for (const action of actions) {
    const items = action?.appendContinuationItemsAction?.continuationItems;
    if (items) return items;
  }
  return [];
}

/**
 * Pull the continuation token from the last item in a contents array
 * if it is a continuationItemRenderer.
 */
function extractContinuationToken(items) {
  if (!items?.length) return null;
  const last = items[items.length - 1];
  return (
    last?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ??
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise a playlistVideoRenderer into a clean local shape
// ─────────────────────────────────────────────────────────────────────────────

function normaliseVideo(renderer) {
  const videoId = renderer?.videoId;
  if (!videoId) return null;

  // Title — either a runs array or a simpleText
  const titleRuns = renderer?.title?.runs ?? [];
  const title = titleRuns.map((r) => r.text).join('') || renderer?.title?.simpleText || null;

  // Channel name
  const channelRuns = renderer?.shortBylineText?.runs ?? renderer?.longBylineText?.runs ?? [];
  const channelTitle = channelRuns.map((r) => r.text).join('') || null;
  const channelUrl = channelRuns[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ?? null;

  // Thumbnails — pick the highest resolution available
  const thumbnails = renderer?.thumbnail?.thumbnails ?? [];
  const thumbnail = thumbnails.reduce(
    (best, t) => (!best || (t.width ?? 0) > (best.width ?? 0) ? t : best),
    null
  )?.url ?? null;

  // Duration
  const duration =
    renderer?.lengthText?.simpleText ??
    renderer?.lengthText?.accessibility?.accessibilityData?.label ??
    null;

  // View count
  const viewCountText =
    renderer?.viewCountText?.simpleText ??
    renderer?.shortViewCountText?.simpleText ??
    null;

  // Published / added-to-playlist time
  const publishedText =
    renderer?.publishedTimeText?.simpleText ??
    null;

  return {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    channel_title: channelTitle,
    channel_url: channelUrl ? `https://www.youtube.com${channelUrl}` : null,
    thumbnail,
    duration,
    view_count_text: viewCountText,
    published_text: publishedText,
    synced_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch all liked videos (handles pagination via continuation tokens)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllLikedVideos(headers) {
  const videos = [];

  // Initial request — browse the "Liked videos" feed
  console.log('  Fetching liked videos feed...');
  const initial = await innerTubePost('browse', { browseId: 'FEmy_liked_videos' }, headers);

  const pvl = extractVideoList(initial);
  if (!pvl) {
    // Fallback: try browsing the liked playlist directly (playlistId = LL)
    return fetchLikedPlaylist(headers);
  }

  let items = pvl.contents ?? [];
  let continuationToken = extractContinuationToken(items);

  // Collect non-continuation items from first page
  for (const item of items) {
    const renderer = item?.playlistVideoRenderer ?? item?.richItemRenderer?.content?.videoRenderer;
    const video = renderer ? normaliseVideo(renderer) : null;
    if (video) videos.push(video);
  }

  console.log(`  Page 1: ${videos.length} videos`);

  // Paginate
  let page = 2;
  while (continuationToken) {
    const cont = await innerTubePost('browse', { continuation: continuationToken }, headers);
    const contItems = extractContinuationItems(cont);
    continuationToken = extractContinuationToken(contItems);

    let pageCount = 0;
    for (const item of contItems) {
      const renderer =
        item?.playlistVideoRenderer ??
        item?.richItemRenderer?.content?.videoRenderer;
      const video = renderer ? normaliseVideo(renderer) : null;
      if (video) { videos.push(video); pageCount++; }
    }

    console.log(`  Page ${page}: +${pageCount} videos (${videos.length} total)`);
    page++;
  }

  return videos;
}

/**
 * Fallback: fetch liked videos directly via the LL playlist browse.
 */
async function fetchLikedPlaylist(headers) {
  const videos = [];

  const initial = await innerTubePost(
    'browse',
    { browseId: 'VLL', params: 'wgYIARAA' },
    headers
  );

  const pvl = extractVideoList(initial);
  let items = pvl?.contents ?? [];
  let continuationToken = extractContinuationToken(items);

  for (const item of items) {
    const renderer = item?.playlistVideoRenderer;
    const video = renderer ? normaliseVideo(renderer) : null;
    if (video) videos.push(video);
  }

  console.log(`  Page 1: ${videos.length} videos`);

  let page = 2;
  while (continuationToken) {
    const cont = await innerTubePost('browse', { continuation: continuationToken }, headers);
    const contItems = extractContinuationItems(cont);
    continuationToken = extractContinuationToken(contItems);

    let pageCount = 0;
    for (const item of contItems) {
      const renderer = item?.playlistVideoRenderer;
      const video = renderer ? normaliseVideo(renderer) : null;
      if (video) { videos.push(video); pageCount++; }
    }

    console.log(`  Page ${page}: +${pageCount} videos (${videos.length} total)`);
    page++;
  }

  return videos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  // Parse --browser flag
  const browserArg = process.argv.indexOf('--browser');
  const browser = browserArg !== -1 ? process.argv[browserArg + 1] : 'auto';

  console.log('Starting YouTube sync...\n');
  console.log('Reading session cookies from browser...');

  // YouTube's SAPISID is stored on .google.com, but we also need the youtube.com cookies.
  // Try both domains — most browsers store them separately.
  const YOUTUBE_COOKIES = [
    'SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID',
    'SID', 'HSID', 'SSID',
    '__Secure-1PSID', '__Secure-3PSID',
    'LOGIN_INFO', 'PREF',
  ];

  let cookies = {};

  // Try youtube.com first
  try {
    const ytCookies = await readCookies('youtube.com', YOUTUBE_COOKIES, { browser });
    Object.assign(cookies, ytCookies);
  } catch {
    // will fail if not logged in, caught below
  }

  // Also grab google.com cookies (SAPISID often lives here)
  try {
    const gCookies = await readCookies('google.com', YOUTUBE_COOKIES, { browser });
    // Prefer youtube.com cookies for any overlap
    for (const [k, v] of Object.entries(gCookies)) {
      if (!cookies[k]) cookies[k] = v;
    }
  } catch {
    // ok if google.com cookies aren't found separately
  }

  // SAPISID is the one we absolutely need for the auth header
  const sapisid =
    cookies.SAPISID ??
    cookies.__Secure_3PAPISID ??
    cookies['__Secure-3PAPISID'] ??
    cookies['__Secure-1PAPISID'] ??
    null;

  if (!sapisid) {
    throw new Error(
      'YouTube SAPISID cookie not found. ' +
      'Please log into YouTube in your browser and try again.'
    );
  }

  console.log('  Session found. Building auth headers...\n');

  const headers = buildHeaders(cookies, sapisid);

  console.log('Fetching liked videos...');
  const videos = await fetchAllLikedVideos(headers);

  if (videos.length === 0) {
    console.warn(
      '\nWarning: no videos were returned. Possible reasons:\n' +
      '  • Your liked videos playlist is empty\n' +
      '  • The session cookie has expired (try logging out and back in)\n' +
      '  • YouTube changed the InnerTube response structure\n' +
      '  • The INNERTUBE_CONTEXT clientVersion may need updating'
    );
  }

  const output = {
    synced_at: new Date().toISOString(),
    total_videos: videos.length,
    videos,
  };

  writeFileSync(VIDEOS_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${videos.length} liked videos → ${VIDEOS_FILE}`);

  // Update last_sync
  let lastSync = {};
  try { lastSync = JSON.parse(readFileSync(LAST_SYNC_FILE, 'utf8')); } catch {}
  lastSync.youtube = new Date().toISOString();
  writeFileSync(LAST_SYNC_FILE, JSON.stringify(lastSync, null, 2));

  console.log('YouTube sync complete.');
}

main().catch((err) => {
  console.error('\nSync failed:', err.message);
  process.exit(1);
});
