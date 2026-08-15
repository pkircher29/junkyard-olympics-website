# Junkyard Olympics — Website

The merged home of the Junkyard Olympics software, combining two independent
builds by **Paul** (pkircher29) and **Chris** (crose0122).

> Rust, scrap steel, caution tape, and gloriously overproduced backyard sports.

## What lives where

```
junkyardolympics.com            CHRIS'S APP — the main site. A Cloudflare
                                Worker proxies every request over a Tailscale
                                bridge (AutoKJ VPS -> RecRoomRig:8790) to the
                                lan-server below. Styled fallback page when
                                the control tower is unreachable.

bracket.junkyardolympics.com    Paul's bracket scoreboard + medal table
                                (static from site/, sync API on D1)

music.junkyardolympics.com      Junkyard Jukebox (Spotify party queue)

site/         Paul's cloud apps (scoreboard + jukebox + workers)
lan-server/   Chris's control tower — Node 22 + Express + SQLite: signup,
              competitor pass, cannon engine, TV broadcast, Flair, stations,
              print packet, organizer consoles (176/181 tests passing).
              RUN WITH HOST=0.0.0.0 so the public relay can reach it.
docs/         COMPARISON.md — head-to-head analysis and merge decision record
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
HOST=0.0.0.0 ORGANIZER_TOKENS=<chris-secret>,<paul-secret> npm run build && npm start
# HOST=0.0.0.0 matters: the default binds loopback only, and the public
# junkyardolympics.com relay arrives on the Tailscale interface
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

## Junkyard Constellation integration

The founder-approved local photo vault is being integrated on `feat/photo-vault-merge`
from this exact canonical tree. Signed-in guests will get a native **Junkyard
Constellation** route in Paul's hosted app. Their existing Paul session is validated
server-to-server and mapped by immutable external subject id into the local
vault; guests do not create a second display-name identity.

All image bytes, consent, moderation, plaques, removal state, backups, and
exports remain in `lan-server/` under its configured `DATA_DIR`. No photo is
stored in D1, room sync, localStorage, GitHub, Spotify, or a public static
directory. Cloud/model uncertainty stays private for organizer review. The TV
reel is ambient only: official calls, results, recovery, and audio always win.

Frozen requirements and execution gates:

- [`docs/PHOTO-VAULT-SPEC.md`](docs/PHOTO-VAULT-SPEC.md)
- [`docs/PHOTO-VAULT-PLAN.md`](docs/PHOTO-VAULT-PLAN.md)

Git merge, Cloudflare worker deployment, and live LAN deployment are three
separate approval boundaries. Until exact-snapshot review and real-device
rehearsal pass, the current party runtimes stay unchanged.

The website is the only family/participant/operator UI. Event HQ provides the
secured API, SQLite state, photo processing, and recovery services behind it.
Rehearsal, Cannon setup/scoring/alerts, and moderation are organizer-only
sections of the website admin dashboard; they never appear in participant
navigation. Rehearsal uses a visibly synthetic disposable event state.

## Credits

- **Paul Kircher** — bracket engine (single/double elim, seeded draws), medal
  table, live multi-device sync, Junkyard Jukebox, QR join flow
- **Chris** — brand system + t-shirt art, TV broadcast experience, cannon
  scoring engine, Flair, stations/check-in scheduling, ops & recovery design
