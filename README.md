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

## Merge status

See [`docs/COMPARISON.md`](docs/COMPARISON.md) for the full head-to-head.
**Paul's deployed cloud stack is the backbone**; Chris's work is merging in:

Done:
- Chris's brand art + surface system (masthead/taglines, ticket-tab courier
  nav, comic outlines, halftone grit) applied across both cloud sites
- His QR signup flow (scan -> name only -> in) live on both sites
- His event catalog merged (Field Pong, Bocce Ball, Volley Strike, Badminton)
- Guests form their own 2-person teams; team/player names pass an obvious
  profanity censor; tournament creation is hosts-only
- **Event HQ bridge**: the cloud site links to this repo's `lan-server`
  (TV broadcast, cannon console, organizer) and pulls its championship +
  Flair standings live. The HQ URL is host-configured at `#/hq` and syncs to
  every device - use the LAN IP, a Tailscale hostname, or a **Tailscale
  Funnel** URL (`tailscale funnel 8790` on the host) so phones reach it from
  anywhere. `lan-server` now sends read-only CORS headers for exactly this.

Next up (in value order): port TV broadcast natively, Flair, confirm/dispute
results, consolation bracket path, cannon engine. `lan-server/` stays intact
as the reference implementation and the internet-outage fallback.

## Credits

- **Paul Kircher** — bracket engine (single/double elim, seeded draws), medal
  table, live multi-device sync, Junkyard Jukebox, QR join flow
- **Chris** — brand system + t-shirt art, TV broadcast experience, cannon
  scoring engine, Flair, stations/check-in scheduling, ops & recovery design
