# Event-Day Mobile Operations Hotfix — Frozen Specification

**Status:** Founder-approved 2026-08-14
**Protected base:** `9bcb43c68fa57918fcb17697361fa4f3b6ed8083`
**Priority:** Blocks event-day operational approval

## Problems confirmed on the live approved base

1. Opening signup repeatedly on one phone can create multiple participant records and overwrite the locally saved identity.
2. The called-match check-in action links to a hard-coded station mock instead of performing a real authenticated check-in.
3. The hard-coded station page contains fictional teams and controls in live mode.
4. The participant page drops the current match after it becomes active and offers no result-reporting or opponent-confirmation controls.
5. The API client sends `accepted` for confirmation while the server contract expects `agree`.
6. Post-signup participant, station check-in, organizer, and Cannon screens have text/buttons/cards that feel too small or awkward on a real phone. Signup itself is founder-approved and must retain its current visual sizing.
7. The Cannon scoring page truthfully locks when no run exists, but no organizer setup wizard is exposed.
8. The Cannon assignment schema/API incorrectly requires a unique lane id per team even though many teams rotate through two physical lanes.
9. The event catalog exposes only four field games and the station catalog exposes only two generic stations; it cannot represent the confirmed event-day equipment or constrain a match to its game.

## 1. Existing-phone identity gate

When `/` loads and a participant token exists:

1. Call authenticated `GET /api/me`.
2. If valid, hide/disable the signup form and show **This phone is registered to [display name]**.
3. Primary action: **Continue as [display name]** → `/participant.html`.
4. Secondary action: **Switch person on this phone**.
5. Switching requires explicit confirmation explaining that it removes only this browser's saved pass; it does not delete the participant or tournament history.
6. After confirmation, clear the local token and reveal a fresh signup form.
7. If the stored token is invalid/revoked, clear it and allow signup with a helpful recovery message.
8. Never create a participant merely by loading or switching.
9. Rescanning the public signup QR in the same browser profile follows this identity gate and performs zero participant-creation requests. Refresh, back/forward navigation, home-screen launch, and repeated QR opens must retain the saved identity.

Duplicate display names remain legal because two adults may share a name. The guard prevents accidental repeat signup from a valid existing browser identity; it does not claim to prevent incognito/cleared-storage duplicates.

## 2. Physical station model

There is **no device or screen at a station**.

Each station has a printed QR sign. The QR opens `/station/<station-id>` on the participant's own phone. The station route is a mobile check-in portal, not a public scoreboard.

The confirmed catalog is:

| Mode | Public game | Physical routing |
|---|---|---|
| Opening team event | Junkyard Cannon | Separate reusable Lane 1 / Lane 2 rotation |
| Official scored | Ladder Ball | **The Crusher** station |
| Official scored | Field Pong | **Scrap Heap Two** station |
| Official scored | Cornhole | **Sack Attack** station |
| Official scored | KanJam | **Can Crusher Court** station |
| Official scored | Lawn Darts | **Flight Risk** station |
| Official scored | Bocce Ball | **The Gravel Pit** station |
| Official scored | Volley Strike | **Strike Yard** station |
| Official scored | Washers | **Washer Wreck** station |
| Casual signup interest | Horseshoes | No station, bracket, calls, scoring, or standings |
| Casual signup interest | Badminton | No station, bracket, calls, scoring, or standings |

All eleven activities appear in signup so guests can express what they want to play. Casual activities are visibly labeled **Casual play** and never enter team formation or tournament scheduling. Each official field game has exactly one stable station record with an explicit event relationship. Calling next at a station may select only a playable pending match for that station's assigned event. Future bracket placeholders (`BYE`/unknown prior-round winners) are not shown as playable matches and cannot be called.

Flow:

1. TV and participant dashboard call the match and name the station.
2. Competitors physically report to that station.
3. One member of each team scans the station QR sign.
4. The page uses the existing participant bearer and authoritative state to find that participant's `CALLED` match assigned to that exact station.
5. It shows only the real participant, teams, event, station, and countdown.
6. Participant taps **I'm here — check in my team**.
7. The client calls `POST /api/matches/<match-id>/check-in` with the participant bearer.
8. One member check-in represents the team; repeated check-in is idempotent.
9. A participant not in that called match, wrong station, expired call, invalid identity, or non-called match cannot check in.
10. After both teams have one check-in, the authoritative match becomes `ACTIVE`.

The live station route must contain no sample people, teams, countdowns, queues, or scores. Any illustrative station fixtures require exact `?demo=1` and a visible Demo label.

## 3. Participant match action state machine

The participant feed shows one operational card for the current relevant match:

- `CALLED`: station, matchup, five-minute countdown, and instruction to scan the printed station QR. The normal dashboard does not check the participant in remotely.
- `ACTIVE`: matchup plus **Report result** actions for both real teams.
- `AWAITING_CONFIRMATION`:
  - reporter's team sees **Waiting for the other team to confirm**;
  - opposing team sees reported winner and **Confirm result** / **Dispute result**.
