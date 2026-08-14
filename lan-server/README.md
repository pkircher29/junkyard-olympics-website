# Junkyard Olympics 2026

A local-first, adults-only backyard tournament control tower for randomized teams, Junkyard Cannon, live standings, Flair, station QR codes, and gloriously overproduced TV announcements.

> Built for Saturday. Designed so a spilled drink, internet outage, or questionable barrel repair does not erase the Olympics.

## Status

**Core engine checkpoints 1–4:** implemented and tested
**Event-safe MVP deadline:** Friday night, August 14, 2026
**Opening ceremony:** Saturday, August 15 at 2:00 PM EDT

See:

- [`docs/SPEC.md`](docs/SPEC.md) — frozen requirements
- [`docs/PLAN.md`](docs/PLAN.md) — implementation and verification sequence
- [`docs/MOBILE-OPS-HOTFIX-SPEC.md`](docs/MOBILE-OPS-HOTFIX-SPEC.md) — corrected phone identity, station QR, result, and sizing contracts
- [`docs/MOBILE-OPS-HOTFIX-PLAN.md`](docs/MOBILE-OPS-HOTFIX-PLAN.md) — strict-TDD hotfix and rollback sequence
- [`docs/EMERGENCY-PRINT-MATERIALS.md`](docs/EMERGENCY-PRINT-MATERIALS.md) — reproducible public QR signs and paper fallback packet

## Scope

Must work tomorrow:

- QR signup and rolling registration
- Dynamic event pools and randomized pairs
- Cannon scoring with targets, multi-hits, Carnage, jackpot, and two lanes
- Head-to-head brackets and consolation path
- Player result reporting plus opponent confirmation
- Cannon + best-three championship standings
- Flair Props and Showboat standings
- Equal organizer consoles for Chris and Paul
- TV broadcast and station QR views
- Local backups, organizer JSON/CSV exports, and a reproducible public outage packet

Deferred until the event-safe core passes:

- ElevenLabs
- Public cloud hosting
- SMS
- Cross-device identity transfer

## Intended Runtime

- **Host:** RecRoomRig
- **Port:** `8790`
- **Database:** local SQLite
- **Normal network:** `Junkyard Olympics` outdoor Wi-Fi to home LAN
- **Internet required during event:** no
- **Total Wi-Fi failure:** print packet fallback

## Checkpoints

**Urgent event-day correction:** stations use printed QR signs and participant phones—never dedicated station screens. The live base remains available while the corrected identity/check-in/result/mobile flow is built and independently reviewed.

- [x] CP0A — Frozen product specification
- [x] CP0B — Complete implementation plan
- [x] CP0C — README with goals and recovery
- [x] CP1 — SQLite foundation, migrations, backup, audit
- [x] CP2 — Participants, event signup, identities, Flair
- [x] CP3 — Cannon and championship scoring
- [x] CP4 — Teams, brackets, scheduling, confirmation
- [ ] CP5 — Participant/organizer/station/TV/print interfaces
- [ ] CP6 — 30-person rehearsal and LAN hands-on acceptance
- [x] H0 — Mobile operations hotfix spec, plan, and README frozen
- [x] H1 — Existing-phone identity guard
- [x] H2 — Truthful station QR check-in portal
- [x] H3 — Participant result reporting and confirmation/dispute
- [x] H4 — Post-signup mobile sizing
- [x] H5 — Accidental duplicate cleanup
- [x] H6 — Cannon setup wizard and two-lane migration
- [x] H7 — Full event-day Control Yard
- [ ] H8 — Full regression, exact review, deploy, and physical QR rehearsal

A checkpoint is not complete because files exist. It is complete only after its acceptance tests actually run and pass.

## Development Commands

Core engine commands (Node.js 22):

Expected interface:

```bash
npm install
npm test
npm run typecheck
npm run build
ORGANIZER_TOKENS="$(openssl rand -hex 32),$(openssl rand -hex 32)" npm start
```

The server binds to `127.0.0.1:8790` by default. Set `HOST=0.0.0.0` only for the event LAN. `DATABASE_PATH` and `DATA_DIR` select persistent storage. Startup refuses to run without organizer bearer credentials and creates a timestamped SQLite backup before listening.

## Operational Recovery

### Outside internet fails

Do nothing. Phones, TV, and organizer devices continue over local Wi-Fi.

### App server restarts

Restart the service. SQLite state is authoritative and survives the process.

### Bad organizer action

Use the audit log and automatic pre-destructive backup. Restore only into a copy first.

### Local Wi-Fi fails

Use the preprinted public packet immediately. It contains public QR signs, blank score/check-in sheets, and Cannon lane ledgers; it intentionally does **not** claim to contain a current roster or bracket snapshot. If the server is still reachable, download the organizer JSON/CSV exports before switching to paper. Enter paper results later; do not debug the access point while competitors wait.

### Laptop/host fails

Use the latest printed packet. A second machine may restore the downloaded backup if time permits.

## Safety

Junkyard Cannon is physical equipment and is outside this software's control. The app records scores; it does not certify barrels, cannons, ammunition, targets, range boundaries, operators, or spectators as safe. Human organizers own the range rules and must stop play whenever conditions are unsafe.

## Brand

`assets/tshirt-brand-reference.png` is the canonical visual reference. The interface should look like a pirate sports network broadcasting from a scrapyard—not a corporate bracket app wearing a rusty hat.
