# Junkyard Olympics — Website

The merged home of the Junkyard Olympics software, combining two independent
builds by **Paul** (pkircher29) and **Chris** (crose0122).

> Rust, scrap steel, caution tape, and gloriously overproduced backyard sports.

## What lives where

```
site/         Paul's cloud apps — LIVE in production
              ├─ junkyardolympics.com          bracket scoreboard (Cloudflare Worker + D1)
              └─ music.junkyardolympics.com    Junkyard Jukebox (Spotify party queue)

lan-server/   Chris's LAN control tower — Node 22 + Express + SQLite
              cannon scoring engine, TV broadcast mode, Flair, stations,
              print packet, organizer consoles (176/181 tests passing)

docs/         COMPARISON.md — the head-to-head analysis and merge decision record
```

## Running each part

**site/** deploys serverlessly — the static frontend is proxied from a GitHub
`main` branch by two Cloudflare Workers (`bracket-attack-sync`, `junkyard-music`);
worker source is in `site/worker/`. During the transition the *live* site still
deploys from the `pkircher29/Bracket-attack-` repo; this copy is the merge
working tree.

**lan-server/** (Node 22+):

```bash
cd lan-server
npm install
ORGANIZER_TOKENS=<chris-secret>,<paul-secret> npm run build && npm start
# serves on port 8790 — participant/organizer/station/TV/print views in public/
npm test   # vitest suite
```

## Merge plan

See [`docs/COMPARISON.md`](docs/COMPARISON.md) for the full head-to-head.
Short version: **Paul's deployed cloud stack is the backbone** (works on cell
data, no host machine, has the jukebox); **Chris's TV broadcast mode, Flair,
cannon engine, confirm/dispute flow, and design system get ported onto it** in
that order — with `lan-server/` kept intact as the reference implementation and
the internet-outage fallback.

## Credits

- **Paul Kircher** — bracket engine (single/double elim, seeded draws), medal
  table, live multi-device sync, Junkyard Jukebox, QR join flow
- **Chris** — brand system + t-shirt art, TV broadcast experience, cannon
  scoring engine, Flair, stations/check-in scheduling, ops & recovery design
