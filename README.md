# creative-context

A local MCP server that syncs your saved Pinterest pins and makes them searchable inside Claude.

Save something to Pinterest, run a one-line sync, and Claude can immediately find it for you — by mood, aesthetic, topic, or vibe. No API keys. No configuration. Just be logged into Pinterest in your browser.

---

## What it does

Pinterest is where most creative people quietly build their reference library over years. But that library is locked inside the app — you can't ask it questions.

creative-context pulls everything out and keeps it local on your Mac. Then it gives Claude a set of tools to search it. You can ask things like:

- *"Find me references with a quiet, expensive feeling"*
- *"What have I saved about brutalist typography?"*
- *"Give me everything in my Campaigns board"*
- *"What does my reference library look like broken down by category?"*

Claude searches by meaning, not just keywords. It understands that "moody" relates to "cinematic" and "dark", that "expensive-feeling" connects to "minimal" and "refined", that "brutal" and "brutalist" are the same thing.

---

## What you need

- A Mac (required — the app reads cookies from your browser)
- [Claude desktop app](https://claude.ai/download)
- [Node.js](https://nodejs.org) — download the LTS version and install it
- Chrome, Brave, Arc, Dia, Firefox, or Safari — already open and logged in to Pinterest

---

## Installation
git clone https://github.com/tarshaa/creative-context
cd creative-context

### Step 1 — Download and set up

Open Terminal (press `⌘ Space`, type "Terminal", press Enter) and run these two lines:

```
git clone https://github.com/tarshaa/creative-context
cd creative-context
npm install
```

This installs the software. It takes about 30 seconds.

### Step 2 — Sync your pins

Still in Terminal, run:

```
npm run sync
```

This reads your browser session (the same way you're already logged in to Pinterest) and copies everything to your Mac. It doesn't ask for passwords. It just reads the session your browser already has open.

The first sync takes a few minutes if you have a lot of saves. You'll see it counting as it goes:

```
Starting Pinterest sync...
  Fetched 100 pins...
  Fetched 200 pins...
  Fetched 312 pins...
Saved 312 pins from 8 boards
```

### Step 3 — Connect to Claude

Still in Terminal, run:

```
npm run setup
```

This writes the MCP config automatically using your current directory path. No manual editing required.

Then quit the Claude desktop app completely and reopen it. Claude will now have access to your reference library.

---

## Syncing

Your references don't update automatically — you sync whenever you want a fresh copy.

```
npm run sync
```

**Sync from a specific browser** (if the default doesn't pick up your session):
```
node sync/pinterest.js --browser safari
node sync/pinterest.js --browser firefox
```

Supported browsers: `chrome`, `brave`, `arc`, `dia`, `firefox`, `safari`

A good habit is syncing once a week, or after a focused session of saving references.

---

## Using it with Claude

Once synced, open Claude and just ask naturally.

### Searching by mood or aesthetic

> *Find me references with a quiet and expensive feeling*

> *Show me anything brutalist or concrete-heavy*

> *I'm looking for warm, earthy, editorial stuff — what have I saved?*

> *Give me references that feel cinematic and dark*

### Searching by topic or subject

> *What have I saved about packaging design?*

> *Find anything related to fashion campaigns*

> *Do I have references for hand-drawn type?*

### Browsing by board

> *Show me everything in my Typography board*

> *List all my boards and how many pins are in each*

### Getting an overview

> *Run viz so I can see my reference library broken down*

This shows a full breakdown of your library — which boards you save to most, what colours show up in your pins, and which sites they come from.

### Syncing from inside Claude

> *Sync my references*

> *Sync using Safari*

Claude will run the sync and tell you how many pins were pulled in.

---

## Keeping references private

Everything stays on your Mac. Nothing is sent to any server. The `data/` folder inside creative-context contains your pins as plain text files — you can open them in any text editor and see exactly what's stored.

The only network requests are the ones going to Pinterest during a sync, using your existing logged-in session.

---

## Troubleshooting

**"No session found in any browser"**
Make sure you're actually logged into Pinterest in your browser. Open the site, confirm you're logged in, then try syncing again. If you're using a browser other than Chrome, add `--browser safari` (or whichever) to the sync command.

**"Could not retrieve Safe Storage key from macOS Keychain"**
Close your browser, reopen it, log into Pinterest again, then try syncing. This occasionally happens if the browser hasn't been fully launched.

**Claude doesn't seem to know about my references**
Make sure you've synced at least once (`npm run sync`) and that you fully quit and restarted the Claude desktop app after installation. You can verify Claude has access by asking: *"Do you have access to my creative references?"*

**The sync runs but finds 0 pins**
Your session cookie may have expired. Open Pinterest in your browser, log out, log back in, and sync again.

**Nothing is updating after I save new pins**
Sync again — `npm run sync`. The library only updates when you run a sync.

---

## File structure

```
creative-context/
├── data/
│   ├── pins.json         your Pinterest pins (updated on sync)
│   └── last_sync.json    timestamp of last successful sync
├── sync/
│   ├── browser-cookies.js    reads your browser session
│   └── pinterest.js          Pinterest sync script
├── server/
│   ├── index.js          MCP server (what Claude talks to)
│   ├── search.js         natural language search engine
│   └── viz.js            pin library breakdown
└── package.json
```
