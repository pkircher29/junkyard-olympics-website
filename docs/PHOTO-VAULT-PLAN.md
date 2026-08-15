# Junkyard Photo Vault — Canonical Merge Implementation Plan

**Status:** Founder-approved for strict-TDD implementation (2026-08-14)
**Frozen spec:** [`PHOTO-VAULT-SPEC.md`](./PHOTO-VAULT-SPEC.md)
**Protected canonical base:** `051482a54ddd7672fb3cc3635f8ced1428e37d9d`

## Rules of execution

1. No production code before this spec/plan/README checkpoint is approved.
2. Work only in the isolated `feat/photo-vault-merge` worktree.
3. Preserve the approved base as the immediate rollback release.
4. Use strict RED → GREEN → REFACTOR slices.
5. Run Vitest, TypeScript, Gradle, Chrome, local VLM, and simulations serially.
6. Never point tests at the live party database, production D1, Spotify, production Constellation, FamilyOS, or the Constellation Shield.
7. Any uncertainty in screening is pending review; no code path may auto-publish on error.
9. Paul's tournament rules, bracket/scoring workflow, music player, Spotify integration, queue, audio routing, and music-worker behavior are authoritative and out of scope. Photo integration may add native-looking design/polish but must not import LAN tournament rules or alter Paul's behavior.
10. All participant and organizer controls ship within the Junkyard Olympics website. Event HQ remains a secured backend only. Rehearsal, Cannon setup/scoring/alerts, and moderation are organizer-only sections of the website admin dashboard and never appear in participant navigation. Rehearsal uses a visibly synthetic, isolated database and cannot mutate live event state.
11. Cannon is a timed-run event: one two-person team at a time, one server-authoritative five-minute build-and-shoot window, one or two launchers, unlimited legal shots, no practice quota, and immediate lock at expiration or Safety Stop. The software does not approve barrel attachments; physical organizers own that decision.
12. Cannon values use a compact bell-curve ladder; washer maximum is 10,000 and Carnage is +1,000. T13 and T19 stay disabled. Exact remaining target assignments must be approved before activation and remain data-driven rather than embedded in button code.

## CP-P0 — Freeze contracts and prove the baseline

### Work

- Commit spec, plan, and README checkpoint only.
- Record exact base commit and approved evidence.
- Add a photo-specific QA matrix with stable IDs.
- Define schemas for API requests/responses, moderation JSON, plaque JSON, SQLite tables, file layout, and Constellation export.

### Acceptance

- Base worktree is clean at exact canonical `051482a…` before documentation commit.
- Existing 181 tests, authoritative 25/25 acceptance, typecheck/build, Android 5/5 + unit/build, two 68/68 simulations, Paul's static-site smoke suite, and exact browser evidence remain the baseline.
- No production source changes exist before founder approval.

## CP-M1 — Hosted identity bridge and exact-origin upload boundary

### RED tests

- Music worker `GET /api/session` requires a valid bearer and returns only bounded `id`, `name`, and `role` fields.
- LAN verifier rejects HTTP production verifier URLs, timeout, network failure, non-200, malformed/extra-field responses, missing subject, and revoked tokens before retaining a file or row.
- External identity mapping keys on provider + immutable subject id, not display name, and remains stable if the display name changes.
- Paul bearer never appears in SQLite, audit JSON, logs, filenames, URLs, exports, room sync, or photo responses.
- Hosted photo POST/GET preflights pass only for configured exact HTTPS origins and required headers/methods; unrelated origins and organizer-as-participant fail.
- Existing read-only public wildcard CORS does not accidentally authorize photo mutations.

### GREEN implementation

- Add the minimal authenticated session route to `site/worker/music-worker.js`.
- Add injectable external-session verifier and external-identity mapping migration to `lan-server/`.
- Extend participant photo authorization to accept either canonical LAN identity or a successfully verified Paul session.
- Add exact-origin photo CORS configuration with no wildcard credentials.

### Gate

- Worker unit/static route tests and LAN verifier/auth tests pass.
- Browser interception proves no token in URL or sync payload.
- With the verifier stopped, brackets/music remain usable and upload fails closed without retained bytes.

## CP-P1 — Storage, migration, normalized image boundary

### RED tests

- Numbered migration creates photo tables/indexes/constraints and upgrades a representative existing database.
- Reapplying migration is idempotent; rollback uses backup restore, not lossy down-migration.
- Valid JPEG/PNG/WebP normalize to bounded WebP with no EXIF/GPS.
- Malformed, oversized, animated, decompression-bomb, non-image, truncated, and polyglot inputs reject.
- Opaque generated paths cannot traverse or collide.
- Duplicate content and retry semantics are deterministic.

### GREEN implementation

