# Junkyard Olympics MVP — Adversarial QA Matrix

**Contract status:** frozen acceptance contract for implementation branches  
**Source of truth:** [`SPEC.md`](SPEC.md) and [`PLAN.md`](PLAN.md)  
**Executable suite:** [`../tests/acceptance-contract.test.mjs`](../tests/acceptance-contract.test.mjs)

## Running the contract

The harness has no package dependency and does not alter the production project.

```bash
# Running server (default shown explicitly)
JO_BASE_URL=http://127.0.0.1:8790 node --test --test-concurrency=1 tests/acceptance-contract.test.mjs

# Or ask the harness to import and listen on an ephemeral loopback port
JO_APP_MODULE=./dist/src/app-factory.js node --test --test-concurrency=1 tests/acceptance-contract.test.mjs
```

`JO_APP_MODULE` is resolved from the repository root. It may export an Express-compatible `app`, a default object with `listen()`, or `createApp()` (sync or async). If neither variable is supplied, the harness probes `http://127.0.0.1:8790`. Use Node 22 as specified by the implementation plan. Test names include stable QA IDs. The suite is intentionally RED until an implementation exposes the contract below.

The checked-in default organizer values are convenience placeholders and are intentionally too short for the production credential policy. For the injectable factory, supply distinct high-entropy values to both the harness and application:

```bash
DATA_DIR=/tmp/jo-acceptance \
JO_APP_MODULE=./dist/src/app-factory.js \
JO_ORGANIZER_CHRIS=acceptance-chris-high-entropy-secret \
JO_ORGANIZER_PAUL=acceptance-paul-high-entropy-secret \
ORGANIZER_TOKENS=acceptance-chris-high-entropy-secret,acceptance-paul-high-entropy-secret \
node --test --test-concurrency=1 tests/acceptance-contract.test.mjs
```

The suite creates unique data and never resets a live database. Run it only against a disposable acceptance database. Organizer credentials are supplied through `JO_ORGANIZER_CHRIS` and `JO_ORGANIZER_PAUL` and must be bootstrapped by the disposable test instance. Never point this suite at the Saturday event database.

## Public HTTP acceptance contract

JSON requests use `Content-Type: application/json`; successful creation returns `201`, ordinary success `200`, and an idempotent replay may return the original success code. Error bodies are JSON containing a stable `error.code`. Bearer credentials use `Authorization: Bearer <token>`. Responses may contain extra fields, but must contain the fields asserted by the suite.

| Capability | Method and route | Minimum request / response contract |
|---|---|---|
| Health | `GET /api/health` | `200 {ok:true}` |
| Signup | `POST /api/participants` | `{displayName}` → `201 {participant:{id,displayName},token}` |
| Restore self | `GET /api/me` | participant bearer → same participant; no token in body |
| Public roster | `GET /api/participants` | array under `participants`; no private tokens |
| Events | `GET /api/events` | event objects `{id,name,kind}` |
| Pool membership | `PUT/DELETE /api/events/:eventId/participants/me` | participant bearer; membership state returned |
| Pair formation | `POST /api/events/:eventId/teams/form` | organizer bearer, optional `{participantIds}` → `{teams}` |
| Cannon setup | `POST /api/cannon/runs` | organizer bearer `{eventId,teamIds,laneIds}` → run/team assignments |
| Cannon shot | `POST /api/cannon/runs/:runId/shots` | organizer bearer; `{teamId,laneId,sequence,kind,targetIds,carnage}` |
| Cannon standings | `GET /api/cannon/runs/:runId/standings` | ranked totals, jackpot and tie state |
| Tie shot | `POST /api/cannon/runs/:runId/shootout-shots` | organizer bearer, auditable sudden-death round |
| Scheduler | `POST /api/schedule/call-next` | organizer bearer `{stationId,now}` → called match or explicit none |
| Check-in | `POST /api/matches/:matchId/check-ins` | participant bearer `{teamId}` |
| Result report | `POST /api/matches/:matchId/result-reports` | participant bearer `{winnerTeamId,idempotencyKey}` |
| Confirm/dispute | `POST /api/matches/:matchId/result-confirmations` | participant bearer `{agree,idempotencyKey}` |
| Match read | `GET /api/matches/:matchId` | status, report, dispute and advancement |
| Late entry | `POST /api/events/:eventId/bracket/late-entries` | organizer bearer `{participantId}` |
| Heading out | `POST /api/participants/me/departure` | participant bearer |
| Substitute | `POST /api/matches/:matchId/substitutions/auto` | organizer bearer; public audit record |
| Championship | `GET /api/standings/championship` | total, Cannon, counted/dropped field scores, eligibility |
| Flair prop | `POST /api/flair/props` | participant bearer `{recipientId,category,idempotencyKey}` |
| Showboat vote | `PUT /api/flair/showboat-vote` | participant bearer `{recipientId,idempotencyKey}` |
| Flair standings | `GET /api/standings/flair` | prop points + vote points + total |
| Organizer backup | `POST /api/admin/backups` | organizer bearer → backup metadata/download URL |
| Export | `GET /api/admin/export.json`, `.csv` | organizer bearer; downloadable current state |
| Restore | `POST /api/admin/restores` | organizer bearer `{backupId,idempotencyKey}`; disposable DB only |
| UI surfaces | `GET /`, `/organizer`, `/station/:id`, `/tv`, `/print`, `/public-print-packet.pdf` | usable HTML; station/TV no organizer controls; `/print` truthfully hands off to the verified public PDF |

