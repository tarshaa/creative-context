/**
 * server/index.js
 *
 * MCP server for creative-context.
 * Exposes Pinterest pins as queryable creative references.
 *
 * Tools:
 *   search_references  — natural-language search across pins
 *   get_all_pins       — return the full pin library
 *   sync               — trigger a fresh sync from the browser session
 *   viz                — show a breakdown of the pin library by category
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

import { searchReferences, getAllPins, getDataSummary } from './search.js';
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
  'Search Pinterest pins with a natural language description. ' +
  'Works with aesthetic vibes ("quiet and expensive", "brutalist campaign"), specific topics, ' +
  'board names, or any descriptive phrase. Returns the most relevant pins, scored and ranked.',
  {
    query: z.string().describe(
      'Natural language search query, e.g. "brutalist typography", "quiet and expensive feeling", ' +
      '"warm earthy editorial", "cinematic dark moodboard"'
    ),
    limit: z.number().int().min(1).max(100).optional().default(20).describe(
      'Maximum number of results to return (default 20)'
    ),
  },
  async ({ query, limit }) => {
    const { results, queryTokens, expandedCount, totalSearched }
      = searchReferences(query, { limit });

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: [
            `No results found for "${query}".`,
            '',
            `Searched: ${totalSearched.pins} pins`,
            queryTokens.length ? `Tokens: ${queryTokens.join(', ')}` : '',
            expandedCount > 0 ? `(+${expandedCount} synonym expansions)` : '',
            '',
            'Tips:',
            '• Try a different description or mood',
            '• Run `sync` to make sure your library is up to date',
            '• Use `get_all_pins` to browse everything',
          ].filter(Boolean).join('\n'),
        }],
      };
    }

    const lines = [
      `Found ${results.length} pin${results.length !== 1 ? 's' : ''} for "${query}"`,
      `Searched: ${totalSearched.pins} pins`,
      expandedCount > 0 ? `(+${expandedCount} concept expansions from built-in vocabulary)` : '',
      '',
    ].filter(Boolean);

    for (const { item, score } of results) {
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
// Tool: sync
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'sync',
  'Trigger a fresh sync of Pinterest pins from the browser session. ' +
  'Reads cookies directly from Chrome, Brave, Arc, Dia, Firefox, or Safari — no API keys needed. ' +
  'Run this to pick up new saves.',
  {
    browser: z.string().optional().default('auto').describe(
      'Which browser to read cookies from: chrome, brave, arc, dia, firefox, safari, or auto (default)'
    ),
  },
  async ({ browser }) => {
    const scriptPath = join(SYNC_DIR, 'pinterest.js');

    if (!existsSync(scriptPath)) {
      return { content: [{ type: 'text', text: `✗ sync script not found at ${scriptPath}` }] };
    }

    const results = ['Syncing Pinterest…'];

    try {
      const args = [scriptPath];
      if (browser !== 'auto') args.push('--browser', browser);

      const output = execFileSync(process.execPath, args, {
        cwd: join(__dirname, '..'),
        timeout: 5 * 60 * 1000,
        encoding: 'utf8',
        env: process.env,
      });

      results.push('✓ Sync complete');
      const lastLines = output.trim().split('\n').slice(-4).join('\n');
      if (lastLines) results.push(`  ${lastLines.replace(/\n/g, '\n  ')}`);
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      results.push(`✗ Sync failed: ${msg.split('\n')[0]}`);
    }

    results.push('');
    const summary = getDataSummary();
    results.push(`Library: ${summary.pins.total} pins across ${summary.pins.boards} boards`);

    return { content: [{ type: 'text', text: results.join('\n') }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: viz
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'viz',
  'Show a visual breakdown of the Pinterest pin library: boards and pin counts, ' +
  'dominant colour distribution, and source sites. Good for understanding what you\'ve saved at a glance.',
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
