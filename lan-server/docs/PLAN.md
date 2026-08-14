# Implementation Plan — Event-Safe Build

## Architecture

Use boring technology that can be repaired on Friday night:

- Node.js 22
- TypeScript
- Express HTTP server
- SQLite through `better-sqlite3`
- Server-rendered/static HTML, CSS, and small browser JavaScript modules
- Server-Sent Events for live broadcast updates
- Vitest and Supertest
- QR generation through a small audited library
- Browser speech synthesis plus local audio assets
- One process, one database, no cloud dependency

The server is authoritative. Browsers never directly calculate official standings, advance brackets, or assign points.

## Checkpoint 0 — Written Contract

Deliverables:
- Frozen specification
- This implementation plan
- README with setup, checkpoints, recovery, and acceptance goals

Gate:
- All three exist and are committed before production implementation.

## Checkpoint 1 — Foundation and Data Integrity

Deliverables:
- TypeScript project and strict configuration
- Express application factory separated from process startup
- SQLite schema and numbered migrations
- Transaction helpers
- Event configuration and seed data
- Health endpoint
- Automatic backup and restore commands
- Audit log

TDD slices:
1. Empty database migrates and seeds safely.
2. Restart does not duplicate seed records.
3. Mutations and audit entries commit atomically.
4. Backup can restore into a disposable database.

Gate:
- Focused and full tests green.
- Process restart preserves state.

## Checkpoint 2 — Participants, Events, Identity, and Flair

Deliverables:
- Frictionless signup
- Private participant token cookie/local storage handoff
- Rolling event join/leave
- Heading Out state
- Participant dashboard
- Flair Props and final vote
- Organizer authentication bootstrap

TDD slices:
1. Signup creates unique participant and token hash.
2. Same token restores identity.
3. Duplicate display names remain distinct.
4. Participant can join/unjoin unlocked event.
5. Self and duplicate Flair props are rejected.
6. Final vote is one per voter and worth three.

Gate:
- Authorization probes pass.
- No bearer secrets appear in public API payloads or logs.

## Checkpoint 3 — Scoring Engine

Deliverables:
- Placement point rules
- Cannon target catalog
- Cannon lanes, practices, scored shots, multi-target hits, Carnage, jackpot, and shootouts
- Championship Cannon + best-three field aggregation
- Eligibility and dropped-score explanations

TDD slices:
1. Each shot sums multiple target values.
2. Miss is zero.
3. Carnage adds 50 only with organizer confirmation.
4. Jackpot outranks ordinary totals.
5. Tie shootout breaks top-four ties.
6. Championship counts Cannon and best three field results only.
7. Ineligible participants cannot occupy podium.

Gate:
- Property-style randomized score tests pass.
- Audit shows target and bonus provenance for every score.

## Checkpoint 4 — Teams, Brackets, Scheduling, and Results

Deliverables:
- Dynamic pair formation with availability priority and repeat avoidance
- Rotating trio support
- Safe generated team names and controlled rename
- Single elimination with consolation path
- Late-entry guard at semifinals
- Five-minute cooldown
- Station queue and QR check-in
- Five-minute temporary skip
- Automatic substitutions
- Player report/opponent confirmation/dispute flow

TDD slices:
1. Odd pool creates one trio without dropping a participant.
2. Repeat partner is avoided when a valid alternative exists.
3. No player is called at two stations simultaneously.
4. Confirmation by reporting side is rejected.
5. One opposing participant confirms and advances atomically.
6. Dispute freezes the match.
7. Late entry does not mutate completed matches.
8. Substitute cannot earn duplicate event points.
9. Restart during pending confirmation does not duplicate advancement.

Gate:
- Simulated multi-station day completes without double-booking.
- Crash/restart recovery tests pass.

## Checkpoint 5 — Interfaces and Broadcast

Deliverables:
- Junkyard-branded responsive participant UI
- Organizer console for Chris and Paul
- Cannon scoring console
- Station QR views
- TV Broadcast Mode with rotation, match cards, leaderboard, Flair feed, and QR
- Gong and browser speech announcements
- Print emergency packet

Gate:
- Browser screenshots at phone, tablet, desktop, and TV sizes.
- Keyboard and touch controls work.
- Decorative effects respect reduced-motion preference.
- Print preview has no clipped tables or hidden critical state.

## Checkpoint 6 — Integration and Event Rehearsal

Automated rehearsal:
- 30 named simulated participants
- Cannon with two lanes
- Five simultaneous field events
- Late arrival, departure, substitution, dispute, correction, and restart
- Final podium and Showboat winner

Operational rehearsal:
- Run production build on port 8790.
- Connect phone from Junkyard Olympics SSID.
- Connect organizer tablet.
- Connect TV broadcast view and audio output.
- Print the verified public emergency packet and scan all eight official station QRs; separately verify organizer JSON/CSV current-state exports while the server is reachable.
- Kill and restart service; verify state.
- Restore latest backup to a disposable path.

Release gate:
- No known critical/high defects.
- Full automated suite green.
- Production build starts from clean checkout.
- Exact artifact independently reviewed.
- Chris completes hands-on acceptance Friday night.

## Explicit Deferrals

These cannot block Saturday:
- ElevenLabs integration and generated audio caching
- Public internet hosting
- SMS
- Cross-device identity transfer QR
- Perfect offline multi-device synchronization after total Wi-Fi failure
- Advanced optimal scheduling solver
- Elaborate animated replays

Each deferred item has a safe MVP substitute: browser speech, local LAN, same-device identity, heuristic scheduler, organizer exports while the server is reachable, and a preprinted blank public packet for total Wi-Fi failure.

## Rollback

- Every release is a Git commit.
- Database is backed up before upgrade and destructive operations.
- Previous package can run against a copied database, never the only live file.
- If a release fails Friday acceptance, revert to the latest green checkpoint.
- If the network fails Saturday, print/switch to paper; do not attempt risky live infrastructure changes.
