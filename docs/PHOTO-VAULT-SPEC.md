# Junkyard Constellation — Canonical Hosted + LAN Specification

**Status:** Founder-approved for strict-TDD implementation (2026-08-14)
**Canonical base:** `pkircher29/junkyard-olympics-website@051482a54ddd7672fb3cc3635f8ced1428e37d9d`
**Mirrored base:** `crose0122/junkyard-olympics@main` at the same commit and tree
**Event:** Junkyard Olympics — Saturday, August 15, 2026
**Audience:** Adults only

## 1. Purpose

Let participants already signed into Paul's canonical hosted app upload event photos to Chris's local photo vault, process them locally into safe, funny “Junkyard Hall of Fame” plaques, and display approved photos as the participant-facing **Junkyard Constellation** panel in the field-TV carousel.

Paul's cloud bracket/music stack remains canonical for the party. The independently approved LAN tournament release remains the rollback runtime. This feature is developed and reviewed on `feat/photo-vault-merge` and may be rejected without affecting registration, scoring, music, organizer controls, TV calls, ONN, printing, or paper fallback.

## 1.1 Canonical dual-runtime architecture

- `site/` remains Paul's authoritative hosted tournament, bracket, team, scoring, music, authentication, and multi-device sync experience. Its tournament rules and workflow are accepted as-is. This feature may add a visually native Photo Vault surface and polish, but must not import LAN tournament rules or alter Paul's bracket/scoring behavior. Paul's music player, Spotify integration, queue, audio routing, and worker behavior are also outside this feature's modification scope.
- `lan-server/` remains the authoritative local photo vault, moderation engine, local AI processor, TV reel source, backup target, and Constellation-export producer.
- The hosted app adds a native `#/photos` route using the existing `Auth` session. It never asks for a second display name or party password.
- The music worker adds an authenticated `GET /api/session` endpoint returning only `{ user: { id, name, role } }` for a valid bearer. It never returns the bearer itself.
- For a hosted upload, the LAN server forwards the presented Paul bearer to the configured verification endpoint with a short timeout. It accepts identity only from a successful strict response. Timeout, malformed response, non-HTTPS production verifier, or any non-200 response fails closed without retaining pixels.
- The LAN database maps `(provider, external subject id)` to one local participant identity. Display names are descriptive only and are never used as identity keys. Existing LAN participant bearers remain supported.
- The Paul bearer is never written to SQLite, logs, audit details, filenames, exports, URLs, query strings, or photo metadata.
- Hosted mutation CORS is limited to configured exact Junkyard origins and the photo/session routes and methods they need. Wildcard mutation CORS is forbidden.
- Photo pixels never enter D1, bracket room sync, localStorage, GitHub, Spotify, or Cloudflare logs. Only the browser-to-vault multipart request carries image bytes.
- The hosted route may target an HTTPS public Event HQ relay or same-origin proxy. Browsers served over HTTPS must never be instructed to upload to an HTTP mixed-content URL.
- If the cloud verifier or Event HQ path is unavailable, the hosted app reports that the vault is temporarily unavailable. Tournament and music flows continue unchanged.
- **All participant and organizer interaction lives on the Junkyard Olympics website.** The LAN/Event HQ process is an API, storage, processing, and recovery backend—not a separate user-facing product. Website participant routes own upload/status surfaces; the organizer-only website admin dashboard owns rehearsal, Cannon control, and moderation. Cannon setup/scoring/alert controls never appear in participant navigation.
- Full-event rehearsal is an organizer-only website mode backed by an isolated disposable database. Every synthetic identity and result is visibly labeled `SIMULATION`; rehearsal requests can never target the live event database.

## 2. Founder decisions

