# Head-to-Head: Paul's Cloud Apps vs. Chris's LAN Control Tower

Two independent builds of the same party. Both are good. They optimize for
different things, and the best event uses pieces of each.

## The two systems at a glance

| | **Paul — `/site`** (live at junkyardolympics.com + music.junkyardolympics.com) | **Chris — `/lan-server`** |
|---|---|---|
| Architecture | Serverless: 2 Cloudflare Workers + D1; static frontend served straight from GitHub `main` | Node 22 + Express 5 + better-sqlite3 on a LAN host (RecRoomRig:8790), TypeScript, vitest |
| Hosting | Already deployed on the public internet — works on cell data, zero host machine | Local-only by design; requires everyone on the party Wi-Fi; survives internet outage |
| State | D1 (SQLite at the edge) + JSON room sync with per-match merge | Local SQLite, WAL, migrations, transactions, automatic verified backups, audit log |
| Testing | Offline simulation harness for the bracket engine (19 checks) + live E2E walkthroughs | 181 vitest tests, **176 passing on fresh checkout** (5 fail: pre-generated print-PDF path) |
| Maturity | In production today; every flow exercised live | Engine thoroughly tested; some acceptance-contract endpoints/UI markers unfinished (per TDD log) |

## Feature-by-feature

| Feature | Paul | Chris | Better take |
|---|---|---|---|
| Signup | QR poster → name-only join, works from anywhere, one login for scoreboard + jukebox | QR → name → pick events; bearer token on device; rate-limited | **Tie** — same UX idea; Paul's is live + cross-site; Chris's adds event self-enrollment |
| Brackets | Single **and double elimination**, seeded or random draw, 3rd-place match, byes, reopen/fix, restart, slot swaps | Single elim + **consolation path** (everyone gets 2 games), late-entry/play-in rules, semifinal lock | **Paul** for formats; **Chris** for consolation + late-entry policy (worth porting) |
| Multi-tournament | Yes — tournament-of-tournaments medal table across any number of events | One championship: Cannon + best-3 field placements, podium eligibility rules | **Paul** structurally; Chris's best-3 scoring model is a nice alternative lens |
| Team formation | Random draw from pool, static teams, bench, mid-match same-leg substitution | Dynamic pairing when a station opens, avoid-repeat partners, rotating trio for odd counts, team rename with teammate approval | **Chris** — dynamic pairing + rename-approval flow is charming and thorough |
| Result entry | Scorekeeper taps live scores; host fix/reopen | Player reports → opponent confirms → advances atomically; disputes freeze the match for organizers | **Chris** — confirm/dispute is the right trust model for player-reported results |
| Junkyard Cannon | A bracket preset with house-rule notes | **Full scoring engine**: named target catalog, multi-target stacking shots, Carnage bonus, million-point jackpot, 2 lanes, practice vs scored quotas per shooter, sudden-death shootouts, per-shot audit | **Chris, by a mile** — nothing on Paul's side resembles this |
| Flair / Showboat | — | Props (8 categories, no self-awards, 1/category/recipient), 3-point final vote, live standings | **Chris** — only implementation |
| TV broadcast | — | Rotating panels, match-call graphics, gong + result sting, browser TTS announcer, signup QR bug, ON AIR chrome; Android TV app skeleton | **Chris** — his crown jewel |
| Stations | — | Station pages w/ printed QR, team check-in, per-station queues, 5-min call windows/cooldowns, skip-never-forfeit | **Chris** |
| Music | **Junkyard Jukebox**: Spotify search/browse, fair-rotation request queue, rate-limit bans, 2-hour repeat rule, host player console w/ autoplay + fade-into-requests | — | **Paul** — only implementation |
| Live updates | 4s polling vs synced room; per-match merge for concurrent scorekeepers | Server-sent events stream | **Chris** technically (push), **Paul** practically (no server to run) |
| Ops/recovery | Cloudflare + GitHub are the backup; D1 persists | Verified backups, restore-with-integrity-check, audit log of every override, JSON/CSV export, printable emergency packet | **Chris** — genuinely production-grade ops thinking |
| Brand/design | Chris's t-shirt art + comic-outline pass (adopted earlier) | **Full brand system** (BRAND-SYSTEM.md): soot/cream/rust/flame tokens, Impact display + Courier controls, halftone/inspection-label motifs, per-surface layouts, a11y rules | **Chris** — the design system and the TV/mobile screens are outstanding |
| Game catalog | Cornhole, Horseshoes, Ladder Golf, Lawn Darts, Washers, Cannon, Giant Beer Pong, Field Pong, Can Jam, Custom | + Bocce Ball, Volley Strike, Badminton; named stations ("The Crusher", "Sack Attack"…) | **Merged** — Chris's extra three added to the live site |

## The honest architectural tension

- Chris's system assumes **everyone stays on party Wi-Fi** and one machine hosts
  the event. If that machine or the AP dies, you're on the (excellent) paper packet.
- Paul's system assumes **the internet exists** (Cloudflare + Spotify). Phones on
  cell data work fine even if the yard Wi-Fi melts; there is no host machine to babysit.

For a backyard party, internet-out is rarer than "one laptop got beer on it" —
but Chris designed for exactly that, and the backup/print story is real.

## Recommended merge (decision record)

**Backbone: Paul's cloud stack** — it's deployed, phone-friendly without LAN
dependency, has the jukebox, and both organizers can admin it from anywhere.

**Adopt from Chris, in order of value:**
1. **TV broadcast mode** — port his `tv.html` design to the cloud stack, reading
   the sync room + jukebox now-playing (panels: standings, live matches, match
   calls, signup QR, now spinning). His gong/sting audio + TTS announcer come along.
2. **Flair Props + Showboat vote** — small D1 tables + one page; pure party joy.
3. **Confirm/dispute result flow** — optional mode for player-reported scoring.
4. **Consolation bracket path** — third format alongside single/double elim.
5. **Cannon scoring engine** — port the domain model (targets, stacking, carnage,
   jackpot, lanes, shootout) as a new "scored event" type; OR run `/lan-server`
   as-is on the LAN for Cannon day and hand-enter final placements into the
   medal table (zero-code option for tomorrow).
6. **Design system** — continue folding BRAND-SYSTEM.md tokens/motifs into the
   shared CSS.

**Keep from Paul:** everything currently deployed — brackets (single/double/
seeded), medal table, jukebox, QR join, live sync, admin tools.

**Chris's `/lan-server` stays whole in this repo** — it runs today
(`npm install && npm start` with `ORGANIZER_TOKENS=a,b`, Node 22) and is the
reference implementation for every port above, plus the event-day fallback if
the internet dies: it needs nothing but a laptop.
