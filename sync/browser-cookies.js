/**
 * browser-cookies.js
 *
 * Reads and decrypts cookies directly from Chrome, Brave, Arc, Dia,
 * Firefox, and Safari on macOS. Zero configuration — just be logged in.
 *
 * Chromium-based (Chrome, Brave, Arc, Dia):
 *   - Reads Chrome's AES-128-CBC encrypted SQLite cookie DB
 *   - Derives the key via PBKDF2-SHA1("saltysalt", 1003 iters) from the
 *     Safe Storage password stored in the macOS Keychain
 *
 * Firefox:
 *   - Reads the unencrypted Mozilla SQLite cookie DB
 *   - Detects the active profile from profiles.ini
 *
 * Safari:
 *   - Parses ~/Library/Cookies/Cookies.binarycookies (Apple binary format)
 *
 * Linux / Windows: throws a clear error (different encryption, not yet supported).
 *
 * Exports:
 *   readCookies(domain, cookieNames, options?) → Promise<Record<string,string>>
 *   buildCookieHeader(cookies) → string
 */

import { execFileSync } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { existsSync, copyFileSync, unlinkSync, readFileSync } from 'fs';
import { homedir, platform, tmpdir } from 'os';
import { join } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Browser profile paths
// ─────────────────────────────────────────────────────────────────────────────

const HOME = homedir();

/**
 * All known Chromium-based browser cookie DB paths, in priority order.
 * Each entry: { name, cookiePath, keychainService, keychainAccount }
 */
const CHROMIUM_BROWSERS = [
  {
    name: 'Chrome',
    paths: [
      join(HOME, 'Library/Application Support/Google/Chrome/Default/Cookies'),
      join(HOME, 'Library/Application Support/Google/Chrome/Profile 1/Cookies'),
    ],
    keychain: [
      { service: 'Chrome Safe Storage', account: 'Chrome' },
      { service: 'Google Chrome Safe Storage', account: 'Google Chrome' },
    ],
  },
  {
    name: 'Brave',
    paths: [
      join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'),
      join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser/Profile 1/Cookies'),
    ],
    keychain: [
      { service: 'Brave Safe Storage', account: 'Brave' },
      { service: 'Brave Browser Safe Storage', account: 'Brave Browser' },
    ],
  },
  {
    name: 'Arc',
    paths: [
      join(HOME, 'Library/Application Support/Arc/User Data/Default/Cookies'),
      join(HOME, 'Library/Application Support/Arc/User Data/Profile 1/Cookies'),
    ],
    keychain: [
      { service: 'Arc Safe Storage', account: 'Arc' },
    ],
  },
  {
    name: 'Dia',
    paths: [
      join(HOME, 'Library/Application Support/Dia/User Data/Default/Cookies'),
      join(HOME, 'Library/Application Support/Dia/Default/Cookies'),
    ],
    keychain: [
      { service: 'Dia Safe Storage', account: 'Dia' },
    ],
  },
];

const FIREFOX_PROFILES_INI = join(HOME, 'Library/Application Support/Firefox/profiles.ini');
const SAFARI_COOKIES_FILE = join(HOME, 'Library/Cookies/Cookies.binarycookies');

// ─────────────────────────────────────────────────────────────────────────────
// Chromium: Keychain + PBKDF2 key derivation
// ─────────────────────────────────────────────────────────────────────────────