1. Clearly safe photos publish automatically after screening.
2. Uncertain, failed, or offline screening stays private for organizer review.
3. Upload consent covers public Junkyard display and later permanent Constellation archival.
4. The uploader must confirm every identifiable person pictured agreed to both uses.
5. The existing field TV includes approved photos in its normal 16-second carousel. Offline/recovery, sound-unlock prompts, called matches, active matches, and recent results always interrupt it; ordinary standings and queued-event panels do not suppress it.
6. AI writes a funny title and plaque caption. Names appear only when the uploader explicitly types them.
7. Production Constellation is not modified during this build. The app produces a reviewed export package for a later adapter/import.
8. Junkyard Cannon runs one two-person team at a time. A server-authoritative five-minute timer begins before building and covers the entire build-and-shoot window. The team may use one or two launchers and its chosen barrel attachments, with no software attachment-approval gate. Shots are unlimited during the active window; every legal hit adds to the team total, and scoring locks at expiration.
9. Cannon has no separate practice-shot phase or per-person shot quota. Admin lane ARMED/CLEAR remains required; Safety Stop freezes timer and scoring immediately.
10. Cannon scoring v2 uses a compact bell-curve ladder with most targets clustered in the middle. The Tiny Golden Washer is the rare maximum at 10,000 points. Carnage is +1,000 for one legal shot moving two or more separately labeled targets. T13 and T19 remain disabled by safety/calibration policy.

## 3. Event-safe boundaries

### Included

- Participant-token-authenticated JPEG, PNG, and WebP upload.
- Explicit bundled public-display/permanent-archive consent.
- Optional uploader-provided names; no identity inference.
- Decode, pixel-limit, orientation normalization, EXIF stripping, and WebP re-encoding.
- Two-stage local safety screening.
- Local AI plaque title/caption with a deterministic corny fallback.
- Automatic publication only after every required screen returns clearly safe.
- Organizer pending/rejected/published/removed views and moderation controls.
- Per-uploader remove request, organizer removal, uploader ban, and photo-wall kill switch.
- Idle-time integration with the authoritative TV state machine.
- Secret-free Constellation export manifest and deletion tombstones.
- Backup, restore, audit, rate limiting, retention, and disk-budget enforcement.

### Excluded from Saturday release

- Direct writes into production Constellation.
- Face recognition, biometric matching, identity guessing, or automatic tagging of people.
- Public cloud gallery, social posting, comments, likes, voting, or public downloads.
- Background location, camera roll access, contact access, or hidden metadata retention.
- Video uploads, live camera streaming, remote uploads, or anonymous uploads.
- AI edits to people’s bodies/faces or generated replacement imagery.

## 4. Consent and privacy

Before upload, the participant must affirm:

> I confirm that everyone identifiable in this photo agreed that it may appear publicly on the Junkyard Olympics screen and may be permanently archived in Constellation. I understand an organizer can remove it and I can request deletion.

Consent version, participant id, timestamp, source IP hash or request correlation id, and the exact accepted text version are audited. The participant token is never stored with the image or exported.

A participant may request removal of their own upload. Chris or Paul may publish, reject, remove, restore, ban an uploader, or stop the photo wall. Deletion removes public/derived files, marks the database record deleted, and emits a tombstone for any later Constellation import. Audit retains only minimal accountability metadata and content hashes, not deleted pixels.

Uploads and events are adults-only. If a minor appears or the model is uncertain about age, the photo cannot auto-publish and requires organizer review.

## 5. Upload and storage contract

- Authentication: existing LAN participant bearer or a Paul bearer validated live through the configured strict session verifier. Organizer bearers are never accepted as participant identity.
- Maximum upload: 8 MiB encoded.
- Accepted decoders: JPEG, PNG, WebP; extension and browser MIME are not trusted.
- Maximum decoded dimensions: 20 megapixels.
- Output: orientation-corrected WebP, maximum 1600 px long edge, metadata stripped.
- Rate limits: one accepted upload per participant per 60 seconds; maximum 12 per participant per event.
- Storage is under the configured runtime `DATA_DIR`, never Git:

```text
DATA_DIR/photos/
  originals/        # decoded/re-encoded normalized source, not raw upload bytes
  plaques/          # derived display images
  quarantine/       # pending review, never publicly served
  exports/          # generated secret-free Constellation bundles
```

The server uses generated opaque filenames and never incorporates participant names or uploaded filenames into paths. Image delivery routes authorize state and use fixed server-owned directories. No direct static mount exposes quarantine or originals.

The app rejects decompression bombs, malformed/truncated images, polyglots, unsupported animation, oversized payloads, path traversal, duplicate replay, and files that cannot be fully decoded and re-encoded.

