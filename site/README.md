# ⚙️ Bracket Attack — Junkyard Olympics Edition

**Version 1.0.0**

**A tournament-of-tournaments tracker for backyard game days**, themed for the
**Junkyard Olympics**: rust, scrap steel and caution tape. Run multiple
tournaments — cornhole, horseshoes, ladder golf, whatever — all at the same
time, each with its own bracket page and scorekeeping, feeding one overall
medal table. Random teams get junkyard-grade names like *Rusty Hubcaps* and
*Greasy Sprockets*.

## Features

- **Overview dashboard** — every tournament at a glance (live/active/complete,
  progress bars) plus the overall standings.
- **Tournament of tournaments scoring** — when a tournament finishes, every
  player on the 1st place team earns **4 points**, 2nd place **3**, 3rd place
  **2**, and everyone who played gets **1** — so it always pays to play.
- **Player pool & teams** — bulk-add your whole crew. Build **static teams**
  that stay together in every tournament, and draw **random teams** from the
  remaining pool on a tournament-by-tournament basis (with auto-generated team
  names like *Blazing Baggers*).
- **Per-tournament rules** — when a tournament begins you lock in its scoring
  rules: target score, win-by margin, and house-rule notes. Presets for
  cornhole, horseshoes, ladder golf and darts.
- **Single-elimination brackets** with byes handled automatically and a
  3rd-place match so bronze points are earned on the court, not on paper.
- **Big scorekeeping page per match** — huge scores, +1/+2/+3 buttons,
  target-score highlighting, winner declaration.
- **Knows who's playing right now** — players in a live match anywhere get a
  🎮 badge, and when you start a match whose players are busy in another
  tournament, the app **automatically substitutes a free team from the same
  leg of the bracket** and tells you what it did.
- **Multi-device live sync** — every phone or tablet that opens the site and
  joins the same **room code** shares one live scoreboard. Different devices
  can score different matches at the same time (even in the same tournament);
  changes merge automatically and show up everywhere within a few seconds.
- **Confetti.** Obviously.
- Export/import your data as a JSON backup.

## Running it

**The live site is [junkyardolympics.com](https://junkyardolympics.com).**

The Cloudflare Worker in [`worker/worker.js`](worker/worker.js) serves the
site (routed on `junkyardolympics.com/*` and `www.junkyardolympics.com/*`) by
proxying this repo's `main` branch with edge caching — **merge to `main` and
the live site updates within ~2 minutes**, no deploy step.

It's still a zero-build static app, so it also runs anywhere else:

- **Locally:** open `index.html` in a browser (or `python3 -m http.server`
  in the repo folder and visit `http://localhost:8000`).
- Any static host (GitHub Pages etc.) works too — sync automatically talks
  to the worker cross-origin.

## Multi-device sync

Sync is on by default, in room **`junkyard`**. Every device that opens the
site and joins the same room (Live Sync card on the overview page) shares one
scoreboard. The green dot in the top bar means you're live.

- Keep **one scorekeeper per match** — everything else (different matches,
  different tournaments, players, teams) merges automatically.
- Data also stays in each device's local storage, so a device that drops off
  WiFi keeps working and re-merges when it reconnects.

The backend is a ~60-line Cloudflare Worker + D1 database (free tier), source
in [`worker/worker.js`](worker/worker.js), deployed at
`bracket-attack-sync.pkircher.workers.dev`.

## How a game day works

1. **Players & Teams** page — paste in everyone's names. Optionally create
   static teams (the duos who always play together).
2. **New Tournament** — pick the game, set the rules, check the static teams
   you want in, and hit 🎲 to draw random teams from everyone else.
3. Run matches from the tournament page — **Start** a match, score it on the
   big scoreboard, **Finish** to advance the bracket.
4. Repeat with as many simultaneous tournaments as you like. The overview
   page keeps the master leaderboard.

## 📻 Junkyard Jukebox (music.junkyardolympics.com)

The party's music platform lives in [`music/`](music/) with its own worker
([`worker/music-worker.js`](worker/music-worker.js), deployed as
`junkyard-music`, routed to `music.junkyardolympics.com/*`, same D1 database):

- Guests log in with a **username + shared party password**.
- **Spotify search** (track, artist, album, release year, popularity, album
  art) via the client-credentials flow.
- Requests enter a **weighted round-robin queue**: guests with fewer songs
  played go first. More than **10 requests in 2 minutes** = automatic
  **20-minute rejection** and the offender's rotation slot moves to the end
  of the line.
- When the queue is empty, **autoplay** picks from the host's Spotify
  **Liked Songs** (falling back to the last played track's artist
  top-tracks — Spotify retired its recommendations endpoint for new apps).
- The **host player console** (`/#/player`) links a Spotify **Premium**
  account and plays through the browser via the Web Playback SDK, advancing
  the queue automatically.

One-time host setup at `music.junkyardolympics.com/#/setup`: set the party
password, then create a free app at developer.spotify.com/dashboard, add the
shown redirect URI, paste the client ID/secret, and click *connect Spotify*
on the host device.

## Tech

Vanilla HTML/CSS/JS. No frameworks, no build step, works offline once loaded.