- `DISPUTED`: both teams see **Organizer review required**; no further participant mutation.
- `FINAL`: moves to completed results and no longer appears as current work.

Result report calls `POST /api/matches/<id>/report` with `winningTeamId`.

Confirmation calls `POST /api/matches/<id>/confirm` with `{ "agree": true }`. Dispute calls the same endpoint with `{ "agree": false }`. The client and server contract must use the same field. Only the opposing team may confirm/dispute; the reporter's team cannot self-confirm.

Every enabled button must perform and verify a real state mutation. It disables while submitting, handles idempotent replay, reports precise errors, then refreshes authoritative state.

## 4. Post-signup mobile sizing

Founder feedback applies to participant, station check-in, organizer, and Cannon screens—not signup.

At 360×800, 390×844, 768×1024, 834×1194, and tablet landscape:

- no horizontal overflow or clipped controls;
- body/control explanatory text at least 18px where space permits, never below 17px;
- inputs/selects at least 20px text;
- primary actions at least 60px high and full usable width;
- secondary/destructive actions at least 52px high;
- event/match/control cards at least 80px high with 16px minimum internal gap;
- two-column control rows collapse to one column before clipping or tiny buttons;
- sticky/fixed regions respect safe-area insets and do not cover actions;
- tables become stacked cards or horizontally self-contained labeled rows; the page itself never scrolls horizontally;
- focus, disabled, loading, success, error, and destructive states remain visually distinct outdoors.

Signup artwork, signup type scale, signup event cards, and signup button sizing remain unchanged except for the identity gate.

## 5. Organizer duplicate cleanup

The hotfix does not silently delete existing accidental participants. Chris or Paul can use existing participant active/departure controls where available; if a direct organizer deactivate control is absent, add a narrowly scoped authenticated **Deactivate accidental signup** control with confirmation, backup/audit, and no history deletion.

Deactivation must not alter another participant merely because display names match. Selection uses stable participant id and shows created time/event entries to distinguish duplicates.

## 6. Acceptance tests

1. Valid saved participant blocks signup and shows correct Continue/Switch gate.
2. Continue does not create or modify a participant.
3. Switch requires confirmation, clears only local identity, and permits one new signup.
4. Invalid saved token recovers without creating records.
4a. A real browser signs up once, closes/reopens the public QR URL, and proves the participant count and audit count do not increase; Continue restores the same participant id.
5. Live station page contains no fictional names/teams/scores and requires participant identity.
6. Wrong station/non-member/expired/non-called requests fail closed.
7. One participant per team check-in activates the match; replay is idempotent.
8. Participant feed preserves CALLED, ACTIVE, AWAITING_CONFIRMATION, and DISPUTED operational states.
9. Real report, opposing confirmation, dispute, self-confirm rejection, replay, and refresh behavior pass end to end.
10. API helper sends `agree`, not `accepted`.
11. Every enabled control changes authoritative state/audit; no toast-only control remains.
12. Exact 360×800 and 390×844 participant/station/organizer/Cannon captures have zero overflow, zero console errors, and meet sizing floors.
13. Signup baseline screenshots and size metrics remain unchanged except for existing-identity state.
14. Existing 130 tests, typecheck/build, Android gates, two 68/68 simulations, auth/security tests, TV truth/audio, and backup/restore remain green.
15. Exact snapshot receives independent fail-closed review before replacing the live service.
16. The database exposes eleven signup activities and exactly eight fixed official field stations with the catalog/mappings above.
17. Station call-next cannot cross event boundaries; casual activities cannot form teams, create brackets, receive calls, or produce standings.
18. Organizer station rows show game/team names rather than UUIDs, and future bracket placeholders are hidden behind a truthful count.
19. Printed QR and emergency packets contain all eight station signs, their game subtitles, stable routes, and no organizer credential.
20. ONN remote Left selects the previous enabled TV panel; Right and Center/Enter select the next; navigation wraps in both directions, resets the normal 12-second countdown, and never disables timed rotation. The native wrapper reloads only when the page navigation API is unavailable.

## 7. Cannon setup wizard and two-lane rotation

The authenticated Control Yard provides a **Set up Cannon** workflow before shot scoring:

1. Show current Cannon enrollment count and any already formed Cannon teams.
2. Form teams only from active Cannon entrants who are not already assigned. Use the existing fair pairing/trio rules and show a complete preview before confirmation.
3. Allow Chris or Paul to enter the real physical target catalog when the field is ready: name, non-negative integer points, and optional single jackpot marker. No fake default targets are created.
4. Show all Cannon teams and assign them alternately to the two reusable physical lanes: `Lane 1`, `Lane 2`, `Lane 1`, `Lane 2`, and so on.
5. Preview team members, target catalog, lane rotation, 10 team practice shots, 20 team scored shots, individual 5/10 quotas, Carnage +50, and jackpot behavior.
6. Require explicit confirmation and automatic backup, then create the run transactionally.
7. Redirect/open the Cannon scoring page, which must load the created run and unlock only truthful controls.

