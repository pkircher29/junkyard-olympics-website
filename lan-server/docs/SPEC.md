# Junkyard Olympics 2026 — Event-Safe MVP Specification

**Status:** Frozen for implementation  
**Event:** Saturday, August 15, 2026  
**Opening ceremony:** 2:00 PM EDT  
**Host:** RecRoomRig on the home LAN  
**Primary users:** Adult competitors, organizers Chris and Paul, spectators

## 1. Product Goal

A resilient, delightfully branded scorekeeping and dynamic tournament system for an adults-only backyard Junkyard Olympics. Participants use phones; Chris and Paul use organizer views; a yard TV and speaker system provide a live sports-broadcast experience. The system must continue when outside internet service fails and must fail gracefully to a printable paper packet when local Wi-Fi fails.

## 2. Event Format

### 2.1 Participants
- Approximately 15–30 adults, with flexible capacity beyond 30.
- Rolling registration and graceful departure throughout the day.
- Participant chooses a public display name during signup.
- No email, password, PIN, phone number, or account required.
- A private bearer identity is generated and stored on the participant's device.
- Competitors choose which events to enter.

### 2.2 Championship
One individual overall podium:
1. Junkyard Champion
2. Second place
3. Third place

Championship total:
- Junkyard Cannon placement always counts.
- Best three field-event placements count.
- Additional field events may replace weaker results.
- Podium eligibility requires completed Cannon plus three completed field events.

Placement points:
- 1st: 10
- 2nd: 7
- 3rd: 5
- 4th: 3
- Completed: 1

### 2.3 Flair — Separate Competition
Flair never affects championship points.

Live Flair Props:
- Best Costume
- Epic Entrance
- Creative Trash Talk
- Spectacular Failure
- Unnecessary Showmanship
- Junkyard Ingenuity
- Great Sportsmanship
- Spectacular Destruction

Rules:
- A participant may give another participant one prop per category.
- No self-awards.
- Each unique prop is worth 1 Flair point.
- Each participant may cast one final Showboat vote worth 3 Flair points.
- Live Flair standings remain public throughout the event.
- Highest total wins Junkyard Showboat.

## 3. Events

Initial catalog:
- Junkyard Cannon — scored team event
- Ladder Ball — head-to-head
- Field Pong — head-to-head
- Cornhole — head-to-head
- KanJam — head-to-head
- Additional organizer-created events

All event names, order, station labels, and availability are organizer-editable.

## 4. Team Formation

- Default team size is two.
- Pairing occurs dynamically when a station needs a match.
- Availability takes priority over perfect randomization.
- Prefer new partners and avoid recent opponents when possible.
- Teams remain together for the remainder of that event's championship bracket after formation.
- If the available pool is odd, create one rotating trio. Only two play simultaneously; rotate active players fairly.
- Trio assignments rotate across events.
- Organizer can override a pairing.

Temporary team names:
- Safe junkyard-themed name generated automatically.
- Unique within an event.
- Player names remain visible beneath it.
- One rename allowed before the first match.
- Both teammates approve the rename.
- Name locks when the first match starts.
- Organizer may override inappropriate names.

## 5. Junkyard Cannon

- Cannon follows the 2:00 PM opening ceremony.
- Two cannon lanes run simultaneously.
- Each randomized pair chooses/builds one shared barrel and uses one lane.
- Both teammates share aiming/operation.
- Each participant receives 5 practice shots and 10 scored shots.
- Team total: 10 practice shots and 20 scored shots.
- Practice shots do not affect the score.
- Scored shots are stored individually and auditable.

Target scoring:
- Miss is 0.
- Organizers maintain a named target catalog with arbitrary point values.
- One shot may hit multiple targets; all target values stack.
- Million-point washer jackpot target is supported.
- Configurable jackpot hit guarantees first place in Cannon.
- Carnage Bonus is +50 when a target visibly falls, breaks, or satisfies an organizer-defined destruction condition.
- Carnage Bonus requires organizer confirmation and awards Spectacular Destruction Flair to both team members.
- Ties affecting first through fourth use sudden death: one scored shot per tied team, repeated until broken.

## 6. Head-to-Head Events

- Main single-elimination championship bracket.
- First-match losers enter a consolation path, guaranteeing two matches when time permits.
- Main bracket determines first through fourth and championship points.
- Consolation results count for history and Flair, not top-four displacement.
- Organizer may stop scheduling unfinished consolation play without affecting official standings; bracket-linked matches remain intact and are never generically marked `CANCELLED`.
- Championship late-entry closes when semifinals begin.
- Before semifinals, late entrants use open slots, unused byes, or a play-in match without changing completed results.
- After semifinals begin, late entrants may play exhibition/consolation only.

## 7. Dynamic Scheduling

Field events run simultaneously after Cannon.

A match may be called only when:
- Station is available.
- Required players are available.
- No required player is active in another match.
- No required player has an unresolved result.
- Five-minute post-match cooldown has expired, unless organizer overrides it.

Flow:
- TV and participant app call the match.
- Players have five minutes to report.
- After five minutes the match is temporarily skipped, never automatically forfeited.
- Next eligible match is called.
- Skipped match re-enters the queue when players check in.
- Only an organizer may declare a forfeit.

Station check-in:
- Each station has a reusable printed QR code.
- One check-in from each team is sufficient.
- Match begins when both teams check in.
- Organizer may manually begin it.

Departure/substitution:
- Leaving player is removed from future calls without losing completed history.
- Stranded teammate receives an automatic substitute.
- Prefer an available person who has not played the event, then avoid repeats.
- A substitute already eliminated from that event cannot earn duplicate placement points.
- Substitution is publicly recorded and organizer-reversible.

