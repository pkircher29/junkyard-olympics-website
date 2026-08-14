# Event-Day Mobile Operations Hotfix — Implementation Plan

**Status:** Founder-approved 2026-08-14
**Spec:** [`MOBILE-OPS-HOTFIX-SPEC.md`](./MOBILE-OPS-HOTFIX-SPEC.md)
**Protected base:** `9bcb43c68fa57918fcb17697361fa4f3b6ed8083`

## Execution rules

- Strict RED → GREEN → REFACTOR.
- Work only on `fix/station-mobile-flow`.
- Signup visual sizing is frozen; only its existing-identity state may change.
- No station device assumptions and no live fixture data.
- Use existing server transactions/routes wherever correct; add aliases only when they call the canonical path.
- Run heavy web, Chrome, Gradle, and simulation gates serially.
- Do not touch photo-wall worktrees, production Constellation, FamilyOS, or the Constellation Shield.
- Independent review binds to an exact clean commit before deployment.

## H0 — Documentation checkpoint

- Commit this spec, plan, and README status before production code.
- Record the live base SHA and backup path.
- Preserve user feedback as acceptance criteria.

## H1 — Identity guard TDD

### RED

- Existing valid participant token shows the registered-phone gate and suppresses signup mutations.
- Continue opens the participant pass without a POST.
- Switch requires confirmation and clears only local token.
- Cancel preserves identity.
- Invalid/revoked token clears safely and reveals signup.
- Rapid reload/double action cannot create extra participants.
- Playwright signs up once, reopens the exact public QR URL in the same persistent browser context, and asserts zero second participant POSTs plus stable participant/audit counts.

### GREEN

- Add safe participant-token presence/read helper without exposing token.
- Add identity-gate markup and controller logic.
- Keep signup size/style and normal first-time flow unchanged.

### Gate

- Focused identity tests, signup tests, browser network interception, 360/390 screenshots, full suite/typecheck/build.

## H2 — Correct station QR portal TDD

### RED

- `/station/<id>` live HTML has no fictional names/teams/scores.
- Unauthenticated phone shows signup/continue recovery, no check-in mutation.
- Authenticated participant sees only their real CALLED match at that station.
- Wrong station/member/state/expired call fails.
- Check-in uses `/api/matches/<id>/check-in`, participant bearer, and no caller-supplied team id.
- One participant per team activates; replay remains idempotent.

### GREEN

- Replace hard-coded station HTML with truthful mobile shell.
- Add `station-page.js` using `getMe/getState` and participant identity.
- Replace/remove wrong `stationCheckIn(stationId, teamId)` helper with `checkInMatch(matchId)`.
- Render real station/event/teams/countdown and real check-in state.
- Keep station QR URLs unchanged so printed signs remain valid.
- Add the frozen eleven-activity catalog and eight fixed event-bound stations through a preserving migration.
- Constrain station call-next to the station's assigned event and fail closed for casual activities and future bracket placeholders.
- Render station name plus game subtitle in participant calls, station portal, organizer board, TV, print, and emergency materials.

### Gate

- Focused station/API/browser tests, live-empty truth check, no console/overflow, full suite/typecheck/build.

## H3 — Participant current-match/result state machine TDD

### RED

- Feed selects CALLED, ACTIVE, AWAITING_CONFIRMATION, and DISPUTED in deterministic priority.
- CALLED dashboard instructs scan-at-station rather than remote check-in.
- ACTIVE provides two real team winner choices.
- Reporter team cannot self-confirm and sees waiting state.
- Opposing team sees reported winner and confirm/dispute.
- Client sends `agree`; backend rejects/accepts truthfully.
- DISPUTED shows organizer-required state with no enabled mutation.
- FINAL moves to results.

### GREEN

- Extend pure participant feed decoration with reporter team/reported winner/current status.
- Add accessible action regions to participant HTML.
- Wire report/confirm/dispute with disabled in-flight state and authoritative refresh.
- Correct confirmation request body.

### Gate

- Pure tests plus real API/browser flow through call → station check-ins → active → report → confirm and separate dispute flow.
- Audit entries and match advancement verified.
- Full suite/typecheck/build.

## H4 — Post-signup mobile sizing TDD

### RED

- Measure actual computed size and overflow at 360×800, 390×844, 768×1024, 834×1194, and tablet landscape for participant CALLED/ACTIVE/confirmation/dispute, station, organizer locked/authenticated, and Cannon configured/unconfigured.
- Assert sizing floors from spec.
- Capture baseline signup metrics and forbid regression.

### GREEN

- Add narrowly scoped `.participant-page`, `.station-mobile-page`, `.organizer-page`, and `.cannon-page` responsive rules.
- Increase text/actions/cards; collapse cramped rows; replace mobile tables with labeled stacked rows where required.
- Preserve desktop and TV CSS.

