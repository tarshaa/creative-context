/**
 * sync/youtube.js
 *
 * Syncs liked YouTube videos via the official YouTube Data API v3 with OAuth 2.0.
 *
 * First run: opens a browser tab so you can sign in with Google. After you
 * approve, the token is saved locally and reused on every subsequent run.
 * Tokens refresh automatically — you should never need to sign in again.
 *
 * One-time setup (≈ 5 minutes):
 *   1. Go to https://console.cloud.google.com/apis/credentials
 *   2. Create a project → Enable "YouTube Data API v3"
 *   3. Create OAuth 2.0 credentials → Desktop app → Download JSON
 *   4. Save the file as  data/yt_credentials.json
 *      (or set YT_CLIENT_ID + YT_CLIENT_SECRET in a .env file)
 *   5. Run:  node sync/youtube.js
 *
 * Usage:
 *   node sync/youtube.js
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { google } from 'googleapis';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const DATA_DIR       = join(__dirname, '..', 'data');
const VIDEOS_FILE    = join(DATA_DIR, 'videos.json');
const LAST_SYNC_FILE = join(DATA_DIR, 'last_sync.json');
const TOKEN_FILE     = join(DATA_DIR, 'youtube_token.json');
const CREDS_FILE     = join(DATA_DIR, 'yt_credentials.json');

const REDIRECT_PORT = 8765;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES        = ['https://www.googleapis.com/auth/youtube.readonly'];

// ─────────────────────────────────────────────────────────────────────────────
// Credentials — from data/yt_credentials.json or environment variables
// ─────────────────────────────────────────────────────────────────────────────

function loadCredentials() {
  // Try JSON credentials file first
  if (existsSync(CREDS_FILE)) {
    const raw = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
    // Google downloads credentials wrapped in an "installed" or "web" key
    const creds = raw.installed ?? raw.web ?? raw;
    return { clientId: creds.client_id, clientSecret: creds.client_secret };
  }

  // Fall back to environment variables
  const clientId     = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  YouTube credentials not found.

  One-time setup (≈ 5 minutes):

  1. Open https://console.cloud.google.com/apis/credentials
  2. Create a project (or pick an existing one)
  3. Click "Enable APIs" → search for "YouTube Data API v3" → Enable
  4. Go back to Credentials → Create Credentials → OAuth client ID
  5. Application type: Desktop app  →  Create
  6. Click the download button (↓) next to your new client
  7. Save the downloaded file as:
       ${CREDS_FILE}

  Then run  npm run sync:youtube  again.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth flow — open browser, wait for callback, save token
// ─────────────────────────────────────────────────────────────────────────────

function openBrowser(url) {
  try { execSync(`open ${JSON.stringify(url)}`); }
  catch { console.log(`\n  Open this URL in your browser:\n  ${url}\n`); }
}

async function runOAuthFlow(auth) {
  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // ensure refresh_token is returned
  });

  console.log('\nOpening browser for Google sign-in…');
  openBrowser(authUrl);

  // Local server to catch the redirect
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url  = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const err  = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<html><body><h2>✓ Signed in — you can close this tab.</h2></body></html>');
        server.close();
        resolve(code);
      } else {
        res.end('<html><body><h2>Sign-in failed. Check the terminal.</h2></body></html>');
        server.close();
        reject(new Error(`OAuth error: ${err ?? 'unknown'}`));
      }
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`  Waiting for Google sign-in… (listening on port ${REDIRECT_PORT})`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth sign-in timed out after 5 minutes.'));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('  Signed in and token saved.\n');
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build authenticated OAuth2 client
// ─────────────────────────────────────────────────────────────────────────────

async function getAuthClient() {
  const { clientId, clientSecret } = loadCredentials();

  const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  if (existsSync(TOKEN_FILE)) {
    const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    auth.setCredentials(saved);

    // Persist refreshed tokens automatically
    auth.on('tokens', (tokens) => {
      const merged = { ...saved, ...tokens };
      writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2));
    });
  } else {
    await runOAuthFlow(auth);
  }

  return auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch all liked videos via YouTube Data API v3
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLikedVideos(auth) {
  const yt = google.youtube({ version: 'v3', auth });
  const videos = [];
  let pageToken = undefined;
  let page = 1;

  do {
    const res = await yt.videos.list({
      part: ['snippet', 'contentDetails', 'statistics'],
      myRating: 'like',
      maxResults: 50,
      pageToken,
    });

    const items = res.data.items ?? [];
    for (const item of items) {
      videos.push(normaliseVideo(item));
    }

    console.log(`  Page ${page}: +${items.length} videos (${videos.length} total)`);
    pageToken = res.data.nextPageToken;
    page++;
  } while (pageToken);

  return videos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise API response into local shape
// ─────────────────────────────────────────────────────────────────────────────

function normaliseVideo(item) {
  const s = item.snippet ?? {};
  const d = item.contentDetails ?? {};
  const st = item.statistics ?? {};

  // Best thumbnail: maxres → high → medium → default
  const thumbKeys = ['maxres', 'high', 'medium', 'standard', 'default'];
  const thumbnail = thumbKeys.map(k => s.thumbnails?.[k]?.url).find(Boolean) ?? null;

  return {
    id:              item.id,
    url:             `https://www.youtube.com/watch?v=${item.id}`,
    title:           s.title           ?? null,
    channel_title:   s.channelTitle    ?? null,
    channel_url:     s.channelId ? `https://www.youtube.com/channel/${s.channelId}` : null,
    thumbnail,
    duration:        d.duration        ?? null, // ISO 8601, e.g. PT4M13S
    published_at:    s.publishedAt     ?? null,
    description:     s.description     ?? null,
    tags:            s.tags            ?? [],
    view_count:      st.viewCount      ?? null,
    like_count:      st.likeCount      ?? null,
    synced_at:       new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('Starting YouTube sync…\n');

  const auth = await getAuthClient();

  console.log('Fetching liked videos…');
  const videos = await fetchLikedVideos(auth);

  const output = {
    synced_at:    new Date().toISOString(),
    total_videos: videos.length,
    videos,
  };

  writeFileSync(VIDEOS_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${videos.length} liked videos → ${VIDEOS_FILE}`);

  let lastSync = {};
  try { lastSync = JSON.parse(readFileSync(LAST_SYNC_FILE, 'utf8')); } catch {}
  lastSync.youtube = new Date().toISOString();
  writeFileSync(LAST_SYNC_FILE, JSON.stringify(lastSync, null, 2));

  console.log('YouTube sync complete.');
}

main().catch(err => {
  console.error('\nSync failed:', err.message);
  process.exit(1);
});