The implementation may add endpoints. If its route design differs, add a thin acceptance adapter or coordinate an explicit contract revision; do not silently weaken assertions.

## Adversarial matrix

Priority: **P0** blocks event operation or corrupts results; **P1** materially harms fairness/recovery; **P2** presentation or defense-in-depth issue. Automation values refer to stable test IDs.

| ID | Pri | Area | Adversarial setup / action | Required oracle | Automation |
|---|---:|---|---|---|---|
| ACC-001 | P0 | Reachability | Probe a clean acceptance instance | Health returns JSON `{ok:true}`, not a redirect/error page | executable |
| ACC-002 | P0 | Capacity | Register all 30 fixture adults | 30 distinct IDs and 30 usable private tokens | executable |
| ACC-003 | P0 | Identity | Register two people named `Alex Scrap`, refresh using each token | Names may duplicate; IDs/tokens may not; each token restores only its owner | executable |
| ACC-004 | P0 | Authorization | Participant B reads/mutates A resources; anonymous mutation | `401/403`; no cross-identity state change; no token in public roster | executable |
| ACC-005 | P1 | Pools | Rapidly join, duplicate-join, leave, duplicate-leave | Membership is idempotent and final state is correct | executable |
| ACC-006 | P1 | Pairing | Form teams from 30 then 15 available adults | Even pool covers each once in pairs; odd pool covers each once with exactly one trio | executable |
| ACC-007 | P1 | Pairing fairness | Form teams across events/history | Avoid prior partners/recent opponents when an alternative exists; trio rotates | executable |
| ACC-008 | P0 | Cannon capacity | Assign pairs across two live lanes | Both lanes used; no team/player active in both | executable |
| ACC-009 | P0 | Cannon shots | Submit exactly 20 scored and 10 practice shots/team, including replay | Practice excluded; scored count exactly 20; idempotency prevents duplicate shot | executable |
| ACC-010 | P0 | Cannon scoring | One scored shot hits 10 + 25 targets | Shot is auditable and adds 35, not first/last-only | executable |
| ACC-011 | P0 | Carnage | Participant attempts Carnage, then organizer confirms | Unauthorized attempt rejected; confirmed bonus is exactly +50 and grants one destruction prop to both teammates | executable |
| ACC-012 | P0 | Jackpot | Low-total team hits configured washer | Jackpot team ranks first regardless ordinary total; provenance is visible | executable |
| ACC-013 | P0 | Cannon tie | Create tie affecting places 1–4; submit equal then unequal sudden-death rounds | Tie remains after equal round and resolves only after broken | executable |
| ACC-014 | P1 | Bracket | Run eight teams; first-match loser enters consolation | Main top four unaffected by consolation; two matches offered when time permits | executable |
| ACC-015 | P0 | Confirmation | Reporter or reporter's teammate tries to confirm | Same-side confirmation rejected; one opposing member finalizes atomically | executable |
| ACC-016 | P0 | Dispute | Opponent disagrees with reported winner | Match freezes, organizer dispute exists, bracket does not advance | executable |
| ACC-017 | P0 | Scheduler | Two stations request next match simultaneously with overlapping player | At most one active/called match contains that player | executable |
| ACC-018 | P1 | Cooldown | Scheduler retries player at 4:59 and 5:00 after completion | Ineligible before boundary; eligible at/after boundary or documented organizer override | executable |
| ACC-019 | P1 | Timeout | Do not check in for five minutes; scheduler advances | Match is temporarily skipped, never forfeited; re-enters after check-in | executable |
| ACC-020 | P0 | Late entry | Add before semifinal, snapshot bracket, add after semifinal begins | Before accepted without rewriting results; after rejected from championship and completed state byte-equivalent | executable |
| ACC-021 | P0 | Departure | Depart one teammate and auto-substitute eliminated player | Completed history retained; substitution public/reversible; no duplicate placement points | executable |
| ACC-022 | P0 | Standings | Apply fixture Cannon + 5 field placements | Cannon always counts; only best 3 fields count; counted/dropped transparent | executable |
| ACC-023 | P0 | Eligibility | Missing Cannon or fewer than 3 completed fields | Ineligible competitor cannot occupy championship podium | executable |
| ACC-024 | P1 | Flair props | Self-prop, duplicate category prop, distinct category prop | Self/duplicate rejected; each unique permitted prop worth exactly 1 | executable |
| ACC-025 | P1 | Showboat vote | Vote twice/replay request | Exactly one final vote per voter, worth exactly 3; Flair never changes championship | executable |
| ACC-026 | P0 | Restart | Restart after committed result and during pending confirmation; replay same key | State/identities persist; exactly one bracket advancement/audit mutation | executable with imported app; manual otherwise |
| ACC-027 | P0 | Backup | Create backup, mutate disposable DB, restore, export | Backup precedes destructive restore; JSON/CSV non-empty and restored state matches snapshot | executable |
| ACC-028 | P0 | XSS | Names/team names contain `<script>`, event handlers, HTML entities | JSON preserves safe text; every HTML surface escapes it; no executable markup | executable |
| ACC-029 | P1 | Bounds | Empty and oversized (257-character) names/category/announcement | `400/413` stable validation error; bounded value never enters public output | executable |
| ACC-030 | P1 | Rate limits | Burst signup, login, vote, and result report | Eventually `429` with `Retry-After`; accepted retries remain idempotent | executable (signup), extension cases documented |
| ACC-031 | P1 | TV | Load `/tv` at 1920×1080 and inspect content | Signup QR, standings, matches, queues, Cannon lanes and Flair visible; no organizer mutation controls | executable structural + manual visual |
| ACC-032 | P1 | Station | Load stable station URL before/after match changes | Truthful participant-phone shell, printed-QR guidance, credential restore, live match/check-in containers, and station script present; no embedded rehearsal fixtures; URL remains reusable | executable structural + manual QR scan |
| ACC-033 | P0 | Print | Request `/print`, `/print.html`, and `/public-print-packet.pdf` | Legacy routes truthfully hand off; PDF is the committed public packet with signup/station QR materials, blank field sheets, and Cannon lane ledgers; no secrets or live-looking fixtures | executable structural + manual print preview |
| ACC-034 | P2 | Responsive/accessibility | Phone 390×844, tablet 1024×768, TV 1920×1080, reduced motion, keyboard/touch | No clipped critical data; controls operable; readable; motion reduced | manual browser pass |
| ACC-035 | P0 | LAN/offline | Disconnect WAN while LAN clients remain; then simulate Wi-Fi loss | LAN stays functional without third parties; the preprinted public packet permits immediate paper recording without claiming cached state is current | Friday hands-on |
| ACC-036 | P0 | Audit/atomicity | Race duplicate confirmations and destructive actions | Single advancement; correction/override/reset includes actor/time; failed transaction has no partial state | executable |

