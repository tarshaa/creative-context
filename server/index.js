/**
 * server/index.js
 *
 * MCP server for creative-context.
 * Exposes Pinterest pins and YouTube liked videos as queryable references.
 *
 * Tools:
 *   search_references  — natural-language search across pins + videos
 *   get_all_pins       — return the full pin library
 *   get_all_videos     — return the full video library
 *   sync               — trigger a fresh sync from the browser session
 *   viz                — show a breakdown of the reference library by category
 *
 * Connect via stdio (standard MCP pattern):
 *   node server/index.js
 *
 * Add to ~/.claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "creative-context": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/creative-context/server/index.js"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { searchReferences, getAllPins, getAllVideos, getDataSummary } from './search.js';
import { generateViz } from './viz.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_DIR  = join(__dirname, '..', 'sync');

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'creative-context',
  version: '0.1.0',
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool: search_references
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'search_references',
  'Search Pinterest pins and YouTube liked videos with a natural language description. ' +
  'Works with aesthetic vibes ("quiet and expensive", "brutalist campaign"), specific topics, ' +
  'board names, channels, or any descriptive phrase. Returns the most relevant references ' +
  'across both sources, scored and ranked.',
  {
    query: z.string().describe(
      'Natural language search query, e.g. "brutalist typography", "quiet and expensive feeling", ' +
      '"warm earthy editorial", "cinematic dark moodboard"'
    ),
    limit: z.number().int().min(1).max(100).optional().default(20).describe(
      'Maximum number of results to return (default 20)'
    ),
    type: z.enum(['both', 'pins', 'videos']).optional().default('both').describe(
      'Filter to pins only, videos only, or both (default: both)'
    ),
  },
  async ({ query, limit, type }) => {
    const { results, queryTokens, expandedCount, totalSearched }
      = searchReferences(query, { limit, type });

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: [
            `No results found for "${query}".`,
            '',
            `Searched: ${totalSearched.pins} pins, ${totalSearched.videos} videos`,
            queryTokens.length ? `Tokens: ${queryTokens.join(', ')}` : '',
            expandedCount > 0 ? `(+${expandedCount} synonym expansions)` : '',
            '',
            'Tips:',
            '• Try a different description or mood',
            '• Run `sync` to make sure your library is up to date',
            '• Use `get_all_pins` or `get_all_videos` to browse everything',
          ].filter(Boolean).join('\n'),
        }],
      };
    }

    const pinResults   = results.filter((r) => r.type === 'pin');
    const videoResults = results.filter((r) => r.type === 'video');

    const lines = [
      `Found ${results.length} reference${results.length !== 1 ? 's' : ''} for "${query}"`,
      `Searched: ${totalSearched.pins} pins, ${totalSearched.videos} videos`,
      expandedCount > 0 ? `(+${expandedCount} concept expansions from built-in vocabulary)` : '',
      '',
    ].filter(Boolean);

    if (pinResults.length > 0) {
      lines.push(`── Pinterest Pins (${pinResults.length}) ──────────────────────────`);
      for (const { item, score } of pinResults) {
        lines.push('');
        lines.push(`📌 ${item.title || '(untitled)'}  [score: ${score.toFixed(1)}]`);
        if (item.board)          lines.push(`   Board: ${item.board}`);
        if (item.description)    lines.push(`   ${item.description}`);
        if (item.note)           lines.push(`   Note: ${item.note}`);
        if (item.image_url)      lines.push(`   Image: ${item.image_url}`);
        if (item.link)           lines.push(`   Link: ${item.link}`);
        if (item.dominant_color) lines.push(`   Color: ${item.dominant_color}`);
        if (item.alt_text)       lines.push(`   Alt: ${item.alt_text}`);
      }
      lines.push('');
    }

    if (videoResults.length > 0) {
      lines.push(`── YouTube Videos (${videoResults.length}) ──────────────────────────`);
      for (const { item, score } of videoResults) {
        lines.push('');
        lines.push(`▶️  ${item.title || '(untitled)'}  [score: ${score.toFixed(1)}]`);
        if (item.channel)         lines.push(`   Channel: ${item.channel}`);
        if (item.duration)        lines.push(`   Duration: ${item.duration}`);
        if (item.view_count)      lines.push(`   Views: ${item.view_count}`);
        if (item.published)       lines.push(`   Posted: ${item.published}`);
        if (item.url)             lines.push(`   URL: ${item.url}`);
        if (item.topics?.length)  lines.push(`   Topics: ${item.topics.join(', ')}`);
        if (item.tags?.length)    lines.push(`   Tags: ${item.tags.slice(0, 6).join(', ')}`);
      }
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_all_pins
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'get_all_pins',
  'Return all synced Pinterest pins. Optionally filter by board name or limit results. ' +
  'Use search_references for relevance-ranked queries; use this when you want the full library ' +
  'or want to browse by board.',
  {
    board: z.string().optional().describe(
      'Filter to a specific board name (case-insensitive partial match)'
    ),
    limit: z.number().int().min(1).max(500).optional().default(100).describe(
      'Maximum number of pins to return (default 100)'
    ),
    offset: z.number().int().min(0).optional().default(0).describe(
      'Skip this many pins (for pagination)'
    ),
  },
  async ({ board, limit, offset }) => {
    let pins = getAllPins();

    if (board) {
      const q = board.toLowerCase();
      pins = pins.filter((p) => p.board?.toLowerCase().includes(q));
    }

    const total  = pins.length;
    const paged  = pins.slice(offset, offset + limit);
    const summary = getDataSummary();

    const lines = [
      `Pinterest library: ${total} pin${total !== 1 ? 's' : ''}${board ? ` in boards matching "${board}"` : ''}`,
      `Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}`,
      summary.pins.synced_at ? `Last synced: ${new Date(summary.pins.synced_at).toLocaleString()}` : 'Not yet synced',
      '',
    ];

    for (const pin of paged) {
      lines.push(`📌 [${pin.board ?? 'no board'}]  ${pin.title || '(untitled)'}`);
      if (pin.description) lines.push(`   ${pin.description}`);
      if (pin.image_url)   lines.push(`   Image: ${pin.image_url}`);
      if (pin.link)        lines.push(`   Link: ${pin.link}`);
      lines.push('');
    }

    if (offset + limit < total) {
      lines.push(`… ${total - offset - limit} more pins. Use offset=${offset + limit} to see the next page.`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_all_videos
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'get_all_videos',
  'Return all synced YouTube liked videos. Optionally filter by channel name or limit results. ' +
  'Use search_references for relevance-ranked queries; use this to browse the full video library.',
  {
    channel: z.string().optional().describe(
      'Filter to a specific channel name (case-insensitive partial match)'
    ),
    limit: z.number().int().min(1).max(500).optional().default(50).describe(
      'Maximum number of videos to return (default 50)'
    ),
    offset: z.number().int().min(0).optional().default(0).describe(
      'Skip this many videos (for pagination)'
    ),
  },
  async ({ channel, limit, offset }) => {
    let videos = getAllVideos();

    if (channel) {
      const q = channel.toLowerCase();
      videos = videos.filter((v) => v.channel?.toLowerCase().includes(q));
    }

    const total  = videos.length;
    const paged  = videos.slice(offset, offset + limit);
    const summary = getDataSummary();

    const lines = [
      `YouTube library: ${total} liked video${total !== 1 ? 's' : ''}${channel ? ` from channels matching "${channel}"` : ''}`,
      `Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}`,
      summary.videos.synced_at ? `Last synced: ${new Date(summary.videos.synced_at).toLocaleString()}` : 'Not yet synced',
      '',
    ];

    for (const video of paged) {
      lines.push(`▶️  ${video.title || '(untitled)'}`);
      lines.push(`   Channel: ${video.channel ?? 'unknown'}   Duration: ${video.duration ?? '?'}`);
      if (video.view_count) lines.push(`   Views: ${video.view_count}   Posted: ${video.published ?? '?'}`);
      lines.push(`   ${video.url}`);
      if (video.topics?.length) lines.push(`   Topics: ${video.topics.join(', ')}`);
      lines.push('');
    }

    if (offset + limit < total) {
      lines.push(`… ${total - offset - limit} more videos. Use offset=${offset + limit} to see the next page.`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: sync
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'sync',
  'Trigger a fresh sync of Pinterest pins and/or YouTube liked videos from the browser session. ' +
  'Reads cookies directly from Chrome, Brave, Arc, Dia, Firefox, or Safari — no API keys needed. ' +
  'Run this to pick up new saves and likes.',
  {
    source: z.enum(['all', 'pinterest', 'youtube']).optional().default('all').describe(
      'Which source to sync: "pinterest", "youtube", or "all" (default)'
    ),
    browser: z.string().optional().default('auto').describe(
      'Which browser to read cookies from: chrome, brave, arc, dia, firefox, safari, or auto (default)'
    ),
  },
  async ({ source, browser }) => {
    const scripts = {
      pinterest: join(SYNC_DIR, 'pinterest.js'),
      youtube:   join(SYNC_DIR, 'youtube.js'),
    };

    const toRun = source === 'all'
      ? [['pinterest', scripts.pinterest], ['youtube', scripts.youtube]]
      : [[source, scripts[source]]];

    const results = [];

    for (const [name, scriptPath] of toRun) {
      if (!existsSync(scriptPath)) {
        results.push(`✗ ${name}: script not found at ${scriptPath}`);
        continue;
      }

      results.push(`Syncing ${name}…`);

      try {
        const args = [scriptPath];
        if (browser !== 'auto') args.push('--browser', browser);

        const output = execFileSync(process.execPath, args, {
          cwd: join(__dirname, '..'),
          timeout: 5 * 60 * 1000, // 5 min max
          encoding: 'utf8',
          env: process.env,
        });

        results.push(`✓ ${name} sync complete`);
        // Include the last few lines of script output for confirmation
        const lastLines = output.trim().split('\n').slice(-4).join('\n');
        if (lastLines) results.push(`  ${lastLines.replace(/\n/g, '\n  ')}`);
      } catch (err) {
        const msg = err.stderr?.toString().trim() || err.message;
        results.push(`✗ ${name} sync failed: ${msg.split('\n')[0]}`);
      }

      results.push('');
    }

    // Append updated summary
    const summary = getDataSummary();
    results.push(
      `Library after sync:`,
      `  Pinterest: ${summary.pins.total} pins across ${summary.pins.boards} boards`,
      `  YouTube:   ${summary.videos.total} liked videos`,
    );

    return { content: [{ type: 'text', text: results.join('\n') }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: viz
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'viz',
  'Show a visual breakdown of the reference library: boards and pin counts, ' +
  'dominant colour distribution, source sites for Pinterest; channels, topics, ' +
  'and video lengths for YouTube. Good for understanding what you\'ve saved at a glance.',
  {},
  async () => {
    const output = generateViz();
    return { content: [{ type: 'text', text: output }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