- Add migration and repository functions.
- Add runtime photo directories under `DATA_DIR` with startup permission/path validation.
- Add decode/re-encode service with 8 MiB and 20 MP bounds, 1600 px output, EXIF stripping, and atomic writes.
- Add content hashes, startup reconciliation, and orphan/corruption reporting.

### Gate

- Focused migration/image tests pass.
- Existing persistence, backup, full suite, typecheck, and build pass.
- A disposable restore proves database rows and photo files remain consistent.

## CP-P2 — Authenticated upload, consent, lifecycle, and abuse controls

### RED tests

- Participant bearer required; anonymous, organizer-as-participant, wrong user, cross-origin bearer, IDOR, and replay fail.
- Exact consent version and affirmative boolean required.
- Optional names are bounded plain text; filename/path/header injection rejects.
- Rate limits enforce one per minute and twelve per event.
- Lifecycle transitions reject invalid/replayed/conflicting operations.
- Participant removal request affects only their own photo.

### GREEN implementation

- Add bounded multipart parsing without loading unbounded payloads.
- Add participant upload/status/removal-request endpoints.
- Audit consent and lifecycle without tokens, raw IPs, filenames, or secret headers.
- Queue accepted uploads for single-worker processing.

### Gate

- Focused auth/consent/abuse tests pass.
- Browser bearer interception confirms no participant or organizer token crosses origin.
- Full suite/typecheck/build remain green.

## CP-P3 — Local safety screening and fail-closed worker

### RED tests

- Strict moderation JSON schema accepts only known enums/booleans/reason codes.
- Model unavailable, timeout, malformed JSON, missing categories, low confidence, contradiction, and minor uncertainty all become `PENDING_REVIEW`.
- Hard deterministic rejection and explicit unsafe verdict never publish.
- Clearly safe fixture can advance; no other result can.
- Crash/restart reconciles stuck `PROCESSING` rows.
- Concurrent uploads process one at a time and scoring requests remain responsive.

### GREEN implementation

- Add injectable moderation interface.
- Add deterministic image gate and packaged local classifier only if its model/license/size pass review.
- Add Ollama `qwen2.5vl:3b` structured moderation adapter with bounded resolution, timeout, and one schema parse.
- Add single-worker queue, startup reconciliation, metrics, and organizer-visible reason codes.
- Isolate processing errors from scoring transactions and TV state.

### Gate

- Test doubles prove every fail-closed branch.
- Real local-model smoke fixtures cover ordinary group photo, text/sign photo, uncertain age, and deliberately ambiguous benign cases without storing unsafe samples in Git.
- Kill Ollama during processing: photo stays pending; scoring/calls stay healthy.

## CP-P4 — Corny plaque generation and deterministic renderer

### RED tests

- Caption JSON enforces title/caption length and exact fields.
- Prompt and post-validator prohibit inferred names, protected traits, body/sexual comments, humiliation, profanity, relationship/sobriety/medical/criminal claims.
- Names appear only when supplied.
- Timeout/invalid/unsafe caption uses deterministic fallback after safety approval.
- Renderer escapes all text and produces bounded local output.

### GREEN implementation

- Add local VLM caption adapter and post-validator.
- Add deterministic fallback title/caption library.
- Add plaque renderer using local brand assets and fonts.
- Store title/caption/model version/content hashes and atomically transition safe rows to published.

### Gate

- Golden plaque fixtures are readable and visually on-brand.
- Unsafe caption mutation tests cannot reach published output.
- No external network request occurs.

## CP-P5 — Organizer moderation and emergency controls

### RED tests

- Chris and Paul independently publish/reject/remove/restore/delete/ban with attributable audit.
- Public/participant identities cannot access pending bytes or moderation internals.
- Delete and kill-switch semantics are idempotent; destructive actions require confirmation and pre-action backup where specified.
- Banned uploader cannot add more photos.
- Removed/deleted photo URLs fail and cannot be cache-resurrected.

### GREEN implementation

- Add photo moderation panel to organizer console.
- Add pending/published/removed queues and controls.
- Add wall enable/disable kill switch and uploader ban.
- Add versioned public photo-wall state containing only published display-safe fields.

### Gate

- Real disposable Chrome session proves every enabled control causes the intended state and audit mutation.
- Unsupported/setup-missing actions remain disabled with precise messages.
- Full security suite remains green.

## CP-P6 — Participant mobile flow

### RED tests

- Participant page offers one clear photo action without displacing called-match priority.
- Consent is explicit, readable, unchecked by default, and required.
- Upload progress, processing, published, pending, rejected, removed, deletion-requested, offline, and retry states are distinct.
- At 390×844: no horizontal overflow; body ≥17px; inputs ≥20px; primary actions ≥56px; first action above fold when no called match.