### Gate

- Exact phone and tablet screenshots inspected visually.
- Zero overflow and console errors.
- Real phone acceptance remains required.

## H5 — Accidental-participant organizer cleanup

### RED

- Stable participant id selection; duplicate display names never select together.
- Organizer-only deactivate, explicit confirmation, audit, and retained history.
- Replayed deactivate is idempotent; non-organizer denied.
- Current/active match safety prevents destructive state corruption.

### GREEN

- Reuse existing departure/deactivation transaction if safe; otherwise add narrow organizer endpoint and control.
- Show display name, created time, event count, and active status.

### Gate

- Create two identical names and prove only selected id deactivates.
- Full security/audit tests.

## H6 — Cannon setup wizard and two-lane migration

### RED

- Migration removes `UNIQUE(run_id,lane_id)` while preserving rows, foreign keys, and one assignment per run/team.
- Fifteen teams can share exactly `Lane 1` and `Lane 2`; fewer than two teams use only valid configured lanes.
- Repeated/conflicting setup cannot create duplicate active runs, targets, teams, or assignments.
- Missing Cannon entrants, teams, targets, or confirmation leaves scoring locked.
- Existing shot sequence, shooter quotas, Carnage, jackpot, standings, top-four tie, shootout, finalize, backup, and restore behavior remains unchanged.
- Setup controls are organizer-only, attributable, confirmed, backed up, and truthful.

### GREEN

- Add numbered assignment-table migration and update run validation for reusable lane ids.
- Add organizer Cannon setup UI: enrollment/team preview, form teams, dynamic target editor, two-lane alternating preview, confirmation, backup, target creation, and run creation.
- Lock setup structure after scoring begins.
- Refresh authoritative state and open the unlocked scoring ledger on success.

### Gate

- Migration upgrade/restore test on a representative v5 database.
- Real browser setup from enrolled participants through first practice/scored shot.
- Fifteen-team/two-lane conservation and quota simulation.
- Mobile 360/390 exact screenshots and controls.
- Full suite/typecheck/build.

## H7 — Full event-day Control Yard TDD

### RED

- Participant name/activity/active edits isolate stable ids and preserve history.
- Team rename/move/swap/add/remove/substitute preserve enrollment, one-team-per-event, playable-roster, and original Cannon quota-owner invariants.
- CALLED lineups require requeue; ACTIVE/AWAITING_CONFIRMATION/DISPUTED lineups reject mutation.
- Match requeue, activity/station availability, station mapped-game swap, and station assignment respect event binding and live occupancy. Bracket-linked cancellation fails closed.
- Bracket regeneration succeeds only before real event play, accepts auto-finalized BYEs as unplayed, and rebuilds from current playable teams.
- Result correction requires exact values, reason, final confirmation, and a verified backup; it traverses winner/loser descendants, rebuilds terminal placements, and rejects started downstream impact.
- Every destructive endpoint proves organizer auth, structured before/after audit, verified backup, actor+payload idempotency, and exact concurrent replay behavior.

### GREEN

- Add narrow domain endpoints; do not expose raw table/status mutation.
- Add searchable participant, lineup, match, station, and correction panels to the Control Yard.
- Add consequence previews and exact blocked-action recovery messages.

### Gate

- Focused domain tests, full suite/typecheck/build, browser mutation walk-through, phone/tablet captures, backup/restore rehearsal, and independent security/domain review.

## H8 — Full release gate

1. Focused hotfix suites.
2. Existing plus new `npm test`.
3. `npm run typecheck` and `npm run build`.
4. Browser credential/static boundary scans.
5. Exact 360×800, 390×844, 768×1024, 834×1194, and tablet-landscape browser matrix; zero errors/overflow.
6. Real end-to-end identity, station, result confirmation/dispute, and duplicate cleanup flows.
7. Android 5/5 static, Kotlin unit tests, APK build, `aapt` version/manifest/assets verification, all-DEX endpoint verification, checksum, and physical Left/Right/OK/wrap/timer-reset acceptance.
8. Two fresh 30-adult simulations with identical canonical evidence.
9. Online predeploy backup, integrity verification, copied live migration 5→8, and disposable restore.
10. Exact clean commit independent fail-closed review.
11. Deploy exact reviewed SHA only; verify systemd MainPID/cwd/SHA/health and LAN routes.
12. Chris phone test on event SSID; Paul organizer test; scan printed station QRs physically.

## Stop/rollback

If the operational flow or mobile sizing is not independently approved, keep the existing live base and run check-in/result recording from organizer controls rather than shipping a half-wired participant flow. Any deployed regression returns immediately to `9bcb43c…`; do not let this hotfix block the core tournament or mix with the photo-wall candidate.