function getChromiumKey(browser) {
  for (const { service, account } of browser.keychain) {
    try {
      const password = execFileSync(
        'security',
        ['find-generic-password', '-w', '-s', service, '-a', account],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString().trim();

      // Chrome's fixed PBKDF2 parameters
      return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    } catch {
      // try next keychain entry
    }
  }
  throw new Error(
    `Could not retrieve Safe Storage key for ${browser.name} from macOS Keychain. ` +
    `Make sure ${browser.name} has been launched at least once.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chromium: AES-128-CBC cookie decryption
// ─────────────────────────────────────────────────────────────────────────────

function decryptChromiumCookie(encryptedHex, key, dbVersion) {
  if (!encryptedHex || encryptedHex.length === 0) return '';
  const buf = Buffer.from(encryptedHex, 'hex');

  // Chrome-encrypted values are prefixed with "v10" (0x76 0x31 0x30)
  if (buf[0] === 0x76 && buf[1] === 0x31 && buf[2] === 0x30) {
    const iv = Buffer.alloc(16, 0x20); // 16 space characters as IV
    const ciphertext = buf.subarray(3);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Schema version ≥ 24: Chrome prepends SHA256(host_key) — strip 32 bytes
    if (dbVersion >= 24 && decrypted.length > 32) {
      decrypted = decrypted.subarray(32);
    }
    return decrypted.toString('utf8');
  }

  // Fallback: unencrypted value
  return buf.toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite helper (uses sqlite3 CLI, ships with macOS by default)
// ─────────────────────────────────────────────────────────────────────────────

function querySQLite(dbPath, sql) {
  let pathToQuery = dbPath;
  let tempPath = null;

  // If the DB is locked (browser is open), copy to a temp file first
  try {
    execFileSync('sqlite3', [dbPath, 'SELECT 1;'], { stdio: 'pipe' });
  } catch {
    tempPath = join(tmpdir(), `browser-cookies-${Date.now()}.db`);
    copyFileSync(dbPath, tempPath);
    pathToQuery = tempPath;
  }

  try {
    const raw = execFileSync('sqlite3', ['-json', pathToQuery, sql], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    return raw ? JSON.parse(raw) : [];
  } finally {
    if (tempPath) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

function getChromiumDBVersion(dbPath) {
  try {
    const rows = querySQLite(dbPath, "SELECT value FROM meta WHERE key='version';");
    return rows.length ? parseInt(rows[0].value, 10) : 0;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chromium: read cookies
// ─────────────────────────────────────────────────────────────────────────────

function readChromiumCookies(browser, domain, cookieNames) {
  const dbPath = browser.paths.find(existsSync);
  if (!dbPath) return null; // browser not installed / no profile yet

  const key = getChromiumKey(browser);
  const dbVersion = getChromiumDBVersion(dbPath);

  const nameList = cookieNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
  const sql = `
    SELECT name, hex(encrypted_value) AS encrypted_hex, value
    FROM cookies
    WHERE host_key LIKE '%${domain}'
      AND name IN (${nameList});
  `.trim();

  const rows = querySQLite(dbPath, sql);
  if (rows.length === 0) return null; // not logged in with this browser

  const result = {};
  for (const row of rows) {
    try {
      result[row.name] = decryptChromiumCookie(row.encrypted_hex, key, dbVersion)
        || row.value || '';
    } catch (err) {
      console.warn(`Warning: could not decrypt ${browser.name} cookie "${row.name}": ${err.message}`);
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Firefox: detect active profile + read cookies (stored in plaintext)
// ─────────────────────────────────────────────────────────────────────────────

function findFirefoxProfile() {
  if (!existsSync(FIREFOX_PROFILES_INI)) return null;

  const ini = readFileSync(FIREFOX_PROFILES_INI, 'utf8');
  const sections = ini.split(/\[Profile\d+\]/g).slice(1);
  const profilesBase = join(HOME, 'Library/Application Support/Firefox');

  // Prefer the section marked Default=1, fall back to first found
  let defaultPath = null;
  let firstPath = null;

  for (const section of sections) {
    const pathMatch = section.match(/^Path=(.+)$/m);
    const isRelative = /^IsRelative=1$/m.test(section);
    const isDefault = /^Default=1$/m.test(section);
    if (!pathMatch) continue;

    const profilePath = isRelative
      ? join(profilesBase, pathMatch[1].trim())
      : pathMatch[1].trim();

    const cookiesPath = join(profilePath, 'cookies.sqlite');
    if (!existsSync(cookiesPath)) continue;

    if (isDefault) defaultPath = cookiesPath;
    if (!firstPath) firstPath = cookiesPath;
  }

  return defaultPath ?? firstPath;
}

function readFirefoxCookies(domain, cookieNames) {
  const dbPath = findFirefoxProfile();
  if (!dbPath) return null;

  const nameList = cookieNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
  const sql = `
    SELECT name, value FROM moz_cookies
    WHERE host LIKE '%${domain}'
      AND name IN (${nameList});
  `.trim();

  try {
    const rows = querySQLite(dbPath, sql);
    if (rows.length === 0) return null;
    const result = {};
    for (const row of rows) result[row.name] = row.value;
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safari: binary cookie parser
// ─────────────────────────────────────────────────────────────────────────────

function readNullTermString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('utf8', offset, end);
}

function parseSafariBinaryCookies(buf) {
  if (buf.toString('ascii', 0, 4) !== 'cook') {
    throw new Error('Not a valid Safari binary cookies file (missing "cook" magic).');
  }

  const numPages = buf.readUInt32BE(4);
  const pageSizes = [];
  for (let i = 0; i < numPages; i++) {
    pageSizes.push(buf.readUInt32BE(8 + i * 4));
  }

  let pageOffset = 8 + numPages * 4;
  const cookies = [];

  for (let p = 0; p < numPages; p++) {
    const pageStart = pageOffset;
    // Page magic: 0x00000100 (LE), then cookie count (LE)
    const numCookies = buf.readUInt32LE(pageStart + 4);
    const cookieOffsets = [];
    for (let c = 0; c < numCookies; c++) {
      cookieOffsets.push(buf.readUInt32LE(pageStart + 8 + c * 4));
    }

    for (const co of cookieOffsets) {
      const cs = pageStart + co; // cookie start
      try {
        // Record layout (all LE):
        //  0  size (uint32)
        //  4  unknown
        //  8  flags (uint32): 1=Secure, 4=HttpOnly, 5=both
        // 12  unknown
        // 16  domain offset (uint32, relative to record start)
        // 20  name offset
        // 24  path offset
        // 28  value offset
        // 32  expiry (float64, Mac epoch: add 978307200 for Unix)
        // 40  creation (float64)
        // followed by null-terminated strings at their offsets
        const domainOffset = buf.readUInt32LE(cs + 16);
        const nameOffset   = buf.readUInt32LE(cs + 20);
        const valueOffset  = buf.readUInt32LE(cs + 28);

        cookies.push({
          domain: readNullTermString(buf, cs + domainOffset),
          name:   readNullTermString(buf, cs + nameOffset),
          value:  readNullTermString(buf, cs + valueOffset),
        });
      } catch {
        // malformed record — skip
      }
    }

    pageOffset += pageSizes[p];
  }

  return cookies;
}

function readSafariCookies(domain, cookieNames) {
  if (!existsSync(SAFARI_COOKIES_FILE)) return null;

  let allCookies;
  try {
    const buf = readFileSync(SAFARI_COOKIES_FILE);
    allCookies = parseSafariBinaryCookies(buf);
  } catch (err) {
    console.warn(`Warning: could not read Safari cookies: ${err.message}`);
    return null;
  }

  const nameSet = new Set(cookieNames);
  const result = {};
  for (const cookie of allCookies) {
    if (cookie.domain.includes(domain) && nameSet.has(cookie.name)) {
      result[cookie.name] = cookie.value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read cookies for a given domain from whichever browser the user is logged into.
 *
 * @param {string}   domain       - e.g. 'pinterest.com' or 'youtube.com'
 * @param {string[]} cookieNames  - cookie names to extract
 * @param {object}   [options]
 * @param {string}   [options.browser] - 'chrome'|'brave'|'arc'|'dia'|'firefox'|'safari'|'auto'
 *                                       Defaults to 'auto' (tries all in order).
 * @returns {Promise<Record<string, string>>} map of name → decrypted value
 */
export async function readCookies(domain, cookieNames, { browser = 'auto' } = {}) {
  const os = platform();
  if (os !== 'darwin') {
    throw new Error(
      `Browser cookie extraction is currently supported on macOS only.\n` +
      `Detected platform: ${os}\n` +
      `Linux requires libsecret/kwallet integration; Windows requires DPAPI. ` +
      `Neither is yet implemented.`
    );
  }

  const browserName = browser.toLowerCase();

  // Try a specific browser
  if (browserName !== 'auto') {
    if (browserName === 'firefox') {
      const result = readFirefoxCookies(domain, cookieNames);
      if (!result) throw new Error(`No matching ${domain} cookies found in Firefox. Are you logged in?`);
      return result;
    }
    if (browserName === 'safari') {
      const result = readSafariCookies(domain, cookieNames);
      if (!result) throw new Error(`No matching ${domain} cookies found in Safari. Are you logged in?`);
      return result;
    }
    const chromiumBrowser = CHROMIUM_BROWSERS.find((b) => b.name.toLowerCase() === browserName);
    if (!chromiumBrowser) throw new Error(`Unknown browser: "${browser}". Valid options: chrome, brave, arc, dia, firefox, safari, auto`);
    const result = readChromiumCookies(chromiumBrowser, domain, cookieNames);
    if (!result) throw new Error(`No matching ${domain} cookies found in ${chromiumBrowser.name}. Are you logged in?`);
    return result;
  }

  // Auto mode: try all browsers in order, return first match
  const errors = [];

  for (const b of CHROMIUM_BROWSERS) {
    try {
      const result = readChromiumCookies(b, domain, cookieNames);
      if (result) {
        console.log(`  Using ${b.name} session cookies for ${domain}`);
        return result;
      }
    } catch (err) {
      errors.push(`${b.name}: ${err.message}`);
    }
  }

  const ffResult = readFirefoxCookies(domain, cookieNames);
  if (ffResult) {
    console.log(`  Using Firefox session cookies for ${domain}`);
    return ffResult;
  }

  const safariResult = readSafariCookies(domain, cookieNames);
  if (safariResult) {
    console.log(`  Using Safari session cookies for ${domain}`);
    return safariResult;
  }

  throw new Error(
    `No ${domain} session found in any supported browser.\n` +
    `Please log into ${domain} in Chrome, Brave, Arc, Dia, Firefox, or Safari and try again.\n` +
    (errors.length ? `\nDetails:\n${errors.map((e) => `  • ${e}`).join('\n')}` : '')
  );
}

/**
 * Build a Cookie header string from a name→value map.
 * @param {Record<string, string>} cookies
 * @returns {string}
 */
export function buildCookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
