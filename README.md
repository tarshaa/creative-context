# creative-context

Your saved Pinterest pins and liked YouTube videos, searchable by Claude.

Save something to Pinterest or like a video on YouTube, run a one-line sync, and Claude can immediately find it for you — by mood, aesthetic, topic, or vibe. No typing through your boards. No scrolling through hundreds of likes. Just ask.

---

## What it does

Pinterest and YouTube are where most creative people quietly build their reference library over years. But that library is locked inside those apps — you can't ask it questions.

creative-context pulls everything out and keeps it local on your Mac. Then it gives Claude a set of tools to search it. You can ask things like:

- *"Find me references with a quiet, expensive feeling"*
- *"What have I saved about brutalist typography?"*
- *"Show me YouTube videos I've liked about color theory"*
- *"Give me everything in my Campaigns board"*
- *"What does my reference library look like broken down by category?"*

Claude searches by meaning, not just keywords. It understands that "moody" relates to "cinematic" and "dark", that "expensive-feeling" connects to "minimal" and "refined", that "brutal" and "brutalist" are the same thing.

---

## What you need

- A Mac (required — the app reads cookies from your browser)
- [Claude desktop app](https://claude.ai/download)
- [Node.js](https://nodejs.org) — download the LTS version and install it
- Chrome, Brave, Arc, Dia, Firefox, or Safari — already open and logged in to Pinterest and YouTube
- An Anthropic API key — search is powered by Claude, so you need one (free to get at [console.anthropic.com](https://console.anthropic.com))

### API key setup

Create a file called `.env` inside the `creative-context` folder with this one line:

```
ANTHROPIC_API_KEY=sk-ant-...your key here...
```

That's the only configuration the app needs.

---

## Installation

### Step 1 — Download and set up

Open Terminal (press `⌘ Space`, type "Terminal", press Enter) and run these two lines:

```
cd ~/creative-context
npm install
```

This installs the software. It takes about 30 seconds.

### Step 2 — Sync your references

Still in Terminal, run:

```
npm run sync:all
```

This reads your browser session (the same way you're already logged in to Pinterest and YouTube) and copies everything to your Mac. It doesn't ask for passwords. It just reads the session your browser already has open.

The first sync takes a few minutes if you have a lot of saves. You'll see it counting as it goes:

```
Starting Pinterest sync...
  [Inspiration] ... 47 pins
  [Typography] ... 89 pins
  [Campaigns] ... 134 pins
...
Saved 412 pins from 8 boards

Starting YouTube sync...
  Fetching liked videos...
  Page 1: 50 videos
  Page 2: +50 videos (100 total)
...
Saved 287 liked videos
```

### Step 3 — Restart Claude

Quit the Claude desktop app completely and reopen it. Claude will now have access to your reference library.

---

## Syncing

Your references don't update automatically — you sync whenever you want a fresh copy.

**Sync everything:**
```
npm run sync:all
```

**Sync only Pinterest:**
```
npm run sync:pinterest
```

**Sync only YouTube:**
```
npm run sync:youtube
```

**Sync from a specific browser** (if the default doesn't pick up your session):
```
node sync/pinterest.js --browser safari
node sync/youtube.js --browser firefox
```

Supported browsers: `chrome`, `brave`, `arc`, `dia`, `firefox`, `safari`

A good habit is syncing once a week, or after a focused session of saving references. Run it in Terminal, wait for it to finish, and you're up to date.

---

## Using it with Claude

Once synced, open Claude and just ask naturally. You don't need to use special commands or remember any syntax.

### Searching by mood or aesthetic

> *Find me references with a quiet and expensive feeling*

> *Show me anything brutalist or concrete-heavy*

> *I'm looking for warm, earthy, editorial stuff — what have I saved?*

> *Give me references that feel cinematic and dark*

### Searching by topic or subject

> *What have I saved about packaging design?*

> *Find YouTube videos I've liked about color grading*

> *Show me anything related to fashion campaigns*

> *Do I have references for hand-drawn type?*

### Browsing by board or channel

> *Show me everything in my Typography board*

> *What have I liked from the Vox channel?*

> *List all my boards and how many pins are in each*

### Getting an overview

> *Run viz so I can see my reference library broken down*

This shows you a full breakdown of your library — which boards you save to most, what colours show up in your pins, which YouTube channels you've liked the most from, and how the video lengths break down.

### Syncing from inside Claude

You don't have to go back to Terminal to sync. Just ask:

> *Sync my references*

> *Sync just Pinterest*

> *Sync YouTube using Safari*

Claude will run the sync and tell you how many references were pulled in.

---

## Keeping references private

Everything stays on your Mac. Nothing is sent to any server. The `data/` folder inside creative-context contains your pins and videos as plain text files — you can open them in any text editor and see exactly what's stored.

The only network requests are the ones going to Pinterest and YouTube during a sync, using your existing logged-in session.

---

## Troubleshooting

**"No session found in any browser"**
Make sure you're actually logged into Pinterest or YouTube in your browser. Open the site, confirm you're logged in, then try syncing again. If you're using a browser other than Chrome, add `--browser safari` (or whichever browser you use) to the sync command.

**"Could not retrieve Safe Storage key from macOS Keychain"**
Close your browser, reopen it, log into Pinterest or YouTube again, then try syncing. This occasionally happens if the browser hasn't been fully launched.

**Claude doesn't seem to know about my references**
Make sure you've synced at least once (`npm run sync:all`) and that you fully quit and restarted the Claude desktop app after installation. You can verify Claude has access by asking: *"Do you have access to my creative references?"*

**The sync runs but finds 0 pins or videos**
Your session cookie may have expired. Open Pinterest or YouTube in your browser, log out, log back in, and sync again.

**Nothing is updating after I save new pins**
Sync again — `npm run sync:all`. The library only updates when you run a sync.

---

## File structure (for the curious)

```
creative-context/
├── data/
│   ├── pins.json         your Pinterest pins (updated on sync)
│   ├── videos.json       your YouTube liked videos (updated on sync)
│   └── last_sync.json    timestamps of last successful sync
├── sync/
│   ├── browser-cookies.js    reads your browser session
│   ├── pinterest.js          Pinterest sync script
│   └── youtube.js            YouTube sync script
├── server/
│   ├── index.js          MCP server (what Claude talks to)
│   ├── search.js         natural language search engine
│   └── viz.js            reference library breakdown
└── package.json
```