## 6. Durable model and lifecycle

A numbered SQLite migration adds:

- `photo_uploads`: id, participant id, normalized content hash, state, optional names, consent version/time, dimensions, paths, created/updated/published/removed/deleted timestamps, moderation summary, plaque title/caption, and Constellation export state.
- `photo_moderation_events`: photo id, stage, model/rule version, verdict, confidence/reason codes, actor, and timestamp. No secret or raw model prompt is stored.
- `photo_wall_settings`: enabled, rotation interval, updated actor/time.
- `photo_export_events`: bundle id, photo id, content hash, export/tombstone state and timestamp.

Lifecycle:

```text
UPLOADED
  -> PROCESSING
  -> PUBLISHED            # all screens clearly safe; plaque produced
  -> PENDING_REVIEW       # any uncertainty, failure, timeout, minor uncertainty, or model unavailable
  -> REJECTED             # organizer or deterministic hard rejection
PUBLISHED -> REMOVED      # hidden from TV/export; reversible by organizer
ANY NON-DELETED -> DELETED
```

State transitions are transactional, idempotent, audited, and server-authorized. A removed/deleted photo cannot reappear from a stale TV poll, retry, or old export.

## 7. Safety screening

Internet is not required. Screening is local and sequential to limit GPU contention:

1. **Deterministic image gate:** complete decode/re-encode, dimensions, animation rejection, duplicate/rate rules, and image-safety classifier when packaged.
2. **Local vision gate:** Ollama `qwen2.5vl:3b` at bounded resolution produces strict structured JSON for nudity/sexual content, graphic violence, weapons pointed at people, hate symbols/harassment text, illegal activity, visibly endangered person, minor/age uncertainty, personally identifying documents, and general uncertainty.

Automatic publication requires every required category to be explicitly safe and parsing to validate against the server schema. A timeout, malformed response, unavailable model, low confidence, contradictory signal, or uncertain age always becomes `PENDING_REVIEW`. There is no fail-open path.

The screen is risk reduction, not proof. The TV provides an immediate organizer stop control, and organizers can remove or ban from their authenticated consoles.

## 8. Corny AI plaque

After safety approval, local `qwen2.5vl:3b` receives the normalized image and optional uploader-provided names. It returns strict JSON:

```json
{
  "title": "The title",
  "caption": "One short corny sports-plaque sentence"
}
```

Rules:

- celebratory, absurd, warm, and Junkyard-themed;
- no body comments, sexualization, humiliation, profanity, protected-trait guesses, relationship guesses, sobriety/intoxication claims, medical claims, criminal claims, or inferred names;
- names may be used only from the uploader’s optional names field;
- maximum 60-character title and 180-character caption;
- one bounded retry for invalid output;
- deterministic safe fallback if caption generation fails after safety approval.

The plaque renderer is deterministic HTML/canvas or server-side image composition using local assets. It does not call an image-generation service and never alters the original people.

## 9. Organizer controls

The authenticated organizer console adds:

- Photo Wall status and kill switch.
- Pending Review queue with normalized preview, safety reason codes, optional names, uploader display name, and consent timestamp.
- Publish, Reject, Remove, Restore, Delete, and Ban Uploader actions.
- Published reel list ordered newest-first with manual pin/unpin optional only if trivial.
- Audit identity distinguishes Chris and Paul.

Destructive actions require confirmation. Delete and bulk stop create a database backup first. Public participants never receive organizer credentials or moderation reason details.

## 10. Field TV priority

TV priority is fixed:

1. Offline/recovery and operator-required sound prompt.
2. Called match and countdown.
3. Active match and recent-result announcement.
4. Normal 16-second carousel: official standings, queue/field status, roster, music state, approved Junkyard Constellation photos, website QR, and Wi-Fi QR.
5. Branded idle state when no normal carousel panel has data.

The reel never delays, suppresses, overlays, or speaks over urgent official calls/results. When an urgent authoritative state arrives, the photo disappears on the next immediate refresh and official audio behavior remains unchanged. Removed/deleted photos are evicted by id and content version.