### GREEN implementation

- Add photo upload card below official task/result sections.
- Use camera/gallery file input with preview, optional names, consent, and progress.
- Poll participant-owned status; never expose organizer-only reasons.
- Add removal request.

### Gate

- Real phone-width browser flow uploads, refreshes, restores identity, and sees final state.
- Event-phone/SSID test remains required before deployment approval.

## CP-P7 — TV carousel reel and urgent-state priority proof

### RED tests

- TV chooses offline/recovery, sound prompt, called match, active match, and recent result over a photo in every combination.
- Approved photos remain eligible during normal standings and queued-event carousel states.
- A displayed photo disappears within the authoritative refresh bound when an urgent state arrives.
- Photo changes never trigger gong/speech/result audio.
- Removed/deleted/version-changed photo is evicted across polling, SSE, restart, and cache.
- Empty/disabled/pending-only/photo-fetch-failure returns branded idle state.
- Exact 1920×1080 plaque has overscan-safe text and no overflow.

### GREEN implementation

- Extend authoritative public state with a bounded published reel descriptor.
- Add normal 16-second carousel rotation and reduced-motion-safe transition.
- Preserve signup QR and existing broadcast controls.
- Keep audio deduplication semantics unchanged.

### Gate

- Empty, photo-idle, called, active, result, offline, killed, removed, and recovery screenshots inspected at 1920×1080.
- Real call while a photo is displayed preempts it and announces once.

## CP-P8 — Constellation export, tombstones, backup, and pressure behavior

### RED tests

- Export includes only published/eligible non-deleted photos and approved metadata.
- Manifest is schema-versioned, checksum-complete, deterministic, idempotent, and secret-free.
- Tokens, private URLs, IPs, raw moderation prompts, organizer details, and unneeded database ids never appear.
- Removal/deletion after export creates a tombstone.
- Backup/restore preserves state/files/audit/tombstones.
- Disk warning disables new uploads without affecting scoring/calls.

### GREEN implementation

- Add organizer-only export preview/build/download.
- Add manifest/hash/tombstone generation; do not implement Constellation writes.
- Extend online backup/restore and startup integrity reconciliation.
- Add disk budget and organizer warning/kill behavior.

### Gate

- Extract export into a disposable directory and validate every checksum/schema/privacy rule.
- Restore into a fresh runtime and compare authoritative states/hashes.
- Simulated disk/model failures leave tournament core healthy.

## CP-P9 — Full regression, independent review, and physical rehearsal

### Automated gates — serial

1. Focused photo suites.
2. Existing `npm test` — 130 existing tests plus new tests.
3. `npm run typecheck`.
4. `npm run build`.
5. `git diff --check` and secret/static credential scans.
6. Android static tests, Kotlin unit tests, and APK build.
7. Two fresh 30-adult simulations with identical canonical evidence.
8. Real browser auth/control/upload/TV-priority flows.
9. Exact 390×844 and 1920×1080 screenshots.
10. Online backup and disposable restore.
11. Exact staged-tree independent fail-closed review.

### Physical gates

- Participant phone on `Junkyard Olympics` SSID uploads from camera and gallery.
- Chris and Paul moderate independently on organizer devices.
- RecRoomRig processes via local Ollama with internet disconnected.
- Field TV/ONN shows idle plaques and instant official-call preemption.
- Kill switch clears the screen immediately.
- Disk/model failure does not delay scoring or calls.
- Constellation export is generated and inspected but not imported.

### Deployment/rollback

- Back up the live database and runtime photo root.
- Deploy only the exact independently approved commit.
- Push the reviewed candidate only to private `crose0122/junkyard-olympics`. Updating `pkircher29/junkyard-olympics-website` requires Paul's explicit review and approval as the tournament/auth/music owner.
- Cloudflare worker deployment and live LAN cutover are separate approval boundaries. A Git merge does not imply either runtime changed.
- Verify service `MainPID`, exact source SHA, health, migration, organizer access, upload, moderation, idle TV, and call preemption.
- Keep canonical base `051482a…` and approved LAN release `c3ef55f…` immediately deployable.
- On any photo subsystem failure, disable photo wall first. On core regression, restore the pre-deploy database and approved base release.

## Stop conditions

Reject the photo-wall candidate and run the already approved base when any of these remains unresolved near event time:

- safety screening can fail open;
- photo processing degrades scoring/calls;
- organizer kill/remove controls are not truthful;
- official TV priority is not proven;
- backup/restore or disk-pressure behavior fails;
- real phone/SSID or TV/ONN rehearsal is incomplete;
- exact-snapshot independent review is not green.

A rejected photo wall does not delay Junkyard Olympics. The tournament runs on the approved base release and photos can be collected manually for later processing.