The schema and API permit multiple teams to share one lane within a run while retaining one assignment per team. A migration rebuilds `cannon_run_assignments` without `UNIQUE(run_id,lane_id)`, preserving every existing assignment and foreign-key relation. Reusing a physical lane does not relax shot uniqueness: `(run, team, kind, sequence)` remains unique.

The setup operation is idempotent and refuses to create a conflicting second active run. Target names/points and team preview remain editable only before confirmed scoring begins; once the first scored shot exists, team/run/target structure locks unless a separately backed-up organizer correction path is explicitly implemented and tested.

Additional Cannon acceptance:

- fifteen teams can be assigned across exactly two lane ids;
- both lanes are used when at least two teams exist;
- team conservation, original-member quotas, target validation, jackpot, Carnage, shot replay, standings, top-four ties, and sudden death remain green;
- missing entrants, teams, targets, or explicit confirmation leaves scoring locked with a precise setup message;
- setup and shot controls meet the mobile sizing contract at 360×800 and 390×844;
- the wizard performs real authenticated API mutations and audit entries—no toast-only controls.

## 8. Full event-day Control Yard

The authenticated Control Yard provides explicit, bounded operations instead of a generic database editor.

### Participants

- Search and identify people by display name, stable id, created time, active state, and selected activities.
- Edit display name and activity selections.
- Activate or deactivate one stable participant id; duplicate names never select together.
- Deactivation retains history, creates and verifies a backup, and is blocked during live match involvement or when it would leave an official team below two active members.

### Teams and lineups

- Filter teams by activity and view active/original members.
- Rename teams, move a participant, swap two participants, add/remove a member, and record a substitute.
- A participant cannot be active on two teams in the same activity; scored official teams must retain a playable roster. ADD, MOVE, SWAP, and SUBSTITUTE require authoritative enrollment in that activity and never create enrollment as a side effect.
- Before play, ordinary lineup edits are allowed. A `CALLED` match must be requeued before its lineup changes. `ACTIVE`, `AWAITING_CONFIRMATION`, and `DISPUTED` lineups are locked.
- Cannon original-member shot quotas remain frozen after run confirmation. Later changes use the audited substitution path and never rewrite earned points or original quotas. A replacement physically takes only the departed original member's remaining shots, while those shots remain credited to that original quota owner; 0-shot, partial-quota, and completed-quota departures are all explicit tested states.

### Matches, brackets, results, and stations

- Requeue a called match. Bracket-linked matches cannot be cancelled because cancellation could strand winner/loser advancement; cancellation is reserved for a provably standalone administrative match. Assigning a match fails if the station is bound to another event or already has a live match.
- Open/close a station and open/close an activity. Closing an occupied station or an activity with a live match requires requeueing or resolving that match first. An idle station's mapped official game can be changed only as an atomic idle-station swap that preserves one station per official game.
- Regenerate an event bracket only before real play begins. Auto-finalized BYE rows are treated as unplayed, and regeneration rebuilds canonical bracket topology from the current playable enrolled teams instead of cloning stale rows.
- Correct a reported/final winner only with an explicit reason, confirmation, and automatic verified backup. Correction fails closed if any affected winner-edge or loser-edge descendant has started or completed. Safe corrections update only unstarted downstream slots and atomically rebuild terminal first-through-fourth placements when FINAL and THIRD_PLACE remain complete.
- There is no arbitrary status dropdown and no raw SQL/data editor.

### Mutation safety and UX

- Every destructive operation gathers the exact requested values first, names the affected participant/team/match/station in plain language, previews consequences, requires final confirmation, creates and integrity-checks a pre-change backup, and writes organizer-attributed structured before/after snapshots.
- Idempotency is bound to the authenticated organizer, operation, and canonical request payload. Exact concurrent replay returns the original response exactly once; reuse by another organizer or with a materially different payload fails closed.
- Controls lock without organizer authorization and remain usable at phone and tablet breakpoints.
- Errors state exactly why an action is blocked and the safe prerequisite (for example: **Requeue this match before editing its lineup**).

Additional acceptance:

- same-name participant isolation; event-membership conservation; one-team-per-event invariant; playable-roster invariant;
- CALLED requeue-before-edit and live-state lineup locks;
- station/event binding, live occupancy, idle mapped-game swap, and occupied-close protection;
- canonical pre-play bracket regeneration including auto-BYE topology and post-start rejection;
- result correction across winner and loser descendants, terminal placement rebuild, and started-downstream rejection;
- verified-backup, structured before/after audit, actor/payload idempotency, and concurrent replay proof for every destructive operation;
- real browser exercise at phone/tablet sizes with no toast-only or inert controls.

## 9. Rollback

The currently live exact base `9bcb43c…` remains available. Before hotfix deployment, take an integrity-checked database backup. On any regression, restore the service to that exact worktree/release and restore the database only if migration/state integrity requires it. The photo-wall branch remains independent and does not participate in this hotfix deployment.