Each carousel panel displays for 16 seconds with reduced-motion-safe crossfade. The website and Wi-Fi QR panels remain separate and manually reachable by TV remote. No photo audio is generated.

## 11. Constellation handoff

Saturday’s app does not connect to or mutate Constellation. An organizer-only export creates:

- normalized approved image;
- derived plaque image;
- plaque title/caption;
- event id/name/date;
- participant-provided names only;
- consent version/timestamp;
- source/derived SHA-256 hashes;
- export eligibility and deletion-tombstone records;
- a schema-versioned JSON manifest.

It excludes participant tokens, organizer credentials, IP addresses, private URLs, model prompts, moderation internals beyond public-safe labels, and database ids that are not required for idempotency. The later Constellation adapter must verify checksums, import idempotently, preserve consent/deletion state, and be separately reviewed before production use.

## 12. Failure behavior

- Ollama/model unavailable: upload stays pending; tournament continues.
- Processing timeout/crash: startup reconciliation returns stuck processing rows to pending.
- Disk reaches warning threshold: stop accepting new uploads, alert organizers, keep scoring/TV calls working.
- Photo subsystem database/file failure: disable photo wall and surface organizer warning; never affect scoring transactions.
- TV photo fetch fails: fall back to branded idle/current official state.
- Total Wi-Fi failure: photo wall stops; paper tournament fallback remains unchanged.
- Kill switch: immediately hide all photos without deleting them.

Photo processing has bounded concurrency of one and cannot starve scoring, browser, audio, or TV polling.

## 13. Acceptance tests

The feature is not Saturday-ready until all pass:

1. Existing 130 tests, typecheck, build, Android gates, two deterministic 30-adult simulations, browser-auth tests, and exact mobile/TV evidence remain green.
2. Valid participant uploads safe JPEG/PNG/WebP; malformed, oversized, animated, decompression-bomb, non-image, and polyglot inputs reject.
3. EXIF/GPS and original filename do not survive normalized output or export.
4. Anonymous, wrong-participant, organizer-token-as-participant, cross-origin bearer, traversal, IDOR, duplicate replay, and rate-limit attacks fail closed.
5. Every safety timeout/error/malformed/uncertain/minor result stays private pending review.
6. Only clearly safe results auto-publish; rejected/quarantined bytes are never publicly addressable.
7. Plaque captions obey length/content/name constraints; invalid AI output uses the safe fallback.
8. Organizer publish/remove/delete/ban/kill-switch actions are attributable and immediately reflected on TV.
9. Official calls/results interrupt a displayed photo within the authoritative refresh bound and preserve audio semantics.
10. Removed/deleted photos cannot reappear after process restart, stale SSE/poll, browser cache, or export retry.
11. Backup/restore preserves consent, states, settings, files, audit, and tombstones; missing/corrupt files reconcile safely.
12. At 390×844, upload, consent, progress, error, and removal-request flows have no horizontal overflow, 17px body text, 20px inputs, and 56px primary actions.
13. At 1920×1080, plaques are readable at 10 feet and remain overscan-safe.
14. Disk-pressure and model-down rehearsals prove scoring/calls continue.
15. Exact staged snapshot receives independent fail-closed approval before deployment.
16. A valid Paul guest session can open the hosted `#/photos` route, upload once, refresh, and see only that external subject's photo states without receiving a second identity.
17. Forged names, unknown/revoked Paul tokens, host-token confusion, verifier timeout/error/malformed JSON, subject mismatch, and cross-origin requests outside the exact allowlist fail before image normalization or database insertion.
18. Browser network capture proves Paul bearers travel only in `Authorization`, never in URLs, room sync, storage added by the photo feature, logs, exports, or media responses.
19. The hosted app remains fully usable for brackets and music when the vault or verifier is offline; photo controls show a precise unavailable state and do not retry an upload silently.

## 14. Definition of done

Done means the approved baseline still passes, the complete photo flow runs on a real event phone over the event SSID, local safety and caption models run on RecRoomRig, Chris and Paul can moderate independently, the field TV yields instantly to official state, a backup/restore drill succeeds, the secret-free Constellation export validates, and the exact reviewed snapshot—not a later mutation—is deployed.
