/**
 * server/viz.js
 *
 * Generates a human-readable breakdown of the local reference library —
 * boards, channels, colors, topics — formatted as text Claude can present.
 */

import { loadData } from './search.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Count occurrences of a key across an array of objects. */
function countBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Render a horizontal bar given a count and a max. */
function bar(count, max, width = 24) {
  const filled = Math.round((count / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Format a percentage. */
function pct(n, total) {
  return total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

/** Render a ranked list with bars. */
function renderRanked(entries, total, { label = 'Item', topN = 12, barWidth = 20 } = {}) {
  if (entries.length === 0) return `  (none)\n`;
  const max = entries[0][1];
  const rows = entries.slice(0, topN).map(([name, count]) => {
    const b = bar(count, max, barWidth);
    const p = pct(count, total);
    return `  ${b}  ${count.toString().padStart(4)}  ${p.padStart(4)}  ${name}`;
  });
  if (entries.length > topN) {
    rows.push(`  … and ${entries.length - topN} more ${label.toLowerCase()}s`);
  }
  return rows.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour grouping
// Dominant colours come in as hex codes — map them to broad colour families.
// ─────────────────────────────────────────────────────────────────────────────

function hexToColorFamily(hex) {
  if (!hex) return null;
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return 'other';

  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;
  const saturation = max === min ? 0 : (max - min) / (lightness > 0.5 ? 2 - max / 255 - min / 255 : max / 255 + min / 255);

  if (lightness > 0.88) return '⬜ white / near-white';
  if (lightness < 0.12) return '⬛ black / near-black';
  if (saturation < 0.12) return '▪️  grey / neutral';

  // Hue calculation
  const dr = (max - r) / (max - min);
  const dg = (max - g) / (max - min);
  const db = (max - b) / (max - min);

  let hue = 0;
  if (r === max)      hue = db - dg;
  else if (g === max) hue = 2 + dr - db;
  else                hue = 4 + dg - dr;

  hue = ((hue * 60) + 360) % 360;

  if (lightness > 0.6 && saturation < 0.3) return '🤍 light neutral / off-white';

  if (hue < 15)  return '🔴 red';
  if (hue < 35)  return '🟠 orange';
  if (hue < 65)  return '🟡 yellow';
  if (hue < 160) return '🟢 green';
  if (hue < 195) return '🩵 cyan / teal';
  if (hue < 255) return '🔵 blue';
  if (hue < 300) return '🟣 purple / violet';
  if (hue < 340) return '🩷 pink / magenta';
  return '🔴 red';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pinterest breakdown
// ─────────────────────────────────────────────────────────────────────────────

function pinsBreakdown(pins, boards) {
  if (pins.length === 0) return '  No pins synced yet. Run: npm run sync:pinterest\n';

  const byBoard   = countBy(pins,  (p) => p.board_name);
  const byColor   = countBy(pins,  (p) => hexToColorFamily(p.dominant_color));
  const byDomain  = countBy(pins,  (p) => p.rich_metadata?.site_name ?? extractDomain(p.link));
  const withImage = pins.filter((p) => p.image_url).length;
  const withLink  = pins.filter((p) => p.link).length;

  const lines = [];
  lines.push(`  Total pins: ${pins.length}  across ${boards.length} board${boards.length !== 1 ? 's' : ''}`);
  lines.push(`  With image: ${withImage}  (${pct(withImage, pins.length)})   With link: ${withLink}  (${pct(withLink, pins.length)})\n`);

  lines.push('  ── By board ──');
  lines.push(renderRanked(byBoard, pins.length, { label: 'Board', topN: 15 }));

  lines.push('  ── By dominant colour ──');
  lines.push(renderRanked(byColor, pins.length, { label: 'Colour', topN: 10, barWidth: 16 }));

  if (byDomain.filter(([d]) => d).length > 0) {
    lines.push('  ── By source site ──');
    lines.push(renderRanked(byDomain.filter(([d]) => d), pins.length, { label: 'Site', topN: 10, barWidth: 16 }));
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube breakdown
// ─────────────────────────────────────────────────────────────────────────────

function videosBreakdown(videos) {
  if (videos.length === 0) return '  No videos synced yet. Run: npm run sync:youtube\n';

  const byChannel = countBy(videos, (v) => v.channel_title);
  const byTopic   = countBy(videos, (v) => v.topic_categories?.[0] ?? null);

  // Duration bucketing
  const durationBuckets = { '< 5 min': 0, '5–15 min': 0, '15–30 min': 0, '30–60 min': 0, '> 1 hour': 0, unknown: 0 };
  for (const video of videos) {
    const secs = parseDurationToSeconds(video.duration);
    if (secs === null)       durationBuckets['unknown']++;
    else if (secs < 300)     durationBuckets['< 5 min']++;
    else if (secs < 900)     durationBuckets['5–15 min']++;
    else if (secs < 1800)    durationBuckets['15–30 min']++;
    else if (secs < 3600)    durationBuckets['30–60 min']++;
    else                     durationBuckets['> 1 hour']++;
  }
  const durationEntries = Object.entries(durationBuckets).filter(([, c]) => c > 0);
  const maxDuration = Math.max(...durationEntries.map(([, c]) => c));

  const lines = [];
  lines.push(`  Total liked videos: ${videos.length}\n`);

  lines.push('  ── By channel ──');
  lines.push(renderRanked(byChannel, videos.length, { label: 'Channel', topN: 15 }));

  if (byTopic.length > 0) {
    lines.push('  ── By topic category ──');
    lines.push(renderRanked(byTopic, videos.length, { label: 'Topic', topN: 10, barWidth: 16 }));
  }

  lines.push('  ── By duration ──');
  lines.push(durationEntries.map(([label, count]) =>
    `  ${bar(count, maxDuration, 16)}  ${count.toString().padStart(4)}  ${pct(count, videos.length).padStart(4)}  ${label}`
  ).join('\n') + '\n');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public viz entry point
// ─────────────────────────────────────────────────────────────────────────────

export function generateViz() {
  const { pins, boards, videos, pinsSync, videosSync } = loadData();

  const syncInfo = [
    pinsSync   ? `Pinterest synced: ${new Date(pinsSync).toLocaleDateString()}` : 'Pinterest: not synced',
    videosSync ? `YouTube synced: ${new Date(videosSync).toLocaleDateString()}` : 'YouTube: not synced',
  ].join('   ');

  const lines = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║              creative-context  ·  reference library          ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `  ${syncInfo}`,
    '',
    '┌─ Pinterest pins ──────────────────────────────────────────────',
    '',
    pinsBreakdown(pins, boards),
    '┌─ YouTube liked videos ───────────────────────────────────────',
    '',
    videosBreakdown(videos),
    '└──────────────────────────────────────────────────────────────',
    '',
    `  Combined library: ${pins.length + videos.length} references`,
    '',
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function extractDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Parse duration strings like "4:20", "1:02:33", "4m 20s", "PT4M20S" → seconds. */
function parseDurationToSeconds(str) {
  if (!str) return null;

  // HH:MM:SS or MM:SS
  const colonMatch = str.match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (colonMatch) {
    const h = parseInt(colonMatch[1] ?? 0);
    const m = parseInt(colonMatch[2]);
    const s = parseInt(colonMatch[3]);
    return h * 3600 + m * 60 + s;
  }

  // ISO 8601 PT4M20S
  const isoMatch = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (isoMatch) {
    return (parseInt(isoMatch[1] ?? 0)) * 3600 +
           (parseInt(isoMatch[2] ?? 0)) * 60  +
           (parseInt(isoMatch[3] ?? 0));
  }

  // "4m 20s" / "4m" / "20s"
  const humanMatch = str.match(/(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (humanMatch && (humanMatch[1] || humanMatch[2] || humanMatch[3])) {
    return (parseInt(humanMatch[1] ?? 0)) * 3600 +
           (parseInt(humanMatch[2] ?? 0)) * 60  +
           (parseInt(humanMatch[3] ?? 0));
  }

  return null;
}