## 8. Results and Confirmation

- A match participant reports the winning team.
- One member of the opposing team confirms.
- Official confirmation advances the bracket and updates standings atomically.
- Disagreement freezes the match and creates an organizer dispute.
- Chris and Paul have equal organizer authority.
- Every correction, override, and destructive action is audited with actor and time.
- Destructive reset requires explicit confirmation and an automatic backup first.

## 9. Interfaces

### Participant phone
- Frictionless signup and identity restoration on the same device.
- Select/leave events.
- See personal status, active/called matches, five-minute cooldown, event results, championship scores, dropped scores, and Flair.
- Report/confirm results.
- Give Flair Props and final Showboat vote.
- Mark Heading Out.

### Organizer — Chris and Paul
- Separate private organizer credentials with equal authority.
- Manage participants, events, stations, signups, target catalog, Cannon shots, brackets, disputes, results, substitutions, cooldowns, announcements, backups, and printing.

### Station QR view
- Station name and rules.
- Current match, called match, and queue.
- Team check-in.
- Reusable QR code throughout the event.

### TV Broadcast Mode
- Full-screen and read from across the yard.
- Permanent signup QR code.
- Countdown and opening ceremony mode.
- Live championship standings and counted/dropped-score transparency.
- Active matches, on-deck calls, station queues, Cannon lanes, and Flair feed.
- Full-screen match-call and jackpot/Carnage/result graphics.
- Automatic rotation between broadcast panels.
- No organizer controls.

## 10. Announcements

MVP:
- Local gong sound.
- Browser speech synthesis with a British English voice when available.
- Match-ready announcement names event, station, team names, and players.
- One reminder after the five-minute report window.
- Result, Carnage, and jackpot celebration announcements.
- Mute, volume, replay, and quiet controls.

Deferred enhancement:
- ElevenLabs sportscaster generation and caching. It must not block the event-safe MVP.

## 11. Brand

Canonical reference: `assets/tshirt-brand-reference.png`.

Visual direction:
- Heavy Junkyard Olympics identity on every surface.
- Burnt orange, rust red, soot black, dirty cream, faded olive/grass, and steel gray.
- Distressed athletic/display typography paired with highly readable controls.
- Bold black outlines, halftone/grit texture, flames, scrap metal, barrels, dents, bolts, patched machinery, and intentionally questionable engineering.
- TV mode feels like an improvised pirate sports network.
- Decorative texture never reduces phone readability or print legibility.
- Dana may refine artwork and copy without changing the information architecture.

## 12. Reliability and Recovery

**2026-08-14 event-day amendment:** the generated public outage packet supersedes the retired browser snapshot. It is deliberately blank and preprintable; live state remains authoritative in SQLite and organizer exports. This avoids presenting rehearsal fixtures or stale cached state as current during an emergency.

- Standalone project; no FamilyOS production integration.
- RecRoomRig hosts on local LAN port 8790.
- Outside internet is optional after initial page load.
- SQLite is the authoritative event database.
- Every state mutation uses a transaction.
- Automatic timestamped SQLite backups at startup, before destructive operations, and on a recurring interval.
- Organizer can download JSON and CSV exports.
- The reproducible public emergency packet is generated before the event and contains only non-secret fallback materials:
  - Public signup sign
  - Stable QR signs for all eight official stations
  - Blank score/check-in sheets for all eight official field activities
  - Separate blank Junkyard Cannon Lane 1 and Lane 2 ledgers
- The public packet must never present hard-coded rehearsal data as current event state.
- While the server is reachable, organizers may download truthful current-state JSON and participant CSV exports. Those exports are separate from the preprinted public packet.
- If outside internet fails, LAN operation continues.
- If Wi-Fi fails, switch immediately to the preprinted public packet and record new state on its blank ledgers.
- Service restart must preserve all committed results and identities.

## 13. Security and Privacy

- Adults-only event.
- Collect only public display name and system-generated identity tokens.
- No telemetry, advertising, email, phone, location, or third-party analytics.
- Organizer sessions use separate high-entropy credentials.
- Mutations require participant or organizer authorization as appropriate.
- Participant identity tokens are never displayed publicly.
- Inputs are length-bounded and output-escaped.
- Rate-limit signup, result reporting, voting, and login attempts.
- Local network exposure is expected; public internet exposure is not required for MVP.
- Server binds to LAN only when explicitly launched for the event.

## 14. Tomorrow MVP Acceptance Tests

1. Register 30 simulated adults and preserve identities across refresh.
2. Join/leave event pools dynamically.
3. Form randomized pairs, avoid repeats when possible, and handle odd counts.
4. Run complete Cannon flow with 20 scored shots, multi-target hit, Carnage, jackpot, ranking, and tie shootout.
5. Run complete eight-team head-to-head event with consolation path.
6. Report and confirm a result; verify one opposing confirmation finalizes it.
7. Dispute a result; verify bracket does not advance.
8. Run simultaneous stations without scheduling a participant twice.
9. Enforce five-minute cooldown and five-minute call timeout behavior.
10. Add a late entrant before semifinals and reject championship entry after semifinals begin.
11. Automatically substitute for a departed player without duplicate points.
12. Calculate Cannon plus best-three field scores and podium eligibility correctly.
13. Give Flair Props, prevent self/duplicate category props, cast final vote, and calculate Showboat ranking.
14. Restart server mid-event and recover committed state.
15. Produce and restore a backup.
16. Render usable participant, organizer, station, TV, and print views on phone/tablet/TV sizes.
17. Complete a hands-on LAN test from the Junkyard Olympics SSID.
18. Print the verified public emergency packet, scan all eight official station QRs, and confirm its field sheets and Cannon lane ledgers are blank and usable.