## 2026-08-14 acceptance-harness reconciliation

The previously adjudicated setup defects were corrected without weakening production safety: matches are called and checked in before reports, late entrants are genuinely unassigned, substitution leavers belong to the selected called match, Flair actors are active, and podium assertions use the dedicated eligible `podium` projection. The station and print assertions now target the approved participant-phone and verified-public-packet contracts. Late-entry play-ins are exposed in the bracket projection so they can be completed through public APIs rather than SQLite edits.

Verified command: `JO_APP_MODULE=./dist/src/app-factory.js node --test --test-concurrency=1 tests/acceptance-contract.test.mjs` with the documented disposable data path and two high-entropy organizer credentials. Result: **25/25 passed**.

Retained logs, simulation reports, source blob hashes, and SHA-256 checksums: [`../artifacts/qa/EVIDENCE.md`](../artifacts/qa/EVIDENCE.md).

## Manual viewport and operational matrix

| Surface | Phone 390×844 | Tablet 1024×768 | TV 1920×1080 | Print Letter/A4 | Offline/LAN |
|---|---|---|---|---|---|
| Participant `/` | signup, restore, status, report, Flair; keyboard/touch | same | n/a | n/a | refresh after WAN unplug |
| Organizer `/organizer` | emergency usable | primary control target | no secrets if mirrored | print trigger and backup link | two independent organizer sessions |
| Station `/station/:id` | QR destination/check-in | queue steward view | readable nearby | QR remains stable | two devices check in concurrently |
| TV `/tv` | smoke only | smoke only | 10-foot readability, auto-rotation, reduced motion, audio controls | n/a | reload after WAN unplug |
| Emergency `/print` | truthful PDF handoff | preview trigger | n/a | verified public PDF prints without clipping; station sheets and Cannon ledgers present | preprinted packet accessible without server or Wi-Fi |

## Exit gate

Release acceptance requires all executable P0/P1 tests green against a clean build and disposable SQLite database, no unexpected skips, the manual viewport/LAN/print rows signed off, and a retained TAP log plus JSON/CSV/backup artifacts. A test may be waived only with organizer approval, documented risk, paper fallback, and owner. “Endpoint not implemented,” connection refusal, syntax error, and a test disabled with `.skip` are failures—not waivers.
