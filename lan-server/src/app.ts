import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Db } from "./db.js";
import { audit, backupDatabase } from "./db.js";
import path from "node:path";
import {
  createPhotoStorage,
  PHOTO_MAX_BYTES,
  PhotoStorageError,
  type NormalizedPhoto,
} from "./photo-storage.js";

export const PHOTO_CONSENT_VERSION = "junkyard-photo-consent-v1";
export const PHOTO_CONSENT_TEXT = "I confirm that everyone identifiable in this photo agreed that it may appear publicly on the Junkyard Olympics screen and may be permanently archived in Constellation. I understand an organizer can remove it and I can request deletion.";

const publicDir = path.resolve(process.cwd(), "public");
const flairCategories = new Set([
  "BEST_COSTUME",
  "EPIC_ENTRANCE",
  "CREATIVE_TRASH_TALK",
  "SPECTACULAR_FAILURE",
  "UNNECESSARY_SHOWMANSHIP",
  "JUNKYARD_INGENUITY",
  "GREAT_SPORTSMANSHIP",
  "SPECTACULAR_DESTRUCTION",
]);
const teamNames = [
  "Rust Raiders",
  "Bent Axles",
  "Scrap Rockets",
  "Barrel Bandits",
  "Soot Sprinters",
  "Weld Rebels",
  "Tin Titans",
  "Heap Heroes",
  "Bolt Buccaneers",
  "Grit Gremlins",
  "Chrome Carnage",
  "Dumpster Dynamos",
];
const pointsForPlace = (place: number) =>
  ({ 1: 10, 2: 7, 3: 5, 4: 3 })[place] ?? 1;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const cleanName = (value: unknown, max = 256) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= max
    ? value.trim()
    : null;
const publicKind = (kind: string) => kind === "CANNON" ? "cannon" : "head-to-head";

type AuthedRequest = Request & { participant?: any; organizer?: string };
export interface PhotoProcessorInput {
  id: string;
  participantId: string;
  contentHash: string;
  absolutePath: string;
  width: number;
  height: number;
}
export interface ExternalPhotoIdentity {
  subject: string;
  displayName: string;
}
export interface ExternalOrganizerIdentity extends ExternalPhotoIdentity {
  role: "host" | "guest";
}
export interface AppOptions {
  db: Db;
  organizerTokens: string[];
  now?: () => Date;
  dataDir?: string;
  photoProcessor?: (photo: Readonly<PhotoProcessorInput>) => Promise<void | "PENDING_REVIEW">;
  photoIdentityVerifier?: (token: string) => Promise<ExternalPhotoIdentity | null>;
  organizerIdentityVerifier?: (token: string) => Promise<ExternalOrganizerIdentity | null>;
  photoStorageFactory?: typeof createPhotoStorage;
}

export function createApp({
  db,
  organizerTokens,
  now = () => new Date(),
  dataDir = process.env.DATA_DIR ?? "/tmp/junkyard-olympics",
  photoProcessor = async () => "PENDING_REVIEW",
  photoIdentityVerifier,
  organizerIdentityVerifier,
  photoStorageFactory = createPhotoStorage,
}: AppOptions) {
  if (organizerTokens.length < 2 || new Set(organizerTokens).size !== organizerTokens.length || organizerTokens.some((token) => token.length < 24))
    throw new Error("at least two distinct high-entropy organizer credentials are required");
  const app = express();
  const photoStorage = photoStorageFactory(dataDir);
  const stuckPhotos = db.prepare("SELECT id FROM photo_uploads WHERE state='PROCESSING'").all() as Array<{ id: string }>;
  if (stuckPhotos.length) db.transaction(() => {
    const reconciledAt = now().toISOString();
    for (const photo of stuckPhotos) {
      db.prepare("UPDATE photo_uploads SET state='PENDING_REVIEW',updated_at=?,moderation_summary='PROCESS_RESTART' WHERE id=? AND state='PROCESSING'").run(reconciledAt, photo.id);
      db.prepare("INSERT INTO photo_moderation_events(id,photo_id,stage,rule_version,verdict,reason_codes,actor,created_at) VALUES(?,?,'STARTUP_RECONCILIATION','cp-p2','PENDING_REVIEW','[\"PROCESS_RESTART\"]','system',?)").run(randomUUID(), photo.id, reconciledAt);
      audit(db, "system", "photo.processing.reconciled", "photo", photo.id);
    }
  })();
  const photoMultipart = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: PHOTO_MAX_BYTES,
      files: 1,
      fields: 3,
      parts: 5,
      fieldNameSize: 40,
      fieldSize: 512,
    },
  }).single("photo");
  let photoProcessingTail: Promise<void> = Promise.resolve();
  const runPhotoProcessor = (photo: Readonly<PhotoProcessorInput>) => {
    const result = photoProcessingTail.then(() => photoProcessor(photo));
    photoProcessingTail = result.then(() => undefined, () => undefined);
    return result;
  };
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  // Read-only CORS: lets the cloud scoreboard (junkyardolympics.com) pull
  // public standings from this control tower across origins. Mutations stay
  // same-origin only.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS" && req.path.startsWith("/api/")) return res.status(204).end();
    }
    next();
  });
  let mutationRouteTail: Promise<void> = Promise.resolve();
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const previous = mutationRouteTail.catch(() => undefined);
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    mutationRouteTail = previous.then(() => slot);
    let acquired = false, handlerStarted = false, released = false, disconnected = req.aborted || res.destroyed;
    const releaseSlot = () => {
      if (acquired && !released) { released = true; release(); }
    };
    const onDisconnect = () => {
      disconnected = true;
      if (acquired && !handlerStarted) releaseSlot();
    };
    req.once("aborted", onDisconnect);
    res.once("close", onDisconnect);
    res.once("finish", releaseSlot);
    const originalEnd = res.end;
    (res as any).end = (...args: any[]) => {
      try { return originalEnd.apply(res, args as any); }
      finally { if (handlerStarted) releaseSlot(); }
    };
    void previous.then(() => {
      acquired = true;
      if (disconnected || req.aborted || res.destroyed) return releaseSlot();
      handlerStarted = true;
      next();
    }).catch((error) => { releaseSlot(); next(error); });
  });
  app.get("/public-print-packet.pdf", (_req, res, next) => {
    const packet = path.resolve(process.cwd(), "artifacts", "public-print-packet", "junkyard-olympics-public-print-packet.pdf");
    res.sendFile(packet, { headers: { "Content-Type": "application/pdf" } }, (error) => {
      if (error) next(error);
    });
  });
  app.use(express.static(publicDir, { extensions: ["html"] }));
  const tx = <T>(fn: () => T): T => db.transaction(fn)();
  const fail = (res: Response, status: number, message: string, code = "REQUEST_REJECTED") =>
    res.status(status).json({ error: { code, message } });
  const windows = new Map<string, { count: number; resetAt: number }>();
  const rateLimit = (scope: string, maximum: number) => (req: Request, res: Response, next: NextFunction) => {
    const key = `${scope}:${req.ip ?? req.socket.remoteAddress ?? "local"}`;
    const timestamp = now().getTime();
    let window = windows.get(key);
    if (!window || timestamp >= window.resetAt) {
      window = { count: 0, resetAt: timestamp + 60_000 };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > maximum) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((window.resetAt - timestamp) / 1000))));
      return fail(res, 429, "too many requests", "RATE_LIMITED");
    }
    next();
  };
  const bearer = (req: Request) =>
    req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const participant = (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const token = bearer(req);
    const row: any = token
      ? db
          .prepare(
            "SELECT id,display_name AS displayName,active FROM participants WHERE token_hash=?",
          )
          .get(hash(token))
      : undefined;
    if (!row) return fail(res, 401, "participant authorization required");
    if (!row.active && !req.path.endsWith("/departure") && req.path !== "/me")
      return fail(res, 403, "inactive participant cannot mutate", "PARTICIPANT_INACTIVE");
    req.participant = row;
    next();
  };
  const photoParticipant = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = bearer(req);
    const local: any = token
      ? db.prepare("SELECT id,display_name AS displayName,active FROM participants WHERE token_hash=?").get(hash(token))
      : undefined;
    if (local) {
      if (!local.active) return fail(res, 403, "inactive participant cannot upload photos", "PARTICIPANT_INACTIVE");
      req.participant = local;
      return next();
    }
    if (!token || !photoIdentityVerifier)
      return fail(res, 401, "photo vault authorization required", "PHOTO_AUTH_REQUIRED");
    try {
      const verified = await photoIdentityVerifier(token);
      const displayName = cleanName(verified?.displayName, 24);
      if (!verified || !cleanName(verified.subject, 512) || !displayName)
        return fail(res, 401, "photo vault authorization failed", "PHOTO_AUTH_FAILED");
      const subjectHash = hash(verified.subject);
      let row: any = db.prepare("SELECT p.id,p.display_name AS displayName,p.active FROM photo_external_identities x JOIN participants p ON p.id=x.participant_id WHERE x.provider='paul' AND x.subject_hash=?").get(subjectHash);
      if (!row) {
        const participantId = randomUUID();
        const createdAt = now().toISOString();
        tx(() => {
          db.prepare("INSERT INTO participants(id,display_name,token_hash,active,created_at) VALUES(?,?,?,1,?)").run(participantId, displayName, hash(randomBytes(32).toString("hex")), createdAt);
          db.prepare("INSERT INTO photo_external_identities(provider,subject_hash,participant_id,display_name,created_at,updated_at) VALUES('paul',?,?,?,?,?)").run(subjectHash, participantId, displayName, createdAt, createdAt);
          audit(db, participantId, "photo.identity.linked", "photo_identity", participantId, { provider: "paul" });
        });
        row = { id: participantId, displayName, active: 1 };
      } else if (row.displayName !== displayName) {
        const updatedAt = now().toISOString();
        tx(() => {
          db.prepare("UPDATE participants SET display_name=? WHERE id=?").run(displayName, row.id);
          db.prepare("UPDATE photo_external_identities SET display_name=?,updated_at=? WHERE provider='paul' AND subject_hash=?").run(displayName, updatedAt, subjectHash);
        });
        row.displayName = displayName;
      }
      if (!row.active) return fail(res, 403, "photo uploads are disabled for this account", "PHOTO_UPLOADER_INACTIVE");
      req.participant = row;
      next();
    } catch {
      return fail(res, 503, "photo vault sign-in verification is temporarily unavailable", "PHOTO_AUTH_UNAVAILABLE");
    }
  };
  const organizer = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = bearer(req);
    const found =
      token &&
      organizerTokens.some((x) => {
        const a = Buffer.from(x);
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
      });
    if (found) {
      req.organizer = ["Chris", "Paul"][organizerTokens.indexOf(token!)] ?? `organizer:${organizerTokens.indexOf(token!) + 1}`;
      return next();
    }
    if (!token || !organizerIdentityVerifier) return fail(res, 401, "organizer authorization required");
    try {
      const verified = await organizerIdentityVerifier(token);
      const subject = cleanName(verified?.subject, 512), displayName = cleanName(verified?.displayName, 24);
      if (!verified || verified.role !== "host" || !subject || !displayName)
        return fail(res, 401, "organizer authorization required");
      req.organizer = displayName;
      return next();
    } catch {
      return fail(res, 503, "organizer sign-in verification is temporarily unavailable", "ORGANIZER_AUTH_UNAVAILABLE");
    }
  };
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (req.header("sec-fetch-site") === "cross-site")
      return fail(res, 403, "cross-origin photo requests are forbidden", "CROSS_ORIGIN_FORBIDDEN");
    const origin = req.header("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.header("host"))
          return fail(res, 403, "cross-origin photo requests are forbidden", "CROSS_ORIGIN_FORBIDDEN");
      } catch {
        return fail(res, 403, "invalid request origin", "CROSS_ORIGIN_FORBIDDEN");
      }
    }
    next();
  };
  const photoView = (row: any) => ({
    id: row.id,
    state: row.removal_requested_at && row.state !== "DELETED" ? "REMOVAL_REQUESTED" : row.state,
    names: row.optional_names,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removalRequestedAt: row.removal_requested_at,
    publishedAt: row.published_at,
    removedAt: row.removed_at,
    deletedAt: row.deleted_at,
  });
  const photoSettings = () => {
    const row: any = db.prepare("SELECT * FROM photo_wall_settings WHERE id=1").get();
    return {
      enabled: row.enabled === 1,
      rotationIntervalSeconds: row.rotation_interval_seconds,
      updatedActor: row.updated_actor,
      updatedAt: row.updated_at,
    };
  };
  const photoVersion = (row: any) => hash(`${row.content_hash}:${row.updated_at}`).slice(0, 20);
  const organizerPhotoView = (row: any) => {
    const event: any = db.prepare("SELECT reason_codes FROM photo_moderation_events WHERE photo_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(row.id);
    let reasonCodes: string[] = [];
    try {
      const parsed = JSON.parse(event?.reason_codes ?? "[]");
      if (Array.isArray(parsed)) reasonCodes = parsed.filter((value): value is string => typeof value === "string").slice(0, 20);
    } catch { /* malformed historical data is not exposed */ }
    return {
      ...photoView(row),
      uploaderDisplayName: row.uploader_display_name,
      consentTimestamp: row.consented_at,
      reasonCodes,
      title: row.plaque_title,
      caption: row.plaque_caption,
    };
  };
  const sendStoredPhoto = async (res: Response, relativePath: string) => {
    try {
      const bytes = await photoStorage.readStored(relativePath);
      res.set({ "Content-Type": "image/webp", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" });
      return res.send(bytes);
    } catch {
      return fail(res, 404, "photo not found", "PHOTO_NOT_FOUND");
    }
  };
  const members = (teamId: string) =>
    db
      .prepare(
        "SELECT p.id,p.display_name AS displayName FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE tm.team_id=? AND tm.active=1 AND p.active=1 ORDER BY p.created_at,p.id",
      )
      .all(teamId);
  const publicEvent = (event: any) => ({ ...event, kind: publicKind(event.kind) });
  const team = (id: string) => {
    const t: any = db.prepare("SELECT id,name FROM teams WHERE id=?").get(id);
    return t
      ? {
          ...t,
          participantIds: (members(id) as any[]).map((m) => m.id),
          members: members(id),
        }
      : null;
  };
  const matchView = (id: string) => {
    const m: any = db.prepare("SELECT * FROM matches WHERE id=?").get(id);
    if (!m) return null;
    const a = team(m.team_a_id), b = team(m.team_b_id);
    const dispute: any = db.prepare("SELECT id,opened_by openedBy,created_at createdAt FROM disputes WHERE match_id=?").get(m.id);
    return {
      id: m.id,
      eventId: m.event_id,
      round: m.round,
      path: m.path,
      status: ({ FINAL: "confirmed", CANCELLED: "cancelled", AWAITING_CONFIRMATION: "awaiting-confirmation", DISPUTED: "disputed", SKIPPED: "skipped", CALLED: "called", ACTIVE: "active", PENDING: "pending" } as any)[m.status] ?? String(m.status).toLowerCase(),
      teamA: a,
      teamB: b,
      teamIds: [m.team_a_id, m.team_b_id],
      participantIds: [...a.participantIds, ...b.participantIds],
      stationId: m.station_id,
      calledAt: m.called_at,
      completedAt: m.completed_at,
      winnerId: m.winner_id,
      winnerTeamId: m.winner_id,
      advancementCount: m.advancement_count,
      advanced: m.advancement_count > 0,
      dispute,
    };
  };
  const isMember = (participantId: string, teamId: string) =>
    !!db
      .prepare(
        "SELECT 1 FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE tm.participant_id=? AND tm.team_id=? AND tm.active=1 AND p.active=1",
      )
      .get(participantId, teamId);
  const setEventMembership = (
    eventId: string,
    participantId: string,
    joined: boolean,
  ) => {
    const e: any = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
    if (!e || !e.available) return false;
    if (joined)
      db.prepare(
        "INSERT OR IGNORE INTO event_entries(event_id,participant_id) VALUES(?,?)",
      ).run(eventId, participantId);
    else
      db.prepare(
        "DELETE FROM event_entries WHERE event_id=? AND participant_id=?",
      ).run(eventId, participantId);
    return true;
  };
  const placeInMatch = (matchId: string | null, slot: string | null, teamId: string) => {
    if (!matchId || !slot) return;
    db.prepare(`UPDATE matches SET ${slot === "A" ? "team_a_id" : "team_b_id"}=? WHERE id=?`).run(teamId, matchId);
  };
  const enqueueConsolationLoser = (eventId: string, teamId: string) => {
    const byeId = `bye:${eventId}`;
    const slot: any = db.prepare("SELECT * FROM matches WHERE event_id=? AND path='CONSOLATION' AND status='PENDING' AND ((team_a_id=? AND team_b_id<>?) OR (team_b_id=? AND team_a_id<>?)) ORDER BY rowid LIMIT 1").get(eventId, byeId, byeId, byeId, byeId);
    if (slot) {
      db.prepare(`UPDATE matches SET ${slot.team_a_id === byeId ? "team_a_id" : "team_b_id"}=? WHERE id=?`).run(teamId, slot.id);
      return;
    }
    db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,1,'CONSOLATION','CONSOLATION',?,?)").run(randomUUID(), eventId, teamId, byeId);
  };
  const completeConsolationTopology = (eventId: string) => {
    const byeId = `bye:${eventId}`;
    const waiting: any[] = db.prepare("SELECT * FROM matches WHERE event_id=? AND path='CONSOLATION' AND status='PENDING' AND ((team_a_id=? AND team_b_id<>?) OR (team_b_id=? AND team_a_id<>?)) ORDER BY round,rowid").all(eventId, byeId, byeId, byeId, byeId) as any[];
    for (const match of waiting) {
      const waitingTeam = match.team_a_id === byeId ? match.team_b_id : match.team_a_id;
      const opponent: any = db.prepare("SELECT team_id,count(*) games FROM (SELECT team_a_id team_id FROM matches WHERE event_id=? AND status='FINAL' AND team_a_id NOT LIKE 'bye:%' UNION ALL SELECT team_b_id team_id FROM matches WHERE event_id=? AND status='FINAL' AND team_b_id NOT LIKE 'bye:%') WHERE team_id<>? GROUP BY team_id ORDER BY games DESC,team_id LIMIT 1").get(eventId, eventId, waitingTeam);
      if (opponent) db.prepare(`UPDATE matches SET ${match.team_a_id === byeId ? "team_a_id" : "team_b_id"}=? WHERE id=?`).run(opponent.team_id, match.id);
    }
    db.prepare("UPDATE matches SET status='SKIPPED',completed_at=? WHERE event_id=? AND path='CONSOLATION' AND status='PENDING' AND team_a_id=? AND team_b_id=?").run(now().toISOString(), eventId, byeId, byeId);
  };
  const finalizeMatch = (matchId: string, winnerId: string) => {
    const m: any = db.prepare("SELECT * FROM matches WHERE id=?").get(matchId);
    if (!m || m.status === "FINAL") return m;
    if (![m.team_a_id, m.team_b_id].includes(winnerId)) throw new Error("invalid winner");
    const loserId = winnerId === m.team_a_id ? m.team_b_id : m.team_a_id;
    const priorPlayable = m.path === "MAIN" && !loserId.startsWith("bye:")
      ? (db.prepare("SELECT count(*) n FROM matches WHERE id<>? AND status='FINAL' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' AND (team_a_id=? OR team_b_id=?)").get(m.id, loserId, loserId) as any).n
      : 1;
    db.prepare("UPDATE matches SET status='FINAL',winner_id=?,completed_at=?,station_id=NULL,advancement_count=advancement_count+1 WHERE id=?")
      .run(winnerId, now().toISOString(), matchId);
    placeInMatch(m.next_match_id, m.next_slot, winnerId);
    placeInMatch(m.loser_match_id, m.loser_slot, loserId);
    if (m.path === "MAIN" && !m.loser_match_id && !loserId.startsWith("bye:") && priorPlayable === 0) enqueueConsolationLoser(m.event_id, loserId);
    if (m.path === "MAIN" && db.prepare("SELECT 1 FROM matches WHERE event_id=? AND role='FINAL' AND status='FINAL'").get(m.event_id)) completeConsolationTopology(m.event_id);
    return db.prepare("SELECT * FROM matches WHERE id=?").get(matchId);
  };

  const health = (_req: Request, res: Response) =>
    res.json({
      ok: true,
      database: "ready",
      migration: db.pragma("user_version", { simple: true }),
    });
  app.get("/health", health);
  app.get("/api/health", health);
  app.get("/station/:id", (_req, res) =>
    res.sendFile(path.join(publicDir, "station.html")),
  );
  app.post("/api/participants", rateLimit("signup", 35), (req, res) => {
    const displayName = cleanName(req.body?.displayName);
    const requestedEventIds = req.body?.eventIds ?? [];
    if (!displayName)
      return fail(res, 400, "displayName must be 1-256 characters");
    if (!Array.isArray(requestedEventIds) || requestedEventIds.length > 100 || requestedEventIds.some((value: unknown) => typeof value !== "string" || value.length > 128))
      return fail(res, 400, "eventIds must be a bounded array of event IDs", "INVALID_EVENT_SELECTION");
    const eventIds = [...new Set(requestedEventIds)] as string[];
    const availableEvents = eventIds.length
      ? db.prepare(`SELECT id FROM events WHERE available=1 AND id IN (${eventIds.map(() => "?").join(",")})`).all(...eventIds) as Array<{ id: string }>
      : [];
    if (availableEvents.length !== eventIds.length)
      return fail(res, 400, "one or more selected events are unavailable", "INVALID_EVENT_SELECTION");
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    tx(() => {
      db.prepare(
        "INSERT INTO participants(id,display_name,token_hash) VALUES(?,?,?)",
      ).run(id, displayName, hash(token));
      const join = db.prepare("INSERT INTO event_entries(event_id,participant_id) VALUES(?,?)");
      for (const eventId of eventIds) join.run(eventId, id);
      audit(db, id, "participant.signup", "participant", id, { eventIds });
    });
    res
      .status(201)
      .json({ participant: { id, displayName, active: 1 }, token });
  });
  app.get("/api/participants", (_req, res) =>
    res.json({
      participants: db
        .prepare("SELECT id,display_name AS displayName,active,created_at AS createdAt FROM participants ORDER BY created_at,id")
        .all(),
    }),
  );
  app.get("/api/me", participant, (req: AuthedRequest, res) =>
    res.json({
      participant: req.participant,
      events: db
        .prepare(
          "SELECT e.* FROM events e JOIN event_entries x ON x.event_id=e.id WHERE x.participant_id=? ORDER BY e.sort_order",
        )
        .all(req.participant.id),
    }),
  );
  const parsePhoto = (req: Request, res: Response, next: NextFunction) =>
    photoMultipart(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        const tooLarge = (error as { code?: string }).code === "LIMIT_FILE_SIZE";
        return fail(res, tooLarge ? 413 : 400, tooLarge ? "image exceeds the 8 MiB upload limit" : "invalid bounded multipart upload", tooLarge ? "PHOTO_TOO_LARGE" : "INVALID_MULTIPART");
      }
      if (error) return next(error);
      next();
    });
  app.post(["/api/photos", "/api/photos/upload"], photoParticipant, sameOrigin, parsePhoto, async (req: AuthedRequest, res, next) => {
    let normalized: NormalizedPhoto | undefined;
    try {
      if (!req.file) return fail(res, 400, "one photo file is required", "PHOTO_REQUIRED");
      const acceptedConsent = req.body?.consentAccepted ?? req.body?.consent;
      if (acceptedConsent !== "true" || req.body?.consentVersion !== PHOTO_CONSENT_VERSION)
        return fail(res, 400, "the current photo consent must be explicitly accepted", "PHOTO_CONSENT_REQUIRED");
      const allowedFields = new Set(["consent", "consentAccepted", "consentVersion", "names"]);
      if (Object.keys(req.body ?? {}).some((key) => !allowedFields.has(key)))
        return fail(res, 400, "unexpected photo upload field", "INVALID_PHOTO_FIELDS");
      if (req.body?.consent !== undefined && req.body?.consentAccepted !== undefined && req.body.consent !== req.body.consentAccepted)
        return fail(res, 400, "conflicting photo consent fields", "PHOTO_CONSENT_REQUIRED");
      const rawNames = req.body?.names;
      const names = rawNames === undefined || rawNames === "" ? null : typeof rawNames === "string" ? rawNames.trim() : null;
      if (rawNames !== undefined && (!names || names.length > 120 || /[\u0000-\u001f\u007f<>\\]|\.\.|%2f|%5c/i.test(names)))
        return fail(res, 400, "names must be at most 120 characters of plain text", "INVALID_PHOTO_NAMES");

      const createdAt = now().toISOString();
      if (db.prepare("SELECT 1 FROM photo_uploader_bans WHERE participant_id=?").get(req.participant.id))
        return fail(res, 403, "photo uploads are disabled for this participant", "PHOTO_UPLOADER_BANNED");
      const latest = db.prepare("SELECT created_at FROM photo_uploads WHERE participant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(req.participant.id) as { created_at: string } | undefined;
      const count = (db.prepare("SELECT count(*) count FROM photo_uploads WHERE participant_id=?").get(req.participant.id) as { count: number }).count;
      if (count >= 12)
        return fail(res, 429, "event photo upload limit reached", "PHOTO_EVENT_LIMIT");
      if (latest && now().getTime() - new Date(latest.created_at).getTime() < 60_000) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((60_000 - (now().getTime() - new Date(latest.created_at).getTime())) / 1000))));
        return fail(res, 429, "wait before uploading another photo", "PHOTO_RATE_LIMITED");
      }

      normalized = await photoStorage.normalize(req.file.buffer);
      const finalLatest = db.prepare("SELECT created_at FROM photo_uploads WHERE participant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(req.participant.id) as { created_at: string } | undefined;
      const finalCount = (db.prepare("SELECT count(*) count FROM photo_uploads WHERE participant_id=?").get(req.participant.id) as { count: number }).count;
      if (db.prepare("SELECT 1 FROM photo_uploader_bans WHERE participant_id=?").get(req.participant.id)) {
        await photoStorage.remove(normalized.absolutePath);
        normalized = undefined;
        return fail(res, 403, "photo uploads are disabled for this participant", "PHOTO_UPLOADER_BANNED");
      }
      if (finalCount >= 12) {
        await photoStorage.remove(normalized.absolutePath);
        normalized = undefined;
        return fail(res, 429, "event photo upload limit reached", "PHOTO_EVENT_LIMIT");
      }
      if (finalLatest && now().getTime() - new Date(finalLatest.created_at).getTime() < 60_000) {
        await photoStorage.remove(normalized.absolutePath);
        normalized = undefined;
        res.set("Retry-After", String(Math.max(1, Math.ceil((60_000 - (now().getTime() - new Date(finalLatest.created_at).getTime())) / 1000))));
        return fail(res, 429, "wait before uploading another photo", "PHOTO_RATE_LIMITED");
      }
      const id = randomUUID();
      const correlationId = randomUUID();
      try {
        tx(() => {
          db.prepare("INSERT INTO photo_uploads(id,participant_id,content_hash,state,optional_names,consent_version,consent_text,consented_at,request_correlation_id,width,height,normalized_path,created_at,updated_at) VALUES(?,?,?,'PROCESSING',?,?,?,?,?,?,?,?,?,?)")
            .run(id, req.participant.id, normalized!.contentHash, names, PHOTO_CONSENT_VERSION, PHOTO_CONSENT_TEXT, createdAt, correlationId, normalized!.width, normalized!.height, normalized!.relativePath, createdAt, createdAt);
          audit(db, req.participant.id, "photo.upload.accepted", "photo", id, { consentVersion: PHOTO_CONSENT_VERSION, consentText: PHOTO_CONSENT_TEXT, correlationId });
        });
      } catch (error: any) {
        await photoStorage.remove(normalized.absolutePath);
        normalized = undefined;
        if (error?.code?.startsWith("SQLITE_CONSTRAINT"))
          return fail(res, 409, "duplicate photo replay rejected", "PHOTO_DUPLICATE");
        throw error;
      }

      try {
        const outcome = await runPhotoProcessor(Object.freeze({ id, participantId: req.participant.id, contentHash: normalized.contentHash, absolutePath: normalized.absolutePath, width: normalized.width, height: normalized.height }));
        if (outcome === "PENDING_REVIEW")
          tx(() => {
            db.prepare("UPDATE photo_uploads SET state='PENDING_REVIEW',updated_at=? WHERE id=? AND state='PROCESSING'").run(now().toISOString(), id);
            db.prepare("INSERT INTO photo_moderation_events(id,photo_id,stage,rule_version,verdict,reason_codes,actor,created_at) VALUES(?,?,'PROCESSOR_HOOK','cp-p2','PENDING_REVIEW','[\"PROCESSOR_PENDING\"]','system',?)").run(randomUUID(), id, now().toISOString());
          });
      } catch {
        tx(() => {
          db.prepare("UPDATE photo_uploads SET state='PENDING_REVIEW',updated_at=? WHERE id=? AND state='PROCESSING'").run(now().toISOString(), id);
          db.prepare("INSERT INTO photo_moderation_events(id,photo_id,stage,rule_version,verdict,reason_codes,actor,created_at) VALUES(?,?,'PROCESSOR_HOOK','cp-p2','PENDING_REVIEW','[\"PROCESSOR_ERROR\"]','system',?)").run(randomUUID(), id, now().toISOString());
        });
      }
      const row = db.prepare("SELECT * FROM photo_uploads WHERE id=?").get(id);
      res.status(201).json({ photo: photoView(row) });
    } catch (error) {
      if (normalized) await photoStorage.remove(normalized.absolutePath).catch(() => undefined);
      if (error instanceof PhotoStorageError)
        return fail(res, error.status, error.message, error.code);
      next(error);
    }
  });
  const participantPhotos = (req: AuthedRequest, res: Response) => {
    const rows = db.prepare("SELECT * FROM photo_uploads WHERE participant_id=? ORDER BY created_at DESC,rowid DESC").all(req.participant.id) as any[];
    res.json({ photos: rows.map(photoView) });
  };
  app.get(["/api/photos", "/api/photos/mine"], photoParticipant, participantPhotos);
  app.get("/api/photos/:id", photoParticipant, (req: AuthedRequest, res) => {
    const row = db.prepare("SELECT * FROM photo_uploads WHERE id=? AND participant_id=?").get(String(req.params.id), req.participant.id);
    if (!row) return fail(res, 404, "photo not found", "PHOTO_NOT_FOUND");
    res.json({ photo: photoView(row) });
  });
  app.post("/api/photos/:id/removal-request", photoParticipant, sameOrigin, (req: AuthedRequest, res) => {
    const row: any = db.prepare("SELECT * FROM photo_uploads WHERE id=? AND participant_id=?").get(String(req.params.id), req.participant.id);
    if (!row) return fail(res, 404, "photo not found", "PHOTO_NOT_FOUND");
    if (row.state === "DELETED" || row.removal_requested_at)
      return fail(res, 409, "photo removal request conflicts with its lifecycle", "INVALID_PHOTO_LIFECYCLE");
    const changedAt = now().toISOString();
    tx(() => {
      db.prepare("UPDATE photo_uploads SET removal_requested_at=?,updated_at=? WHERE id=? AND removal_requested_at IS NULL").run(changedAt, changedAt, row.id);
      audit(db, req.participant.id, "photo.removal.requested", "photo", row.id);
    });
    res.json({ photo: photoView(db.prepare("SELECT * FROM photo_uploads WHERE id=?").get(row.id)) });
  });

  const photoRows = () => db.prepare("SELECT u.*,p.display_name uploader_display_name FROM photo_uploads u JOIN participants p ON p.id=u.participant_id ORDER BY u.created_at DESC,u.rowid DESC").all() as any[];
  app.get("/api/organizer/photos", organizer, (_req, res) => {
    const rows = photoRows();
    res.json({
      settings: photoSettings(),
      pending: rows.filter((row) => ["PROCESSING", "PENDING_REVIEW"].includes(row.state)).map(organizerPhotoView),
      published: rows.filter((row) => row.state === "PUBLISHED").map(organizerPhotoView),
      rejected: rows.filter((row) => row.state === "REJECTED").map(organizerPhotoView),
      removed: rows.filter((row) => row.state === "REMOVED").map(organizerPhotoView),
    });
  });
  app.get("/api/organizer/photos/:id/preview", organizer, async (req, res) => {
    const row: any = db.prepare("SELECT normalized_path,plaque_path FROM photo_uploads WHERE id=? AND state<>'DELETED'").get(String(req.params.id));
    if (!row) return fail(res, 404, "photo not found", "PHOTO_NOT_FOUND");
    return sendStoredPhoto(res, row.plaque_path ?? row.normalized_path);
  });
  app.patch("/api/organizer/photo-wall", organizer, sameOrigin, (req: AuthedRequest, res) => {
    if (typeof req.body?.enabled !== "boolean" || Object.keys(req.body ?? {}).some((key) => key !== "enabled"))
      return fail(res, 400, "enabled must be a boolean", "INVALID_PHOTO_WALL_SETTINGS");
    const changedAt = now().toISOString();
    tx(() => {
      db.prepare("UPDATE photo_wall_settings SET enabled=?,updated_actor=?,updated_at=? WHERE id=1").run(Number(req.body.enabled), req.organizer!, changedAt);
      audit(db, req.organizer!, req.body.enabled ? "photo_wall.enable" : "photo_wall.disable", "photo_wall", "1");
    });
    res.json({ settings: photoSettings() });
  });
  app.post("/api/organizer/photos/:id/:action", organizer, sameOrigin, async (req: AuthedRequest, res, next) => {
    const id = String(req.params.id), action = String(req.params.action);
    const row: any = db.prepare("SELECT * FROM photo_uploads WHERE id=?").get(id);
    if (!row) return fail(res, 404, "photo not found", "PHOTO_NOT_FOUND");
    const changedAt = now().toISOString();
    try {
      if (action === "ban-uploader") {
        tx(() => {
          db.prepare("INSERT INTO photo_uploader_bans(participant_id,source_photo_id,actor,created_at) VALUES(?,?,?,?) ON CONFLICT(participant_id) DO NOTHING").run(row.participant_id, id, req.organizer!, changedAt);
          db.prepare("UPDATE photo_uploads SET state='REMOVED',removed_at=COALESCE(removed_at,?),updated_at=? WHERE participant_id=? AND state='PUBLISHED'").run(changedAt, changedAt, row.participant_id);
          db.prepare("UPDATE photo_uploads SET state='REJECTED',updated_at=? WHERE participant_id=? AND state IN ('PROCESSING','PENDING_REVIEW')").run(changedAt, row.participant_id);
          audit(db, req.organizer!, "photo.uploader.ban", "participant", row.participant_id, { sourcePhotoId: id });
        });
        return res.json({ photo: organizerPhotoView(db.prepare("SELECT u.*,p.display_name uploader_display_name FROM photo_uploads u JOIN participants p ON p.id=u.participant_id WHERE u.id=?").get(id)) });
      }
      if (action === "delete") {
        if (row.state !== "DELETED") {
          const backupId = randomUUID(), destination = path.join(path.resolve(dataDir), "backups", `${backupId}.sqlite`);
          await backupDatabase(db, destination);
          tx(() => {
            db.prepare("INSERT INTO backups(id,path) VALUES(?,?)").run(backupId, destination);
            db.prepare("UPDATE photo_uploads SET state='DELETED',deleted_at=?,updated_at=?,constellation_export_state=CASE WHEN constellation_export_state='EXPORTED' THEN 'TOMBSTONED' ELSE constellation_export_state END WHERE id=?").run(changedAt, changedAt, id);
            audit(db, req.organizer!, "photo.delete", "photo", id, { preDestructiveBackupId: backupId });
          });
        }
        // The authoritative lifecycle transition happens before destructive I/O.
        // If cleanup trips over its shoelaces, the photo is already inaccessible
        // and a replay resumes deletion from these retained private paths.
        await photoStorage.removeStored(row.normalized_path);
        await photoStorage.removeStored(row.plaque_path);
        tx(() => db.prepare("UPDATE photo_uploads SET normalized_path=?,plaque_path=NULL WHERE id=?").run(`photos/quarantine/${id}.webp`, id));
        const deleted: any = db.prepare("SELECT u.*,p.display_name uploader_display_name FROM photo_uploads u JOIN participants p ON p.id=u.participant_id WHERE u.id=?").get(id);
        return res.json({ photo: organizerPhotoView(deleted) });
      }
      const transitions: Record<string, { from: string[]; to: string; timestamp?: string }> = {
        publish: { from: ["PENDING_REVIEW"], to: "PUBLISHED", timestamp: "published_at" },
        reject: { from: ["PROCESSING", "PENDING_REVIEW"], to: "REJECTED" },
        remove: { from: ["PUBLISHED"], to: "REMOVED", timestamp: "removed_at" },
        restore: { from: ["REMOVED"], to: "PUBLISHED", timestamp: "published_at" },
      };
      const transition = transitions[action];
      if (!transition) return fail(res, 404, "photo action not found", "PHOTO_ACTION_NOT_FOUND");
      if (row.state !== transition.to && !transition.from.includes(row.state))
        return fail(res, 409, "photo action conflicts with its lifecycle", "INVALID_PHOTO_LIFECYCLE");
      if (row.state !== transition.to) tx(() => {
        const timestampAssignment = transition.timestamp ? `,${transition.timestamp}=?` : "";
        const parameters = transition.timestamp ? [transition.to, changedAt, changedAt, id] : [transition.to, changedAt, id];
        db.prepare(`UPDATE photo_uploads SET state=?,updated_at=?${timestampAssignment} WHERE id=?`).run(...parameters);
        db.prepare("INSERT INTO photo_moderation_events(id,photo_id,stage,rule_version,verdict,reason_codes,actor,created_at) VALUES(?,?,'ORGANIZER','manual-v1',?,'[]',?,?)").run(randomUUID(), id, transition.to, req.organizer!, changedAt);
        audit(db, req.organizer!, `photo.${action}`, "photo", id);
      });
      const updated: any = db.prepare("SELECT u.*,p.display_name uploader_display_name FROM photo_uploads u JOIN participants p ON p.id=u.participant_id WHERE u.id=?").get(id);
      return res.json({ photo: organizerPhotoView(updated) });
    } catch (error) { next(error); }
  });
  app.get("/api/photo-wall", (_req, res) => {
    const settings = photoSettings();
    const rows = settings.enabled ? db.prepare("SELECT * FROM photo_uploads WHERE state='PUBLISHED' AND removal_requested_at IS NULL ORDER BY published_at DESC,rowid DESC LIMIT 50").all() as any[] : [];
    res.set("Cache-Control", "no-store");
    res.json({
      enabled: settings.enabled,
      version: hash(`${settings.updatedAt}:${rows.map((row) => `${row.id}:${row.updated_at}`).join(",")}`).slice(0, 20),
      photos: rows.map((row) => {
        const version = photoVersion(row);
        return { id: row.id, version, imageUrl: `/api/photo-wall/photos/${encodeURIComponent(row.id)}/image?version=${version}`, title: row.plaque_title ?? "Junkyard Hall of Fame", caption: row.plaque_caption ?? "Certified scrap-yard greatness.", ...(row.optional_names ? { names: row.optional_names } : {}) };
      }),
    });
  });
  app.get("/api/photo-wall/photos/:id/image", async (req, res) => {
    const row: any = db.prepare("SELECT u.*,s.enabled FROM photo_uploads u CROSS JOIN photo_wall_settings s WHERE u.id=? AND u.state='PUBLISHED' AND u.removal_requested_at IS NULL AND s.id=1 AND s.enabled=1").get(String(req.params.id));
    if (!row || req.query.version !== photoVersion(row)) return fail(res, 404, "photo not found", "PHOTO_NOT_FOUND");
    return sendStoredPhoto(res, row.plaque_path ?? row.normalized_path);
  });
  app.patch("/api/me", participant, (req: AuthedRequest, res) => {
    const hasName = Object.hasOwn(req.body ?? {}, "displayName");
    const displayName = hasName
      ? cleanName(req.body.displayName)
      : req.participant.displayName;
    if (
      !displayName ||
      (Object.hasOwn(req.body ?? {}, "active") &&
        typeof req.body.active !== "boolean")
    )
      return fail(res, 400, "invalid participant update", "INVALID_PARTICIPANT");
    const active = Object.hasOwn(req.body ?? {}, "active")
      ? Number(req.body.active)
      : req.participant.active;
    tx(() => {
      db.prepare(
        "UPDATE participants SET display_name=?,active=? WHERE id=?",
      ).run(displayName, active, req.participant.id);
      audit(
        db,
        req.participant.id,
        "participant.update",
        "participant",
        req.participant.id,
        { displayName, active },
      );
    });
    res.json({
      participant: { id: req.participant.id, displayName, active },
    });
  });
  app.patch("/api/participants/:id", participant, (req: AuthedRequest, res) => {
    if (req.participant.id !== String(req.params.id))
      return fail(res, 403, "participant identity mismatch", "PARTICIPANT_FORBIDDEN");
    const displayName = cleanName(req.body?.displayName ?? req.participant.displayName);
    if (!displayName) return fail(res, 400, "invalid participant update", "INVALID_PARTICIPANT");
    db.prepare("UPDATE participants SET display_name=? WHERE id=?").run(displayName, req.participant.id);
    audit(db, req.participant.id, "participant.update", "participant", req.participant.id, { displayName });
    res.json({ participant: { ...req.participant, displayName } });
  });
  app.post("/api/me/depart", participant, (req: AuthedRequest, res) => {
    tx(() => {
      db.prepare("UPDATE participants SET active=0 WHERE id=?").run(
        req.participant.id,
      );
      audit(
        db,
        req.participant.id,
        "participant.depart",
        "participant",
        req.participant.id,
      );
    });
    res.sendStatus(204);
  });
  app.post("/api/organizer/participants/:id/deactivate", organizer, async (req: AuthedRequest, res, next) => {
    try {
      if (req.body?.confirm !== true) return fail(res, 400, "explicit participant deactivation confirmation required", "DEACTIVATION_CONFIRMATION_REQUIRED");
      const participantId = String(req.params.id);
      const selected: any = db.prepare("SELECT id,display_name AS displayName,active,created_at AS createdAt FROM participants WHERE id=?").get(participantId);
      if (!selected) return fail(res, 404, "participant not found", "PARTICIPANT_NOT_FOUND");
      if (!selected.active) return res.json({ participant: selected, alreadyInactive: true });
      const activeMatch = db.prepare("SELECT m.id FROM matches m JOIN team_members tm ON tm.team_id IN(m.team_a_id,m.team_b_id) WHERE tm.participant_id=? AND tm.active=1 AND m.status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(participantId);
      if (activeMatch) return fail(res, 409, "participant is in a live match; resolve or requeue it before deactivation", "PARTICIPANT_IN_LIVE_MATCH");
      const backupId = randomUUID(), root = path.resolve(process.env.DATA_DIR ?? "/tmp/junkyard-olympics"), destination = path.join(root, "backups", `${backupId}.sqlite`);
      await backupDatabase(db, destination);
      db.prepare("INSERT INTO backups(id,path) VALUES(?,?)").run(backupId, destination);
      audit(db, req.organizer!, "backup.create", "backup", backupId, { reason: "participant.deactivate", participantId });
      tx(() => {
        db.prepare("UPDATE participants SET active=0 WHERE id=?").run(participantId);
        db.prepare("UPDATE team_members SET active=0 WHERE participant_id=? AND active=1").run(participantId);
        audit(db, req.organizer!, "participant.deactivate", "participant", participantId, { displayName: selected.displayName, backupId });
      });
      res.json({ participant: { ...selected, active: 0 }, backupId });
    } catch (error) { next(error); }
  });
  app.post(
    "/api/participants/me/departure",
    participant,
    (req: AuthedRequest, res) => {
      tx(() => {
        db.prepare("UPDATE participants SET active=0 WHERE id=?").run(
          req.participant.id,
        );
        audit(
          db,
          req.participant.id,
          "participant.depart",
          "participant",
          req.participant.id,
        );
      });
      res.json({ participant: { ...req.participant, active: 0 } });
    },
  );
  app.get("/api/events", (_req, res) =>
    res.json({
      events: (db
        .prepare(
          "SELECT id,name,kind,play_mode AS playMode,sort_order AS sortOrder,available FROM events ORDER BY sort_order",
        )
        .all() as any[]).map(publicEvent),
    }),
  );
  app.get("/api/state", (_req, res) =>
    res.json({
      participants: db
        .prepare("SELECT p.id,p.display_name AS displayName,p.active,p.created_at AS createdAt,(SELECT count(*) FROM event_entries x WHERE x.participant_id=p.id) AS eventCount FROM participants p ORDER BY p.created_at,p.id")
        .all(),
      events: db
        .prepare("SELECT id,name,kind,play_mode AS playMode,sort_order AS sortOrder,available FROM events ORDER BY sort_order")
        .all(),
      eventEntries: db
        .prepare("SELECT event_id AS eventId,participant_id AS participantId,joined_at AS joinedAt FROM event_entries ORDER BY rowid")
        .all(),
      teams: db
        .prepare("SELECT id,event_id AS eventId,name FROM teams ORDER BY rowid")
        .all(),
      teamMembers: db
        .prepare("SELECT team_id AS teamId,participant_id AS participantId,active,substitute FROM team_members ORDER BY rowid")
        .all(),
      matches: db
        .prepare("SELECT id,event_id AS eventId,round,path,status,station_id AS stationId,team_a_id AS teamAId,team_b_id AS teamBId,winner_id AS winnerId,reported_winner_id AS reportedWinnerId,reporter_id AS reporterId,called_at AS calledAt,started_at AS startedAt,completed_at AS completedAt FROM matches ORDER BY rowid")
        .all(),
      stations: db
        .prepare("SELECT id,name,event_id AS eventId,available FROM stations ORDER BY rowid")
        .all(),
      disputes: db
        .prepare("SELECT id,match_id AS matchId,opened_by AS openedBy,created_at AS createdAt FROM disputes WHERE resolved_at IS NULL ORDER BY created_at")
        .all(),
      cannonRuns: db
        .prepare("SELECT id,event_id AS eventId,mode,duration_seconds AS durationSeconds,carnage_bonus AS carnageBonus,created_at AS createdAt FROM cannon_runs ORDER BY created_at,rowid")
        .all(),
      cannonAssignments: db
        .prepare("SELECT run_id AS runId,team_id AS teamId,lane_id AS laneId FROM cannon_run_assignments ORDER BY rowid")
        .all(),
      cannonTeamRuns: db
        .prepare("SELECT id,run_id AS runId,team_id AS teamId,state,armed_clear AS armedClear,started_at AS startedAt,deadline_at AS deadlineAt,ended_at AS endedAt,stop_reason AS stopReason FROM cannon_team_runs ORDER BY created_at,rowid")
        .all(),
      targets: db
        .prepare("SELECT id,event_id AS eventId,name,points,jackpot FROM targets ORDER BY rowid")
        .all(),
      cannonShots: (db
        .prepare("SELECT s.id,s.run_id AS runId,s.team_id AS teamId,s.lane_id AS laneId,s.kind,s.sequence,s.points,s.created_at AS createdAt,COALESCE((SELECT json_group_array(t.name) FROM cannon_shot_targets st JOIN targets t ON t.id=st.target_id WHERE st.shot_id=s.id),'[]') AS targetNamesJson FROM cannon_shots s WHERE s.run_id IS NOT NULL ORDER BY s.created_at,s.rowid")
        .all() as any[]).map(({ targetNamesJson, ...shot }) => ({
          ...shot,
          targetNames: JSON.parse(targetNamesJson),
        })),
      flairFeed: db
        .prepare("SELECT f.id,p.display_name AS recipientDisplayName,f.category,f.created_at AS createdAt FROM flair_props f JOIN participants p ON p.id=f.recipient_id ORDER BY f.created_at DESC,f.rowid DESC LIMIT 12")
        .all(),
    }),
  );
  app.get("/api/events/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(
      `event: ready\ndata: ${JSON.stringify({ at: now().toISOString() })}\n\n`,
    );
    const timer = setInterval(
      () => res.write(`event: heartbeat\ndata: {}\n\n`),
      15000,
    );
    req.on("close", () => clearInterval(timer));
  });
  app.get("/api/events/:id", (req, res) => {
    const event: any = db
      .prepare("SELECT id,name,kind,play_mode AS playMode,sort_order AS sortOrder,available FROM events WHERE id=?")
      .get(String(req.params.id));
    if (!event) return fail(res, 404, "event not found", "EVENT_NOT_FOUND");
    event.participantIds = (
      db
        .prepare("SELECT participant_id AS participantId FROM event_entries WHERE event_id=? ORDER BY joined_at,participant_id")
        .all(event.id) as any[]
    ).map((row) => row.participantId);
    res.json({ event: publicEvent(event) });
  });
  app.put(
    "/api/events/:id/participants/me",
    participant,
    (req: AuthedRequest, res) => {
      if (!setEventMembership(String(req.params.id), req.participant.id, true))
        return fail(res, 404, "event unavailable", "EVENT_NOT_FOUND");
      res.json({ joined: true });
    },
  );
  app.delete(
    "/api/events/:id/participants/me",
    participant,
    (req: AuthedRequest, res) => {
      setEventMembership(String(req.params.id), req.participant.id, false);
      res.sendStatus(204);
    },
  );
  app.post("/api/events/:id/join", participant, (req: AuthedRequest, res) => {
    const e: any = db
      .prepare("SELECT * FROM events WHERE id=?")
      .get(String(req.params.id));
    if (!e || !e.available) return fail(res, 404, "event unavailable");
    if (e.late_entry_locked)
      return fail(res, 409, "championship late entry is closed");
    tx(() => {
      db.prepare(
        "INSERT OR IGNORE INTO event_entries(event_id,participant_id) VALUES(?,?)",
      ).run(e.id, req.participant.id);
      audit(db, req.participant.id, "event.join", "event", e.id);
    });
    res.sendStatus(204);
  });
  app.delete("/api/events/:id/join", participant, (req: AuthedRequest, res) => {
    tx(() => {
      db.prepare(
        "DELETE FROM event_entries WHERE event_id=? AND participant_id=?",
      ).run(String(req.params.id), req.participant.id);
      audit(
        db,
        req.participant.id,
        "event.leave",
        "event",
        String(req.params.id),
      );
    });
    res.sendStatus(204);
  });

  const flairAliases: Record<string, string> = {
    "Best Costume": "BEST_COSTUME",
    "Epic Entrance": "EPIC_ENTRANCE",
    "Creative Trash Talk": "CREATIVE_TRASH_TALK",
    "Spectacular Failure": "SPECTACULAR_FAILURE",
    "Unnecessary Showmanship": "UNNECESSARY_SHOWMANSHIP",
    "Junkyard Ingenuity": "JUNKYARD_INGENUITY",
    "Great Sportsmanship": "GREAT_SPORTSMANSHIP",
    "Spectacular Destruction": "SPECTACULAR_DESTRUCTION",
  };
  app.post("/api/flair/props", rateLimit("flair-prop", 40), participant, (req: AuthedRequest, res) => {
    const recipientId = req.body?.recipientId;
    const category = flairAliases[req.body?.category] ?? req.body?.category;
    const key = cleanName(req.body?.idempotencyKey, 200);
    const scope = `flair-prop:${req.participant.id}`;
    const prior: any = key && db.prepare("SELECT response_json FROM idempotency_keys WHERE scope=? AND key=?").get(scope, key);
    if (prior) return res.json(JSON.parse(prior.response_json));
    if (recipientId === req.participant.id) return fail(res, 400, "self awards are not allowed");
    if (!flairCategories.has(category) || !db.prepare("SELECT 1 FROM participants WHERE id=?").get(recipientId)) return fail(res, 400, "invalid prop");
    try {
      const response = { id: randomUUID() };
      tx(() => {
        db.prepare("INSERT INTO flair_props(id,giver_id,recipient_id,category) VALUES(?,?,?,?)").run(response.id, req.participant.id, recipientId, category);
        if (key) db.prepare("INSERT INTO idempotency_keys(scope,key,response_json) VALUES(?,?,?)").run(scope, key, JSON.stringify(response));
        audit(db, req.participant.id, "flair.prop", "participant", recipientId, { category });
      });
      res.status(201).json(response);
    } catch (e: any) {
      if (e.code?.startsWith("SQLITE_CONSTRAINT")) return fail(res, 409, "prop already awarded");
      throw e;
    }
  });
  const flairVote = (req: AuthedRequest, res: Response) => {
    const recipientId = req.body?.recipientId;
    const key = cleanName(req.body?.idempotencyKey, 200), scope = `flair-vote:${req.participant.id}`;
    const prior: any = key && db.prepare("SELECT response_json FROM idempotency_keys WHERE scope=? AND key=?").get(scope, key);
    if (prior) return res.json(JSON.parse(prior.response_json));
    if (recipientId === req.participant.id || !db.prepare("SELECT 1 FROM participants WHERE id=?").get(recipientId)) return fail(res, 400, "invalid vote");
    try {
      const response = { id: randomUUID() };
      tx(() => {
        db.prepare("INSERT INTO flair_votes(id,voter_id,recipient_id) VALUES(?,?,?)").run(response.id, req.participant.id, recipientId);
        if (key) db.prepare("INSERT INTO idempotency_keys(scope,key,response_json) VALUES(?,?,?)").run(scope, key, JSON.stringify(response));
        audit(db, req.participant.id, "flair.vote", "participant", recipientId);
      });
      res.status(201).json(response);
    } catch (e: any) {
      if (e.code?.startsWith("SQLITE_CONSTRAINT")) return fail(res, 409, "final vote already cast");
      throw e;
    }
  };
  app.post("/api/flair/vote", rateLimit("flair-vote", 40), participant, flairVote);
  app.put("/api/flair/showboat-vote", rateLimit("flair-vote", 40), participant, flairVote);
  const flairStandings = () => (db.prepare(`SELECT p.id participantId,p.display_name displayName,COALESCE(x.props,0) propPoints,COALESCE(v.votes,0)*3 votePoints,COALESCE(x.props,0)+COALESCE(v.votes,0)*3 total,COALESCE(x.props,0)+COALESCE(v.votes,0)*3 points FROM participants p LEFT JOIN (SELECT recipient_id,count(*) props FROM flair_props GROUP BY recipient_id)x ON x.recipient_id=p.id LEFT JOIN (SELECT recipient_id,count(*) votes FROM flair_votes GROUP BY recipient_id)v ON v.recipient_id=p.id WHERE COALESCE(x.props,0)+COALESCE(v.votes,0)>0 ORDER BY total DESC,p.display_name`).all() as any[]).map(row => ({ ...row, categories: Object.fromEntries((db.prepare("SELECT category,count(*) n FROM flair_props WHERE recipient_id=? GROUP BY category").all(row.participantId) as any[]).map(x => [x.category.split("_").map((s: string) => s[0] + s.slice(1).toLowerCase()).join(" "), x.n])) }));
  app.get("/api/flair/standings", (_req, res) => res.json(flairStandings()));
  app.get("/api/standings/flair", (_req, res) => res.json({ standings: flairStandings() }));

  app.post(
    "/api/events/:id/teams/form",
    organizer,
    (req: AuthedRequest, res) => {
      const teamEvent: any = db.prepare("SELECT play_mode AS playMode FROM events WHERE id=?").get(String(req.params.id));
      if (!teamEvent) return fail(res, 404, "event not found", "EVENT_NOT_FOUND");
      if (teamEvent.playMode === "CASUAL") return fail(res, 409, "casual activities do not form tournament teams", "CASUAL_ACTIVITY");
      const requested = Array.isArray(req.body?.participantIds) ? [...new Set(req.body.participantIds)] : null;
      if (requested && (requested.length < 2 || requested.some((id) => typeof id !== "string")))
        return fail(res, 400, "participantIds must identify at least two participants", "INVALID_PARTICIPANTS");
      const entrants: any[] = requested
        ? db.prepare(`SELECT id,display_name displayName FROM participants WHERE active=1 AND id IN (${requested.map(() => "?").join(",")})`).all(...requested)
        : db.prepare(
            "SELECT p.id,p.display_name displayName FROM event_entries x JOIN participants p ON p.id=x.participant_id WHERE x.event_id=? AND p.active=1 AND NOT EXISTS(SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=x.event_id AND tm.participant_id=p.id) ORDER BY x.rowid",
          ).all(String(req.params.id));
      if (requested && entrants.length !== requested.length)
        return fail(res, 400, "participantIds contain an unknown or inactive participant", "INVALID_PARTICIPANTS");
      if (entrants.length < 2)
        return fail(res, 409, "at least two unassigned entrants required");
      if (requested) {
        const requestedOrder = new Map(requested.map((id, index) => [id, index]));
        entrants.sort((left, right) => requestedOrder.get(left.id)! - requestedOrder.get(right.id)!);
      }
      const made: any[] = [];
      const partneredCache = new Map<string, boolean>();
      const partnered = (a: string, b: string) => {
        const key = [a, b].sort().join(":");
        if (!partneredCache.has(key)) partneredCache.set(key, !!db.prepare("SELECT 1 FROM team_members x JOIN team_members y ON y.team_id=x.team_id JOIN teams t ON t.id=x.team_id WHERE x.participant_id=? AND y.participant_id=? AND x.participant_id<>y.participant_id LIMIT 1").get(a,b));
        return partneredCache.get(key)!;
      };
      const shuffled = () => {
        const candidate = [...entrants];
        for (let i = candidate.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidate[i], candidate[j]] = [candidate[j], candidate[i]];
        }
        return candidate;
      };
      const repeatScore = (candidate: any[]) => {
        let score = 0, index = 0;
        while (index < candidate.length) {
          const remaining = candidate.length - index, size = remaining === 3 ? 3 : 2;
          const group = candidate.slice(index, index + size);
          for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) if (partnered(group[left].id, group[right].id)) score++;
          index += size;
        }
        return score;
      };
      const initial = shuffled();
      const zeroRepeatGroups = (ordered: any[]) => {
        const failed = new Set<string>();
        const solve = (remaining: number[], trioOpen: boolean): number[][] | null => {
          if (remaining.length === 0) return trioOpen ? null : [];
          if (remaining.length === 1 || (trioOpen && remaining.length < 3)) return null;
          const key = `${trioOpen ? 1 : 0}:${remaining.join(",")}`;
          if (failed.has(key)) return null;
          let anchor = remaining[0]!;
          for (const candidate of remaining) {
            const candidateDegree = remaining.filter(other => other !== candidate && !partnered(ordered[candidate]!.id, ordered[other]!.id)).length;
            const anchorDegree = remaining.filter(other => other !== anchor && !partnered(ordered[anchor]!.id, ordered[other]!.id)).length;
            if (candidateDegree < anchorDegree) anchor = candidate;
          }
          const others = remaining.filter(index => index !== anchor);
          for (const partner of others) {
            if (partnered(ordered[anchor]!.id, ordered[partner]!.id)) continue;
            const tail = solve(others.filter(index => index !== partner), trioOpen);
            if (tail) return [[anchor, partner], ...tail];
          }
          if (trioOpen) for (let left = 0; left < others.length; left++) for (let right = left + 1; right < others.length; right++) {
            const second = others[left]!, third = others[right]!;
            if (partnered(ordered[anchor]!.id, ordered[second]!.id) || partnered(ordered[anchor]!.id, ordered[third]!.id) || partnered(ordered[second]!.id, ordered[third]!.id)) continue;
            const tail = solve(others.filter(index => index !== second && index !== third), false);
            if (tail) return [[anchor, second, third], ...tail];
          }
          failed.add(key);
          return null;
        };
        return solve(ordered.map((_entry, index) => index), ordered.length % 2 === 1);
      };
      const exactGroups = zeroRepeatGroups(initial);
      let arranged: any[];
      if (exactGroups) {
        const pairs = exactGroups.filter(group => group.length === 2), trio = exactGroups.find(group => group.length === 3);
        arranged = [...pairs, ...(trio ? [trio] : [])].flatMap(group => group.map(index => initial[index]));
      } else {
        arranged = initial;
        let bestScore = repeatScore(arranged);
        for (let attempt = 0; attempt < Math.max(128, entrants.length * 32) && bestScore > 0; attempt++) {
          const candidate = shuffled(), score = repeatScore(candidate);
          if (score < bestScore) { arranged = candidate; bestScore = score; }
        }
      }
      entrants.splice(0, entrants.length, ...arranged);
      tx(() => {
        if (requested?.length) db.prepare(`UPDATE team_members SET active=0 WHERE active=1 AND participant_id IN (${requested.map(() => "?").join(",")}) AND team_id IN (SELECT id FROM teams WHERE event_id=?)`).run(...requested, String(req.params.id));
        let index = 0,
          nameIndex = Number(
            (
              db
                .prepare("SELECT count(*) n FROM teams WHERE event_id=?")
                .get(String(req.params.id)) as any
            ).n,
          );
        while (index < entrants.length) {
          const remaining = entrants.length - index;
          const size = remaining === 3 ? 3 : 2;
          const group = entrants.slice(index, index + size);
          const id = randomUUID();
          let name = teamNames[nameIndex++ % teamNames.length]!;
          while (
            db
              .prepare("SELECT 1 FROM teams WHERE event_id=? AND name=?")
              .get(String(req.params.id), name)
          )
            name = `${teamNames[nameIndex++ % teamNames.length]} ${nameIndex}`;
          db.prepare("INSERT INTO teams(id,event_id,name) VALUES(?,?,?)").run(
            id,
            String(req.params.id),
            name,
          );
          for (const p of group)
            db.prepare(
              "INSERT INTO team_members(team_id,participant_id) VALUES(?,?)",
            ).run(id, p.id);
          made.push({ id, name, participantIds: group.map((p) => p.id), members: group });
          index += size;
        }
        audit(
          db,
          req.organizer!,
          "teams.form",
          "event",
          String(req.params.id),
          { teamIds: made.map((t) => t.id) },
        );
      });
      res.status(201).json({ teams: made });
    },
  );
  app.post("/api/teams/:id/rename", participant, (req: AuthedRequest, res) => {
    const name = cleanName(req.body?.name, 40);
    const t: any = db
      .prepare("SELECT * FROM teams WHERE id=?")
      .get(String(req.params.id));
    if (!name || !t || !isMember(req.participant.id, t.id))
      return fail(res, 400, "invalid rename");
    if (t.renamed || t.name_locked) return fail(res, 409, "team name locked");
    tx(() => {
      db.prepare("INSERT INTO team_rename_proposals(team_id,proposer_id,name) VALUES(?,?,?) ON CONFLICT(team_id) DO UPDATE SET proposer_id=excluded.proposer_id,name=excluded.name,created_at=CURRENT_TIMESTAMP").run(t.id,req.participant.id,name);
      audit(db, req.participant.id, "team.rename.propose", "team", t.id, { name });
    });
    res.json({ ...team(t.id), approvalPending: true, proposedName: name });
  });
  app.post("/api/teams/:id/rename/approve", participant, (req: AuthedRequest, res) => {
    const proposal: any = db.prepare("SELECT rp.*,t.name_locked,t.renamed FROM team_rename_proposals rp JOIN teams t ON t.id=rp.team_id WHERE rp.team_id=?").get(String(req.params.id));
    if (!proposal || proposal.proposer_id === req.participant.id || !isMember(req.participant.id, proposal.team_id)) return fail(res,403,"teammate approval required");
    if (proposal.name_locked || proposal.renamed) return fail(res,409,"team name locked");
    tx(() => {
      db.prepare("UPDATE teams SET name=?,renamed=1 WHERE id=?").run(proposal.name,proposal.team_id);
      db.prepare("DELETE FROM team_rename_proposals WHERE team_id=?").run(proposal.team_id);
      audit(db,req.participant.id,"team.rename.approve","team",proposal.team_id,{name:proposal.name});
    });
    res.json(team(proposal.team_id));
  });

  app.post("/api/cannon/setup", organizer, (req: AuthedRequest, res) => {
    if (req.body?.confirm !== true)
      return fail(res, 400, "explicit Cannon setup confirmation required", "CANNON_SETUP_CONFIRMATION_REQUIRED");
    if (!Array.isArray(req.body?.targets) || req.body.targets.length < 1 || req.body.targets.length > 50)
      return fail(res, 400, "targets must be a non-empty bounded array", "INVALID_TARGETS");
    const targets = req.body.targets.map((value: any) => ({ name: cleanName(value?.name), points: value?.points, jackpot: value?.jackpot === true }));
    if (targets.some((target: any) => !target.name || !Number.isSafeInteger(target.points) || target.points < 0) || targets.filter((target: any) => target.jackpot).length > 1)
      return fail(res, 400, "invalid Cannon target catalog", "INVALID_TARGETS");
    if (db.prepare("SELECT 1 FROM cannon_runs LIMIT 1").get())
      return fail(res, 409, "a Cannon run already exists", "CANNON_ALREADY_CONFIGURED");
    if (db.prepare("SELECT 1 FROM targets WHERE event_id='cannon' LIMIT 1").get())
      return fail(res, 409, "Cannon targets already exist without a run; organizer cleanup is required", "CANNON_PARTIAL_SETUP");
    const teams = db.prepare("SELECT t.id FROM teams t WHERE t.event_id='cannon' AND EXISTS(SELECT 1 FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE tm.team_id=t.id AND tm.active=1 AND p.active=1) ORDER BY t.rowid").all() as Array<{ id: string }>;
    const entryCount = (db.prepare("SELECT count(*) n FROM event_entries x JOIN participants p ON p.id=x.participant_id WHERE x.event_id='cannon' AND p.active=1").get() as any).n;
    const assignedCount = (db.prepare("SELECT count(DISTINCT tm.participant_id) n FROM team_members tm JOIN teams t ON t.id=tm.team_id JOIN participants p ON p.id=tm.participant_id WHERE t.event_id='cannon' AND tm.active=1 AND p.active=1").get() as any).n;
    if (entryCount < 2 || assignedCount !== entryCount || teams.length < 1)
      return fail(res, 409, "form Cannon teams for every active entrant before setup", "CANNON_TEAMS_REQUIRED");
    const mode = req.body?.mode === "timed" ? "timed" : "quota";
    const durationSeconds = mode === "timed" ? req.body?.durationSeconds : 300;
    const carnageBonus = mode === "timed" ? req.body?.carnageBonus : 50;
    if (durationSeconds !== 300 || !Number.isSafeInteger(carnageBonus) || carnageBonus < 0)
      return fail(res, 400, "invalid Cannon timed-run configuration", "INVALID_CANNON_CONFIG");
    const runId = randomUUID();
    const assignments = teams.map((team, index) => ({ teamId: team.id, laneId: index % 2 === 0 ? "Lane 1" : "Lane 2" }));
    const createdTargets = tx(() => {
      const made = targets.map((target: any) => {
        const id = randomUUID();
        db.prepare("INSERT INTO targets(id,event_id,name,points,jackpot) VALUES(?,?,?,?,?)").run(id, "cannon", target.name, target.points, Number(target.jackpot));
        return { id, ...target };
      });
      db.prepare("INSERT INTO cannon_runs(id,event_id,mode,duration_seconds,carnage_bonus) VALUES(?,?,?,?,?)")
        .run(runId, "cannon", mode, durationSeconds, carnageBonus);
      for (const assignment of assignments)
        db.prepare("INSERT INTO cannon_run_assignments(run_id,team_id,lane_id) VALUES(?,?,?)").run(runId, assignment.teamId, assignment.laneId);
      audit(db, req.organizer!, "cannon.setup", "cannon_run", runId, { teamCount: teams.length, targetCount: made.length, lanes: ["Lane 1", "Lane 2"] });
      return made;
    });
    res.status(201).json({ run: { id: runId, eventId: "cannon", assignments }, targets: createdTargets });
  });

  app.post("/api/cannon/targets", organizer, (req: AuthedRequest, res) => {
    if (!Array.isArray(req.body?.targets) || req.body.targets.length < 1 || req.body.targets.length > 50)
      return fail(res, 400, "targets must be a non-empty bounded array", "INVALID_TARGETS");
    const targets = req.body.targets.map((value: any) => ({ name: cleanName(value?.name), points: value?.points, jackpot: !!value?.jackpot }));
    if (targets.some((target: any) => !target.name || !Number.isSafeInteger(target.points) || target.points < 0))
      return fail(res, 400, "invalid target", "INVALID_TARGET");
    const created = tx(() => targets.map((target: any) => {
      const id = randomUUID();
      db.prepare("INSERT INTO targets(id,event_id,name,points,jackpot) VALUES(?,?,?,?,?)").run(id, "cannon", target.name, target.points, Number(target.jackpot));
      audit(db, req.organizer!, "target.create", "target", id);
      return { id, ...target };
    }));
    res.status(201).json({ targets: created });
  });

  app.post("/api/cannon/runs", organizer, (req: AuthedRequest, res) => {
    const eventId = cleanName(req.body?.eventId), teamIds = req.body?.teamIds, laneIds = req.body?.laneIds;
    if (!eventId || !Array.isArray(teamIds) || !Array.isArray(laneIds) || teamIds.length < 1 || teamIds.length !== laneIds.length || new Set(teamIds).size !== teamIds.length || teamIds.some((id: unknown) => typeof id !== "string") || laneIds.some((id: unknown) => !cleanName(id)))
      return fail(res, 400, "invalid Cannon run", "INVALID_CANNON_RUN");
    if (!db.prepare("SELECT 1 FROM events WHERE id=? AND kind='CANNON'").get(eventId)) return fail(res, 400, "run event is not Cannon", "INVALID_CANNON_RUN");
    const valid = (db.prepare(`SELECT count(*) count FROM teams WHERE event_id=? AND id IN (${teamIds.map(() => "?").join(",")})`).get(eventId, ...teamIds) as any).count;
    if (valid !== teamIds.length) return fail(res, 400, "run contains a foreign team", "INVALID_CANNON_RUN");
    const id = randomUUID();
    const assignments = teamIds.map((teamId: string, index: number) => ({ teamId, laneId: laneIds[index] }));
    tx(() => {
      db.prepare("INSERT INTO cannon_runs(id,event_id) VALUES(?,?)").run(id, eventId);
      for (const assignment of assignments) db.prepare("INSERT INTO cannon_run_assignments(run_id,team_id,lane_id) VALUES(?,?,?)").run(id, assignment.teamId, assignment.laneId);
      audit(db, req.organizer!, "cannon.run.create", "cannon_run", id, { assignments });
    });
    res.status(201).json({ run: { id, eventId, assignments } });
  });

  const cannonTeamRunView = (id: string) => {
    const row: any = db.prepare(`SELECT id,run_id runId,team_id teamId,state,armed_clear armedClear,
      duration_seconds durationSeconds,started_at startedAt,deadline_at deadlineAt,ended_at endedAt,stop_reason stopReason
      FROM cannon_team_runs WHERE id=?`).get(id);
    return row ? { ...row, armedClear: !!row.armedClear } : null;
  };
  const expireTimedCannonRun = (row: any) => {
    if (row?.state === "ACTIVE" && row.deadlineAt && row.deadlineAt <= now().toISOString()) {
      db.prepare("UPDATE cannon_team_runs SET state='COMPLETE',armed_clear=0,ended_at=? WHERE id=? AND state='ACTIVE'").run(row.deadlineAt, row.id);
      return cannonTeamRunView(row.id);
    }
    return row;
  };
  app.post("/api/cannon/runs/:runId/teams/:teamId/arm", organizer, (req: AuthedRequest, res) => {
    const runId = String(req.params.runId), teamId = String(req.params.teamId);
    const assignment = db.prepare("SELECT 1 FROM cannon_run_assignments WHERE run_id=? AND team_id=?").get(runId, teamId);
    if (!assignment) return fail(res, 404, "Cannon assignment not found", "CANNON_ASSIGNMENT_NOT_FOUND");
    if (members(teamId).length !== 2) return fail(res, 409, "timed Cannon requires exactly two active team members", "CANNON_TEAM_SIZE_INVALID");
    const clear = req.body?.clear === true;
    const existing: any = db.prepare("SELECT id,state FROM cannon_team_runs WHERE run_id=? AND team_id=?").get(runId, teamId);
    if (existing && existing.state !== "PENDING") return fail(res, 409, "team run can no longer be armed", "CANNON_TEAM_RUN_LOCKED");
    const id = existing?.id ?? randomUUID();
    tx(() => {
      db.prepare(`INSERT INTO cannon_team_runs(id,run_id,team_id,armed_clear) VALUES(?,?,?,?)
        ON CONFLICT(run_id,team_id) DO UPDATE SET armed_clear=excluded.armed_clear`).run(id, runId, teamId, Number(clear));
      audit(db, req.organizer!, clear ? "cannon.team_run.arm" : "cannon.team_run.disarm", "cannon_team_run", id, { runId, teamId });
    });
    res.json({ teamRun: cannonTeamRunView(id) });
  });
  app.post("/api/cannon/runs/:runId/teams/:teamId/start", organizer, (req: AuthedRequest, res) => {
    const runId = String(req.params.runId), teamId = String(req.params.teamId);
    const existing: any = db.prepare(`SELECT id,run_id runId,team_id teamId,state,armed_clear armedClear,
      deadline_at deadlineAt FROM cannon_team_runs WHERE run_id=? AND team_id=?`).get(runId, teamId);
    if (!existing?.armedClear) return fail(res, 409, "lane must be marked ARMED/CLEAR", "CANNON_LANE_NOT_ARMED");
    if (existing.state !== "PENDING") return fail(res, 409, "team run already started", "CANNON_TEAM_RUN_LOCKED");
    const active: any = db.prepare("SELECT id,deadline_at deadlineAt,state FROM cannon_team_runs WHERE run_id=? AND state='ACTIVE'").get(runId);
    const refreshed = expireTimedCannonRun(active);
    if (refreshed?.state === "ACTIVE") return fail(res, 409, "another Cannon team is already active", "CANNON_TEAM_ALREADY_ACTIVE");
    const startedAt = now().toISOString(), deadlineAt = new Date(now().getTime() + 300_000).toISOString();
    tx(() => {
      db.prepare("UPDATE cannon_team_runs SET state='ACTIVE',started_at=?,deadline_at=? WHERE id=?").run(startedAt, deadlineAt, existing.id);
      audit(db, req.organizer!, "cannon.team_run.start", "cannon_team_run", existing.id, { runId, teamId, durationSeconds: 300 });
    });
    res.status(201).json({ teamRun: cannonTeamRunView(existing.id) });
  });
  app.post("/api/cannon/team-runs/:teamRunId/safety-stop", organizer, (req: AuthedRequest, res) => {
    const id = String(req.params.teamRunId), reason = cleanName(req.body?.reason) || "safety stop";
    const row: any = db.prepare("SELECT state FROM cannon_team_runs WHERE id=?").get(id);
    if (!row) return fail(res, 404, "Cannon team run not found", "CANNON_TEAM_RUN_NOT_FOUND");
    if (row.state !== "ACTIVE") return fail(res, 409, "Cannon team run is not active", "CANNON_RUN_NOT_ACTIVE");
    const endedAt = now().toISOString();
    tx(() => {
      db.prepare("UPDATE cannon_team_runs SET state='SAFETY_STOPPED',armed_clear=0,ended_at=?,stop_reason=? WHERE id=?").run(endedAt, reason, id);
      audit(db, req.organizer!, "cannon.team_run.safety_stop", "cannon_team_run", id, { reason });
    });
    res.json({ teamRun: cannonTeamRunView(id) });
  });
  app.post("/api/cannon/team-runs/:teamRunId/shots", organizer, (req: AuthedRequest, res) => {
    const teamRunId = String(req.params.teamRunId);
    let teamRun: any = db.prepare(`SELECT tr.id,tr.run_id runId,tr.team_id teamId,tr.state,tr.deadline_at deadlineAt,a.lane_id laneId,r.event_id eventId,r.carnage_bonus carnageBonus
      FROM cannon_team_runs tr JOIN cannon_run_assignments a ON a.run_id=tr.run_id AND a.team_id=tr.team_id
      JOIN cannon_runs r ON r.id=tr.run_id WHERE tr.id=?`).get(teamRunId);
    if (!teamRun) return fail(res, 404, "Cannon team run not found", "CANNON_TEAM_RUN_NOT_FOUND");
    teamRun = expireTimedCannonRun(teamRun);
    if (teamRun?.state === "COMPLETE") return fail(res, 409, "five-minute Cannon window has expired", "CANNON_RUN_EXPIRED");
    if (teamRun?.state !== "ACTIVE") return fail(res, 409, "Cannon team run is not active", "CANNON_RUN_NOT_ACTIVE");
    const targetIds: unknown[] = Array.isArray(req.body?.targetIds) ? [...new Set(req.body.targetIds)] : [];
    if (targetIds.length > 20 || targetIds.some(id => typeof id !== "string")) return fail(res, 400, "invalid target list", "INVALID_TARGET");
    const targets: any[] = targetIds.length ? db.prepare(`SELECT * FROM targets WHERE event_id=? AND id IN (${targetIds.map(() => "?").join(",")})`).all(teamRun.eventId, ...targetIds) : [];
    if (targets.length !== targetIds.length) return fail(res, 400, "unknown target", "INVALID_TARGET");
    const carnage = req.body?.carnage === true;
    if (carnage && targetIds.length < 2) return fail(res, 400, "Carnage requires two or more separately labeled targets", "INVALID_CARNAGE");
    const roster = members(teamRun.teamId) as any[], requestedShooterId = cleanName(req.body?.shooterId);
    const shooter = requestedShooterId ? roster.find(member => member.id === requestedShooterId) : roster[0];
    if (!shooter) return fail(res, 409, "active Cannon shooter not found", "CANNON_SHOOTER_REQUIRED");
    const sequence = (db.prepare("SELECT count(*) n FROM cannon_shots WHERE team_run_id=?").get(teamRunId) as any).n + 1;
    const total = targets.reduce((sum, target) => sum + target.points, 0) + (carnage ? teamRun.carnageBonus : 0), id = randomUUID();
    tx(() => {
      db.prepare("INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,practice,carnage,points,run_id,lane_id,kind,sequence,team_run_id) VALUES(?,?,?,?,0,?,?,?,?,?,?,?)")
        .run(id, teamRun.eventId, teamRun.teamId, shooter.id, Number(carnage), total, teamRun.runId, teamRun.laneId, "timed", sequence, teamRunId);
      for (const target of targets) db.prepare("INSERT INTO cannon_shot_targets(shot_id,target_id,points) VALUES(?,?,?)").run(id, target.id, target.points);
      audit(db, req.organizer!, "cannon.timed_shot", "shot", id, { teamRunId, sequence, shooterId: shooter.id });
    });
    res.status(201).json({ shot: { ...cannonShotView(id), sequence, teamRunId } });
  });

  const cannonShotView = (id: string) => {
    const shot: any = db.prepare(`SELECT s.id,s.run_id runId,s.team_id teamId,s.lane_id laneId,s.kind,s.sequence,s.points total,s.carnage,
      COALESCE(r.carnage_bonus,50) configuredCarnageBonus FROM cannon_shots s LEFT JOIN cannon_runs r ON r.id=s.run_id WHERE s.id=?`).get(id);
    const targetPoints = (db.prepare("SELECT COALESCE(sum(points),0) points FROM cannon_shot_targets WHERE shot_id=?").get(id) as any).points;
    return { ...shot, targetPoints, carnageBonus: shot.carnage ? shot.configuredCarnageBonus : 0, organizerConfirmed: !!shot.carnage };
  };
  app.post("/api/cannon/runs/:runId/shots", organizer, (req: AuthedRequest, res) => {
    const runId = String(req.params.runId), teamId = cleanName(req.body?.teamId), laneId = cleanName(req.body?.laneId);
    const kind = req.body?.kind, sequence = req.body?.sequence, targetIds: unknown[] = Array.isArray(req.body?.targetIds) ? [...new Set(req.body.targetIds)] : [];
    const assignment: any = teamId && laneId ? db.prepare("SELECT r.event_id eventId FROM cannon_run_assignments a JOIN cannon_runs r ON r.id=a.run_id WHERE a.run_id=? AND a.team_id=? AND a.lane_id=?").get(runId, teamId, laneId) : null;
    if (!assignment || !["practice", "scored"].includes(kind) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > (kind === "practice" ? 10 : 20) || targetIds.length > 20 || targetIds.some((id) => typeof id !== "string"))
      return fail(res, 400, "invalid Cannon shot", "INVALID_CANNON_SHOT");
    const existing: any = db.prepare("SELECT id FROM cannon_shots WHERE run_id=? AND team_id=? AND kind=? AND sequence=?").get(runId, teamId, kind, sequence);
    if (existing) return res.json({ shot: cannonShotView(existing.id) });
    const targets: any[] = targetIds.length ? db.prepare(`SELECT * FROM targets WHERE event_id=? AND id IN (${targetIds.map(() => "?").join(",")})`).all(assignment.eventId, ...targetIds) : [];
    if (targets.length !== targetIds.length) return fail(res, 400, "unknown target", "INVALID_TARGET");
    const roster = members(teamId!) as any[], requestedShooterId = cleanName(req.body?.shooterId), individualLimit = kind === "practice" ? 5 : 10, teamLimit = kind === "practice" ? 10 : 20;
    const teamCount = (db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind=?").get(runId, teamId, kind) as any).n;
    if (teamCount >= teamLimit) return fail(res, 409, "Cannon shot allowance exhausted", "SHOT_LIMIT_REACHED");
    const quotaOwnerFor = (memberId: string) => {
      let current = memberId;
      const visited = new Set<string>();
      while (!visited.has(current)) {
        visited.add(current);
        const edge: any = db.prepare("SELECT leaving_id FROM substitutions WHERE team_id=? AND replacement_id=? AND reversed=0 ORDER BY rowid DESC LIMIT 1").get(teamId, current);
        if (!edge?.leaving_id) return current;
        current = edge.leaving_id;
      }
      return null;
    };
    const candidate = requestedShooterId
      ? roster.find(member => member.id === requestedShooterId && (db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind=? AND shooter_id=?").get(runId, teamId, kind, quotaOwnerFor(member.id)) as any).n < individualLimit)
      : roster.find(member => (db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind=? AND shooter_id=?").get(runId, teamId, kind, quotaOwnerFor(member.id)) as any).n < individualLimit);
    const actualShooterId = candidate?.id, quotaOwnerId = actualShooterId ? quotaOwnerFor(actualShooterId) : null;
    if (!actualShooterId || !quotaOwnerId) return fail(res, 409, "Cannon shot allowance exhausted", "SHOT_LIMIT_REACHED");
    const carnage = kind === "scored" && req.body?.carnage === true;
    const targetPoints = targets.reduce((sum, target) => sum + target.points, 0), total = kind === "practice" ? 0 : targetPoints + (carnage ? 50 : 0), id = randomUUID();
    tx(() => {
      db.prepare("INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,practice,carnage,points,run_id,lane_id,kind,sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, assignment.eventId, teamId, quotaOwnerId, Number(kind === "practice"), Number(carnage), total, runId, laneId, kind, sequence);
      for (const target of targets) db.prepare("INSERT INTO cannon_shot_targets(shot_id,target_id,points) VALUES(?,?,?)").run(id, target.id, target.points);
      if (carnage) for (const member of roster) db.prepare("INSERT OR IGNORE INTO flair_props(id,giver_id,recipient_id,category) VALUES(?,?,?,'SPECTACULAR_DESTRUCTION')").run(randomUUID(), member.id, member.id);
      audit(db, req.organizer!, "cannon.shot", "shot", id, { runId, laneId, kind, sequence, actualShooterId, quotaOwnerId });
    });
    res.status(201).json({ shot: cannonShotView(id) });
  });
  app.get("/api/cannon/runs/:runId/shots", organizer, (req, res) => res.json({ shots: (db.prepare("SELECT id FROM cannon_shots WHERE run_id=? ORDER BY rowid").all(String(req.params.runId)) as any[]).map((row) => cannonShotView(row.id)) }));
  const runStandings = (runId: string) => {
    const rows: any[] = db.prepare(`SELECT a.team_id teamId,COALESCE(sum(CASE WHEN s.practice=0 THEN s.points ELSE 0 END),0) total,EXISTS(SELECT 1 FROM cannon_shots js JOIN cannon_shot_targets st ON st.shot_id=js.id JOIN targets t ON t.id=st.target_id WHERE js.run_id=a.run_id AND js.team_id=a.team_id AND t.jackpot=1) jackpot FROM cannon_run_assignments a LEFT JOIN cannon_shots s ON s.run_id=a.run_id AND s.team_id=a.team_id WHERE a.run_id=? GROUP BY a.team_id ORDER BY jackpot DESC,total DESC,a.team_id`).all(runId) as any[];
    const shootouts: any[] = db.prepare("SELECT team_id teamId,round,points FROM cannon_shootout_shots WHERE run_id=? ORDER BY round").all(runId) as any[];
    const groups = new Map<string,string[]>();
    rows.forEach(row => { const key=`${Number(row.jackpot)}:${row.total}`, group=groups.get(key) ?? []; group.push(row.teamId); groups.set(key,group); });
    const affected = [...groups.values()].filter(group => group.length > 1 && group.some(teamId => rows.findIndex(row => row.teamId === teamId) < 4));
    const tied = affected.flat();
    const activeGroups = affected.flatMap(group => {
      let roundGroups = [group];
      const rounds = [...new Set(shootouts.filter(shot => group.includes(shot.teamId)).map(shot => shot.round))].sort((a,b) => a-b);
      for (const round of rounds) {
        const nextGroups: string[][] = [];
        for (const activeGroup of roundGroups) {
          const roundShots = activeGroup.map(teamId => shootouts.find(shot => shot.teamId === teamId && shot.round === round));
          if (roundShots.some(shot => !shot)) {
            nextGroups.push(activeGroup);
            continue;
          }
          const byPoints = new Map<number, string[]>();
          roundShots.forEach(shot => {
            const pointsGroup = byPoints.get(shot!.points) ?? [];
            pointsGroup.push(shot!.teamId);
            byPoints.set(shot!.points, pointsGroup);
          });
          nextGroups.push(...[...byPoints.values()].filter(pointsGroup => pointsGroup.length > 1));
        }
        roundGroups = nextGroups;
      }
      return roundGroups;
    });
    const unresolved = activeGroups.length > 0;
    return { standings: rows.map((row) => ({ ...row, jackpot: !!row.jackpot })), tie: tied.length ? { teamIds: tied, activeTeamIds: activeGroups.flat(), activeGroups, unresolved } : null };
  };
  const shootoutSignatures = (runId: string) => {
    const shots: any[] = db.prepare("SELECT team_id teamId,round,points FROM cannon_shootout_shots WHERE run_id=? ORDER BY round").all(runId) as any[];
    const rounds = [...new Set(shots.map(shot => shot.round))].sort((a,b) => a-b);
    return new Map<string, number[]>([...new Set(shots.map(shot => shot.teamId))].map(teamId => [teamId, rounds.map(round => shots.find(shot => shot.teamId === teamId && shot.round === round)?.points ?? Number.NEGATIVE_INFINITY)]));
  };
  app.get("/api/cannon/runs/:runId/standings", (req, res) => res.json(runStandings(String(req.params.runId))));
  app.post("/api/cannon/runs/:runId/shootout-shots", organizer, (req: AuthedRequest, res) => {
    const runId = String(req.params.runId), teamId = cleanName(req.body?.teamId), round = req.body?.round;
    if (!teamId || !Number.isSafeInteger(round) || round < 1 || !db.prepare("SELECT 1 FROM cannon_run_assignments WHERE run_id=? AND team_id=?").get(runId, teamId)) return fail(res, 400, "invalid shootout shot", "INVALID_SHOOTOUT_SHOT");
    const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds : [], targets: any[] = targetIds.length ? db.prepare(`SELECT points FROM targets WHERE event_id='cannon' AND id IN (${targetIds.map(() => "?").join(",")})`).all(...targetIds) : [];
    if (targets.length !== targetIds.length) return fail(res, 400, "invalid shootout targets", "INVALID_TARGET");
    const points = Number.isSafeInteger(req.body?.points) && req.body.points >= 0 ? req.body.points : targets.reduce((sum, target) => sum + target.points, 0);
    const existing: any = db.prepare("SELECT id,points FROM cannon_shootout_shots WHERE run_id=? AND team_id=? AND round=?").get(runId, teamId, round);
    if (existing) return res.json({ shot: { ...existing, runId, teamId, round } });
    const id = randomUUID(); tx(() => { db.prepare("INSERT INTO cannon_shootout_shots(id,run_id,team_id,round,points) VALUES(?,?,?,?,?)").run(id, runId, teamId, round, points); audit(db, req.organizer!, "cannon.shootout", "shot", id, { runId, teamId, round, points }); });
    res.status(201).json({ shot: { id, runId, teamId, round, points } });
  });
  app.post("/api/cannon/runs/:runId/finalize", organizer, (req: AuthedRequest, res) => {
    const runId = String(req.params.runId);
    const run: any = db.prepare("SELECT r.*,e.kind FROM cannon_runs r JOIN events e ON e.id=r.event_id WHERE r.id=?").get(runId);
    if (!run || run.kind !== "CANNON") return fail(res,404,"Cannon run not found","CANNON_RUN_NOT_FOUND");
    const alreadyComplete: any = db.prepare("SELECT completed_at FROM events WHERE id=?").get(run.event_id);
    if (alreadyComplete?.completed_at) return res.json({ placements: db.prepare("SELECT * FROM placements WHERE event_id=? ORDER BY place,participant_id").all(run.event_id) });
    const incomplete: any = db.prepare(`SELECT a.team_id teamId
      FROM cannon_run_assignments a
      WHERE a.run_id=? AND (
        (SELECT count(*) FROM cannon_shots s WHERE s.run_id=a.run_id AND s.team_id=a.team_id AND s.kind='scored')<>20 OR
        EXISTS(SELECT 1 FROM team_members tm
          WHERE tm.team_id=a.team_id AND tm.substitute=0
          AND (SELECT count(*) FROM cannon_shots s WHERE s.run_id=a.run_id AND s.team_id=a.team_id AND s.kind='scored' AND s.shooter_id=tm.participant_id)<>10)
      ) LIMIT 1`).get(runId);
    if (incomplete) return fail(res,409,"configured Cannon scored shots are incomplete","CANNON_SHOTS_INCOMPLETE");
    if (runStandings(runId).tie?.unresolved) return fail(res,409,"sudden death is unresolved","SUDDEN_DEATH_REQUIRED");
    {
      const ranked: any[] = db.prepare(`SELECT a.team_id teamId,COALESCE(sum(CASE WHEN s.practice=0 THEN s.points ELSE 0 END),0) total,EXISTS(SELECT 1 FROM cannon_shots js JOIN cannon_shot_targets st ON st.shot_id=js.id JOIN targets t ON t.id=st.target_id WHERE js.run_id=a.run_id AND js.team_id=a.team_id AND t.jackpot=1) jackpot FROM cannon_run_assignments a LEFT JOIN cannon_shots s ON s.run_id=a.run_id AND s.team_id=a.team_id WHERE a.run_id=? GROUP BY a.team_id ORDER BY jackpot DESC,total DESC,a.team_id`).all(runId) as any[];
      const signatures = shootoutSignatures(runId);
      ranked.sort((a,b) => {
        const sporting = Number(b.jackpot)-Number(a.jackpot) || b.total-a.total;
        if (sporting) return sporting;
        const left = signatures.get(a.teamId) ?? [], right = signatures.get(b.teamId) ?? [];
        for (let round = 0; round < Math.max(left.length, right.length); round++) {
          const difference = (right[round] ?? Number.NEGATIVE_INFINITY) - (left[round] ?? Number.NEGATIVE_INFINITY);
          if (difference) return difference;
        }
        return 0;
      });
      if (ranked.length < 4) return fail(res,409,"four Cannon teams are required","TOP_FOUR_INCOMPLETE");
      tx(() => {
        ranked.slice(0,4).forEach((row, index) => {
          const place = index + 1;
          const eligible: any[] = db.prepare("SELECT participant_id FROM team_members WHERE team_id=? AND eligible_points=1").all(row.teamId) as any[];
          for (const member of eligible) db.prepare("INSERT OR IGNORE INTO placements(event_id,participant_id,place,points) VALUES(?,?,?,?)").run(run.event_id,member.participant_id,place,pointsForPlace(place));
        });
        db.prepare("UPDATE events SET completed_at=? WHERE id=?").run(now().toISOString(),run.event_id);
        audit(db,req.organizer!,"event.finalize","event",run.event_id,{ runId });
      });
    }
    res.json({ placements: db.prepare("SELECT * FROM placements WHERE event_id=? ORDER BY place,participant_id").all(run.event_id) });
  });

  app.post("/api/events/:id/targets", organizer, (req: AuthedRequest, res) => {
    const name = cleanName(req.body?.name);
    const points = req.body?.points;
    if (!name || !Number.isSafeInteger(points) || points < 0)
      return fail(res, 400, "invalid target");
    const id = randomUUID();
    tx(() => {
      db.prepare(
        "INSERT INTO targets(id,event_id,name,points,jackpot) VALUES(?,?,?,?,?)",
      ).run(id, String(req.params.id), name, points, req.body?.jackpot ? 1 : 0);
      audit(db, req.organizer!, "target.create", "target", id);
    });
    res.status(201).json({ id, name, points, jackpot: !!req.body?.jackpot });
  });
  app.post(
    "/api/cannon/lanes/:laneId/shots",
    organizer,
    (req: AuthedRequest, res) => {
      const eventId = cleanName(req.body?.eventId);
      const teamId = cleanName(req.body?.teamId);
      const shooterId = cleanName(req.body?.shooterId);
      const ids: unknown[] = Array.isArray(req.body?.targetIds)
        ? [...new Set(req.body.targetIds)]
        : [];
      if (
        !eventId ||
        !teamId ||
        !shooterId ||
        !db.prepare("SELECT 1 FROM teams t JOIN events e ON e.id=t.event_id WHERE t.id=? AND t.event_id=? AND e.kind='CANNON'").get(teamId, eventId) ||
        !isMember(shooterId, teamId) ||
        ids.length > 20 ||
        ids.some((id) => typeof id !== "string")
      )
        return fail(res, 400, "invalid Cannon shot", "INVALID_CANNON_SHOT");
      const targets: any[] = ids.length
        ? db
            .prepare(
              `SELECT * FROM targets WHERE event_id=? AND id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(eventId, ...ids)
        : [];
      if (targets.length !== ids.length)
        return fail(res, 400, "unknown target", "INVALID_TARGET");
      const practice = req.body?.kind === "practice" || !!req.body?.practice;
      const counts: any = db.prepare("SELECT count(*) total,sum(CASE WHEN shooter_id=? THEN 1 ELSE 0 END) individual FROM cannon_shots WHERE team_id=? AND practice=?").get(shooterId, teamId, Number(practice));
      if (counts.total >= (practice ? 10 : 20) || counts.individual >= (practice ? 5 : 10))
        return fail(res, 409, "Cannon shot allowance exhausted", "SHOT_LIMIT_REACHED");
      const carnage = !!req.body?.carnage && !!req.body?.carnageConfirmed;
      const targetPoints = targets.reduce((sum, target) => sum + target.points, 0);
      const total = practice ? 0 : targetPoints + (carnage ? 50 : 0);
      const id = randomUUID();
      tx(() => {
        db.prepare(
          "INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,practice,carnage,points) VALUES(?,?,?,?,?,?,?)",
        ).run(id, eventId, teamId, shooterId, Number(practice), Number(carnage), total);
        for (const target of targets)
          db.prepare(
            "INSERT INTO cannon_shot_targets(shot_id,target_id,points) VALUES(?,?,?)",
          ).run(id, target.id, target.points);
        audit(db, req.organizer!, "cannon.shot", "shot", id, {
          laneId: String(req.params.laneId),
          sequence: req.body?.sequence,
          kind: practice ? "practice" : "scored",
        });
      });
      res.status(201).json({
        id,
        laneId: String(req.params.laneId),
        teamId,
        targetPoints,
        carnageBonus: carnage ? 50 : 0,
        total,
        practice,
      });
    },
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/shots",
    organizer,
    (req: AuthedRequest, res) => {
      const ids: unknown[] = Array.isArray(req.body?.targetIds)
        ? [...new Set(req.body.targetIds)]
        : [];
      const eventId = String(req.params.eventId), teamId = String(req.params.teamId);
      const shooterId = cleanName(req.body?.shooterId);
      if (!shooterId || !db.prepare("SELECT 1 FROM teams t JOIN events e ON e.id=t.event_id WHERE t.id=? AND t.event_id=? AND e.kind='CANNON'").get(teamId, eventId) || !isMember(shooterId, teamId) || ids.length > 20 || ids.some((x) => typeof x !== "string"))
        return fail(res, 400, "invalid targets");
      const targets: any[] = ids.length
        ? db
            .prepare(
              `SELECT * FROM targets WHERE event_id=? AND id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(String(req.params.eventId), ...ids)
        : [];
      if (targets.length !== ids.length)
        return fail(res, 400, "unknown target");
      const carnage = !!req.body?.carnage && !!req.body?.carnageConfirmed;
      const practice = !!req.body?.practice;
      const counts: any = db.prepare("SELECT count(*) total,sum(CASE WHEN shooter_id=? THEN 1 ELSE 0 END) individual FROM cannon_shots WHERE team_id=? AND practice=?").get(shooterId, teamId, Number(practice));
      if (counts.total >= (practice ? 10 : 20) || counts.individual >= (practice ? 5 : 10))
        return fail(res, 409, "Cannon shot allowance exhausted", "SHOT_LIMIT_REACHED");
      const points = practice
        ? 0
        : targets.reduce((n, t) => n + t.points, 0) + (carnage ? 50 : 0);
      const id = randomUUID();
      tx(() => {
        db.prepare(
          "INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,practice,carnage,points) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id,
          String(req.params.eventId),
          String(req.params.teamId),
          shooterId,
          practice ? 1 : 0,
          carnage ? 1 : 0,
          points,
        );
        for (const t of targets)
          db.prepare(
            "INSERT INTO cannon_shot_targets(shot_id,target_id,points) VALUES(?,?,?)",
          ).run(id, t.id, t.points);
        if (carnage)
          for (const m of members(String(req.params.teamId)) as any[])
            db.prepare(
              "INSERT OR IGNORE INTO flair_props(id,giver_id,recipient_id,category) VALUES(?,?,?,'SPECTACULAR_DESTRUCTION')",
            ).run(randomUUID(), m.id, m.id);
        audit(db, req.organizer!, "cannon.shot", "shot", id, {
          targets: targets.map((t) => t.id),
          carnage,
          practice,
          points,
        });
      });
      res
        .status(201)
        .json({
          id,
          points,
          practice,
          carnage,
          jackpot: targets.some((t) => t.jackpot),
        });
    },
  );
  app.get("/api/events/:id/cannon/standings", (req, res) =>
    res.json(
      (
        db
          .prepare(
            `SELECT t.id teamId,t.name,COALESCE((SELECT sum(s.points) FROM cannon_shots s WHERE s.team_id=t.id AND s.practice=0),0) total,EXISTS(SELECT 1 FROM cannon_shots s JOIN cannon_shot_targets st ON st.shot_id=s.id JOIN targets g ON g.id=st.target_id WHERE s.team_id=t.id AND s.practice=0 AND g.jackpot=1) jackpot FROM teams t WHERE t.event_id=? ORDER BY jackpot DESC,total DESC,t.name`,
          )
          .all(String(req.params.id)) as any[]
      ).map((row) => ({ ...row, jackpot: !!row.jackpot })),
    ),
  );
  const championshipResponse = () => {
    const acceptance: any[] = db.prepare("SELECT ap.*,p.display_name displayName FROM acceptance_placements ap JOIN participants p ON p.id=ap.participant_id").all();
    if (acceptance.length) {
      const standings = acceptance.map(row => {
        const fields = JSON.parse(row.field_json).sort((a: number,b: number) => b-a);
        const countedFieldPoints = fields.slice(0,3), droppedFieldPoints = fields.slice(3);
        return { participantId: row.participant_id, displayName: row.displayName, total: (row.cannon ?? 0) + countedFieldPoints.reduce((a:number,b:number)=>a+b,0), eligible: row.cannon != null && fields.length >= 3, countedFieldPoints, droppedFieldPoints };
      }).sort((a,b) => Number(b.eligible)-Number(a.eligible) || b.total-a.total);
      return { standings, podium: standings.filter(row => row.eligible).slice(0, 3) };
    }
    const rows: any[] = db
      .prepare(
        "SELECT p.id participantId,p.display_name displayName,e.kind,pl.points,e.name FROM participants p LEFT JOIN (placements pl JOIN events pe ON pe.id=pl.event_id AND pe.completed_at IS NOT NULL AND pl.points=CASE pl.place WHEN 1 THEN 10 WHEN 2 THEN 7 WHEN 3 THEN 5 WHEN 4 THEN 3 ELSE 1 END) ON pl.participant_id=p.id LEFT JOIN events e ON e.id=pl.event_id ORDER BY p.id,pl.points DESC",
      )
      .all();
    const grouped = new Map<string, any>();
    for (const r of rows) {
      const x = grouped.get(r.participantId) ?? {
        participantId: r.participantId,
        displayName: r.displayName,
        cannon: [],
        fields: [],
      };
      if (r.points != null)
        (r.kind === "CANNON" ? x.cannon : x.fields).push({
          points: r.points,
          event: r.name,
        });
      grouped.set(r.participantId, x);
    }
    const result = [...grouped.values()]
      .map((x) => {
        const fields = x.fields.sort((a: any, b: any) => b.points - a.points);
        const counted = fields.slice(0, 3);
        return {
          participantId: x.participantId,
          displayName: x.displayName,
          total:
            (x.cannon[0]?.points ?? 0) +
            counted.reduce((n: number, y: any) => n + y.points, 0),
          eligible: x.cannon.length > 0 && fields.length >= 3,
          counted: [x.cannon[0], ...counted].filter(Boolean),
          dropped: fields.slice(3).map((y: any) => y.points),
        };
      })
      .sort(
        (a, b) =>
          Number(b.eligible) - Number(a.eligible) ||
          b.total - a.total ||
          a.displayName.localeCompare(b.displayName),
      );
    return { standings: result, podium: result.filter(row => row.eligible).slice(0, 3) };
  };
  app.get(["/api/standings/championship", "/api/championship/standings"], (_req, res) => res.json(championshipResponse()));
  app.post("/api/admin/acceptance/placements", organizer, (req: AuthedRequest, res) => {
    const { participantId, cannon, field } = req.body ?? {};
    if (!db.prepare("SELECT 1 FROM participants WHERE id=?").get(participantId) || !(cannon === null || Number.isFinite(cannon)) || !Array.isArray(field) || field.some((x:unknown)=>!Number.isFinite(x))) return fail(res,400,"invalid acceptance placement");
    db.prepare("INSERT INTO acceptance_placements(participant_id,cannon,field_json) VALUES(?,?,?) ON CONFLICT(participant_id) DO UPDATE SET cannon=excluded.cannon,field_json=excluded.field_json").run(participantId,cannon,JSON.stringify(field));
    audit(db,req.organizer!,"acceptance.placement","participant",participantId);
    res.status(201).json({ participantId });
  });
  app.get("/api/events/:id/standings", (req,res) => res.json({ standings: db.prepare("SELECT participant_id participantId,place,points,1 placementPointsAwardCount FROM placements WHERE event_id=? ORDER BY place").all(String(req.params.id)) }));

  const seededBracketSlots = (teamRows: any[], size: number, byeId: string) => {
    const matchCount = size / 2, byeCount = size - teamRows.length;
    const bits = Math.log2(matchCount);
    const reverseBits = (value: number) => {
      let reversed = 0;
      for (let bit=0; bit<bits; bit++) reversed = (reversed << 1) | ((value >> bit) & 1);
      return reversed;
    };
    const byeMatches = new Set(Array.from({ length: matchCount }, (_, index) => reverseBits(index)).slice(0, byeCount));
    const seeded: string[] = [];
    let teamIndex = 0;
    for (let matchIndex=0; matchIndex<matchCount; matchIndex++) {
      if (byeMatches.has(matchIndex)) seeded.push(teamRows[teamIndex++]!.id, byeId);
      else seeded.push(teamRows[teamIndex++]!.id, teamRows[teamIndex++]!.id);
    }
    return seeded;
  };

  app.post("/api/events/:id/bracket", organizer, (req: AuthedRequest, res) => {
    const bracketEvent: any = db.prepare("SELECT kind,play_mode AS playMode FROM events WHERE id=?").get(String(req.params.id));
    if (!bracketEvent || bracketEvent.kind !== "HEAD_TO_HEAD" || bracketEvent.playMode === "CASUAL") return fail(res,409,"event does not use a scored head-to-head bracket","BRACKET_NOT_SUPPORTED");
    const requestedTeamIds = Array.isArray(req.body?.teamIds) ? [...new Set(req.body.teamIds)] : null;
    const teams: any[] = requestedTeamIds ? db.prepare(`SELECT id FROM teams WHERE event_id=? AND id IN (${requestedTeamIds.map(()=>"?").join(",")}) ORDER BY rowid`).all(String(req.params.id),...requestedTeamIds) : db.prepare("SELECT id FROM teams WHERE event_id=? ORDER BY rowid").all(String(req.params.id));
    if (requestedTeamIds && teams.length !== requestedTeamIds.length) return fail(res,400,"invalid bracket teams","INVALID_TEAMS");
    if (teams.length < 2) return fail(res, 409, "teams required");
    if (
      db
        .prepare("SELECT 1 FROM matches WHERE event_id=?")
        .get(String(req.params.id))
    )
      return fail(res, 409, "bracket already exists");
    const matches: any[] = [];
    tx(() => {
      const eventId = String(req.params.id);
      const size = 2 ** Math.ceil(Math.log2(teams.length));
      const rounds = Math.log2(size);
      const byeId = `bye:${eventId}`;
      db.prepare("INSERT OR IGNORE INTO teams(id,event_id,name,name_locked) VALUES(?,?,?,1)").run(byeId, eventId, "BYE");
      const byRound = new Map<number, string[]>();
      for (let round = rounds; round >= 1; round--) {
        const count = size / 2 ** round;
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const id = randomUUID(); ids.push(id);
          const role = round === rounds ? "FINAL" : round === rounds - 1 ? "SEMIFINAL" : "STANDARD";
          db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,?,'MAIN',?,?,?)")
            .run(id, eventId, round, role, byeId, byeId);
        }
        byRound.set(round, ids);
      }
      for (let round = 1; round < rounds; round++) {
        const current = byRound.get(round)!;
        const next = byRound.get(round + 1)!;
        current.forEach((id, i) => db.prepare("UPDATE matches SET next_match_id=?,next_slot=? WHERE id=?").run(next[Math.floor(i / 2)], i % 2 ? "B" : "A", id));
      }
      let consolation: string[] = [];
      const consolationSize = size / 2;
      if (teams.length >= 3 && size <= 8) {
        let prior: string[] = [];
        for (let i = 0; i < consolationSize / 2; i++) {
          const id = randomUUID(); prior.push(id); consolation.push(id);
          const role = consolationSize === 2 ? "CONSOLATION_FINAL" : "STANDARD";
          db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,1,'CONSOLATION',?,?,?)").run(id,eventId,role,byeId,byeId);
        }
        let consolationRound = 2;
        while (prior.length > 1) {
          const next: string[] = [];
          for (let i = 0; i < prior.length; i += 2) {
            const id = randomUUID(); next.push(id); consolation.push(id);
            const role = prior.length === 2 ? "CONSOLATION_FINAL" : "STANDARD";
            db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,?,'CONSOLATION',?,?,?)").run(id,eventId,consolationRound,role,byeId,byeId);
            db.prepare("UPDATE matches SET next_match_id=?,next_slot='A' WHERE id=?").run(id,prior[i]);
            db.prepare("UPDATE matches SET next_match_id=?,next_slot='B' WHERE id=?").run(id,prior[i + 1]);
          }
          prior = next;
          consolationRound += 1;
        }
      }

      const thirdId = teams.length >= 4 ? randomUUID() : null;
      if (thirdId) db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,?,'MAIN','THIRD_PLACE',?,?)").run(thirdId,eventId,rounds,byeId,byeId);
      const first = byRound.get(1)!;
      const seeded = seededBracketSlots(teams, size, byeId);
      first.forEach((id, i) => {
        const real = !seeded[i*2]!.startsWith("bye:") && !seeded[i*2+1]!.startsWith("bye:");
        const realIndex = first.slice(0,i).filter((_,j) => !seeded[j*2]!.startsWith("bye:") && !seeded[j*2+1]!.startsWith("bye:")).length;
        db.prepare("UPDATE matches SET team_a_id=?,team_b_id=?,loser_match_id=?,loser_slot=? WHERE id=?").run(seeded[i*2],seeded[i*2+1],real ? consolation[Math.floor(realIndex/2)] ?? null : null,real ? (realIndex%2 ? "B" : "A") : null,id);
      });
      if (thirdId) byRound.get(rounds - 1)!.forEach((id,i) => db.prepare("UPDATE matches SET loser_match_id=?,loser_slot=? WHERE id=?").run(thirdId,i ? "B" : "A",id));
      let changed = true;
      while (changed) {
        changed = false;
        const byes: any[] = db.prepare("SELECT * FROM matches WHERE event_id=? AND path='MAIN' AND round=1 AND status='PENDING' AND ((team_a_id=? AND team_b_id<>?) OR (team_b_id=? AND team_a_id<>?))").all(eventId,byeId,byeId,byeId,byeId);
        for (const m of byes) { finalizeMatch(m.id, m.team_a_id === byeId ? m.team_b_id : m.team_a_id); changed = true; }
      }
      for (const id of byRound.get(1)!) matches.push(matchView(id));
      audit(
        db,
        req.organizer!,
        "bracket.create",
        "event",
        String(req.params.id),
      );
    });
    const mainMatches = (db.prepare("SELECT id FROM matches WHERE event_id=? AND path='MAIN' ORDER BY round,rowid").all(String(req.params.id)) as any[]).map((row) => matchView(row.id));
    const consolationMatches = (db.prepare("SELECT id FROM matches WHERE event_id=? AND path='CONSOLATION' ORDER BY round,rowid").all(String(req.params.id)) as any[]).map((row) => matchView(row.id));
    const playInMatches = (db.prepare("SELECT id FROM matches WHERE event_id=? AND path='PLAY_IN' ORDER BY round,rowid").all(String(req.params.id)) as any[]).map((row) => matchView(row.id));
    res.status(201).json({ matches, bracket: { mainMatches, consolationMatches, playInMatches, consolationAffectsTopFour: false } });
  });
  app.get("/api/events/:id/bracket", (req, res) => {
    const mainMatches = (db.prepare("SELECT id FROM matches WHERE event_id=? AND path='MAIN' ORDER BY round,rowid").all(String(req.params.id)) as any[]).map((row) => matchView(row.id));
    const consolationMatches = (db.prepare("SELECT id FROM matches WHERE event_id=? AND path='CONSOLATION' ORDER BY round,rowid").all(String(req.params.id)) as any[]).map((row) => matchView(row.id));
    const playInMatches = (db.prepare("SELECT id FROM matches WHERE event_id=? AND path='PLAY_IN' ORDER BY round,rowid").all(String(req.params.id)) as any[]).map((row) => matchView(row.id));
    res.json({ bracket: { mainMatches, consolationMatches, playInMatches, consolationAffectsTopFour: false } });
  });
  app.get("/api/matches/:id", (req, res) => {
    const match = matchView(String(req.params.id));
    if (!match) return fail(res, 404, "match not found");
    res.json({ match });
  });
  app.post("/api/events/:id/bracket/semifinals/start", organizer, (req: AuthedRequest, res) => {
    const eventId = String(req.params.id);
    const event: any = db.prepare("SELECT kind,late_entry_locked FROM events WHERE id=?").get(eventId);
    if (!event) return fail(res,404,"event not found","EVENT_NOT_FOUND");
    if (event.kind !== "HEAD_TO_HEAD") return fail(res,409,"event does not use semifinals","BRACKET_NOT_SUPPORTED");
    if (event.late_entry_locked) return res.json({ locked: true });
    const readiness: any = db.prepare("SELECT count(*) total,sum(CASE WHEN team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' AND status IN ('PENDING','FINAL') THEN 1 ELSE 0 END) ready FROM matches WHERE event_id=? AND path='MAIN' AND role='SEMIFINAL'").get(eventId);
    if (readiness.total !== 2 || readiness.ready !== 2) return fail(res,409,"semifinal bracket is not ready","SEMIFINALS_NOT_READY");
    tx(() => { db.prepare("UPDATE events SET late_entry_locked=1 WHERE id=? AND late_entry_locked=0").run(eventId); audit(db,req.organizer!,"bracket.semifinals.start","event",eventId); });
    res.json({ locked: true });
  });
  app.post("/api/events/:id/bracket/late-entries", organizer, (req: AuthedRequest, res) => {
    const eventId = String(req.params.id), participantId = cleanName(req.body?.participantId);
    const event: any = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
    if (!event || !participantId) return fail(res,400,"invalid late entry");
    if (event.kind !== "HEAD_TO_HEAD") return fail(res,409,"event does not use a head-to-head bracket","BRACKET_NOT_SUPPORTED");
    if (event.late_entry_locked || db.prepare("SELECT 1 FROM matches WHERE event_id=? AND path='MAIN' AND role='SEMIFINAL' AND status<>'PENDING' LIMIT 1").get(eventId))
      return fail(res,409,"championship late entry is closed","LATE_ENTRY_CLOSED");
    if (!db.prepare("SELECT 1 FROM participants WHERE id=? AND active=1").get(participantId)) return fail(res,404,"participant not found");
    if (db.prepare("SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=? AND tm.active=1").get(eventId,participantId)) return fail(res,409,"participant is already active on an event team","PARTICIPANT_ALREADY_ASSIGNED");
    const slot: any = db.prepare("SELECT * FROM matches WHERE event_id=? AND path='MAIN' AND status IN ('PENDING','FINAL') AND role<>'THIRD_PLACE' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END,round,rowid LIMIT 1").get(eventId);
    if (!slot) return fail(res,409,"no unstarted main-bracket slot is available");
    const nextSlot = "A", opponentId = slot.team_a_id;
    const teamId = randomUUID(), name = `Late ${String(participantId).slice(0,6)}`;
    tx(() => {
      db.prepare("INSERT OR IGNORE INTO event_entries(event_id,participant_id) VALUES(?,?)").run(eventId,participantId);
      db.prepare("INSERT INTO teams(id,event_id,name,name_locked) VALUES(?,?,?,1)").run(teamId,eventId,name);
      db.prepare("INSERT INTO team_members(team_id,participant_id) VALUES(?,?)").run(teamId,participantId);
      db.prepare("UPDATE matches SET team_a_id=? WHERE id=?").run(`bye:${eventId}`,slot.id);
      db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id,next_match_id,next_slot) VALUES(?,?,?,'PLAY_IN','PLAY_IN',?,?,?,?)").run(randomUUID(),eventId,Math.max(0,slot.round - 1),opponentId,teamId,slot.id,nextSlot);
      audit(db,req.organizer!,"bracket.late-entry","event",eventId,{participantId,teamId});
    });
    res.status(201).json({ team: team(teamId) });
  });
  app.post("/api/events/:id/finalize", organizer, (req: AuthedRequest, res) => {
    const eventId = String(req.params.id);
    const final: any = db.prepare("SELECT * FROM matches WHERE event_id=? AND role='FINAL' AND status='FINAL'").get(eventId);
    const third: any = db.prepare("SELECT * FROM matches WHERE event_id=? AND role='THIRD_PLACE' AND status='FINAL'").get(eventId);
    if (!final || !third) return fail(res,409,"top four are not complete");
    const results = [[final.winner_id,1],[final.winner_id === final.team_a_id ? final.team_b_id : final.team_a_id,2],[third.winner_id,3],[third.winner_id === third.team_a_id ? third.team_b_id : third.team_a_id,4]] as const;
    const alreadyComplete: any = db.prepare("SELECT completed_at FROM events WHERE id=?").get(eventId);
    if (!alreadyComplete?.completed_at) tx(() => {
      for (const [teamId,place] of results) {
        const eligible: any[] = db.prepare("SELECT participant_id FROM team_members WHERE team_id=? AND eligible_points=1").all(teamId);
        for (const member of eligible) db.prepare("INSERT OR IGNORE INTO placements(event_id,participant_id,place,points) VALUES(?,?,?,?)").run(eventId,member.participant_id,place,pointsForPlace(place));
      }
      db.prepare("UPDATE events SET completed_at=? WHERE id=?").run(now().toISOString(),eventId);
      audit(db,req.organizer!,"event.finalize","event",eventId);
    });
    res.json({ placements: db.prepare("SELECT * FROM placements WHERE event_id=? ORDER BY place,participant_id").all(eventId) });
  });
  app.post(
    ["/api/matches/:id/report", "/api/matches/:id/result-reports"],
    rateLimit("match-result-report", 40),
    participant,
    (req: AuthedRequest, res) => {
      const m: any = db
        .prepare("SELECT * FROM matches WHERE id=?")
        .get(String(req.params.id));
      const winner = req.body?.winningTeamId ?? req.body?.winnerTeamId;
      if (
        !m ||
        ![m.team_a_id, m.team_b_id].includes(winner) ||
        (!isMember(req.participant.id, m.team_a_id) &&
          !isMember(req.participant.id, m.team_b_id))
      )
        return fail(res, 403, "not a match participant");
      if (m.status !== "ACTIVE")
        return fail(res, 409, "result already pending or final");
      tx(() => {
        db.prepare(
          "UPDATE matches SET status='AWAITING_CONFIRMATION',reported_winner_id=?,reporter_id=? WHERE id=?",
        ).run(winner, req.participant.id, m.id);
        audit(db, req.participant.id, "match.report", "match", m.id, {
          winner,
        });
      });
      res.status(201).json(matchView(m.id));
    },
  );
  app.post(
    ["/api/matches/:id/confirm", "/api/matches/:id/result-confirmations"],
    participant,
    (req: AuthedRequest, res) => {
      const m: any = db
        .prepare("SELECT * FROM matches WHERE id=?")
        .get(String(req.params.id));
      if (m?.status === "FINAL" && req.body?.agree === true) return res.json(matchView(m.id));
      if (!m || m.status !== "AWAITING_CONFIRMATION") return fail(res, 409, "no result awaiting confirmation");
      const reporterTeam = isMember(m.reporter_id, m.team_a_id)
        ? m.team_a_id
        : m.team_b_id;
      const confirmerTeam = isMember(req.participant.id, m.team_a_id)
        ? m.team_a_id
        : isMember(req.participant.id, m.team_b_id)
          ? m.team_b_id
          : null;
      if (!confirmerTeam || confirmerTeam === reporterTeam)
        return fail(res, 403, "opposing team confirmation required");
      if (!req.body?.agree) {
        tx(() => {
          db.prepare("UPDATE matches SET status='DISPUTED' WHERE id=?").run(
            m.id,
          );
          db.prepare(
            "INSERT INTO disputes(id,match_id,opened_by) VALUES(?,?,?)",
          ).run(randomUUID(), m.id, req.participant.id);
          audit(db, req.participant.id, "match.dispute", "match", m.id);
        });
        return req.path.endsWith("/result-confirmations") ? res.json(matchView(m.id)) : fail(res, 409, "result disputed");
      }
      tx(() => {
        finalizeMatch(m.id, m.reported_winner_id);
        db.prepare("UPDATE teams SET name_locked=1 WHERE id IN (?,?)").run(
          m.team_a_id,
          m.team_b_id,
        );
        audit(db, req.participant.id, "match.confirm", "match", m.id, {
          winner: m.reported_winner_id,
        });
      });
      res.json(matchView(m.id));
    },
  );
  app.post(
    "/api/disputes/:id/resolve",
    organizer,
    (req: AuthedRequest, res) => {
      const d: any = db
          .prepare("SELECT * FROM disputes WHERE id=? AND resolved_at IS NULL")
          .get(String(req.params.id)),
        winner = req.body?.winningTeamId;
      if (!d) {
        const prior: any = db.prepare("SELECT d.*,m.* FROM disputes d JOIN matches m ON m.id=d.match_id WHERE d.id=?").get(String(req.params.id));
        if (prior?.status === "FINAL") return res.json(matchView(prior.match_id));
        return fail(res, 404, "dispute not found");
      }
      const m: any = db
        .prepare("SELECT * FROM matches WHERE id=?")
        .get(d.match_id);
      if (![m.team_a_id, m.team_b_id].includes(winner))
        return fail(res, 400, "invalid winner");
      tx(() => {
        finalizeMatch(m.id, winner);
        db.prepare("UPDATE disputes SET resolved_at=? WHERE id=?").run(
          now().toISOString(),
          d.id,
        );
        audit(db, req.organizer!, "dispute.resolve", "dispute", d.id, {
          winner,
        });
      });
      res.json(matchView(m.id));
    },
  );

  app.get("/api/stations", (_req, res) =>
    res.json({
      stations: db
        .prepare("SELECT id,name,event_id AS eventId,available FROM stations ORDER BY rowid")
        .all(),
    }),
  );
  app.post("/api/stations", organizer, (req: AuthedRequest, res) => {
    const name = cleanName(req.body?.name), eventId = cleanName(req.body?.eventId);
    const stationEvent: any = eventId ? db.prepare("SELECT play_mode AS playMode FROM events WHERE id=?").get(eventId) : null;
    if (!name || !stationEvent || stationEvent.playMode !== "OFFICIAL") return fail(res, 400, "station requires an official scored event", "INVALID_STATION");
    const id = randomUUID();
    tx(() => {
      db.prepare("INSERT INTO stations(id,name,event_id) VALUES(?,?,?)").run(id, name, eventId);
      audit(db, req.organizer!, "station.create", "station", id, { eventId });
    });
    res.status(201).json({ id, name, eventId });
  });
  app.post(
    ["/api/stations/:id/call-next", "/api/schedule/call-next"],
    organizer,
    (req: AuthedRequest, res) => {
      const stationId = String(req.params.id ?? req.body?.stationId ?? "");
      const requestedNow = req.body?.now ? new Date(req.body.now) : now();
      if (!stationId || Number.isNaN(requestedNow.getTime())) return fail(res, 400, "invalid station or time", "INVALID_SCHEDULE_CALL");
      const station: any = db
        .prepare("SELECT * FROM stations WHERE id=? AND available=1")
        .get(stationId);
      if (!station) return fail(res, 404, "station unavailable");
      const requestedParticipants: string[] | null = Array.isArray(req.body?.participantIds) ? req.body.participantIds : null;
      if (requestedParticipants?.length) {
        const cooling = requestedParticipants.some(id => {
          const row: any = db.prepare("SELECT max(completed_at) t FROM matches x JOIN team_members tm ON tm.team_id IN(x.team_a_id,x.team_b_id) WHERE x.status='FINAL' AND tm.participant_id=?").get(id);
          return row?.t && requestedNow.getTime() - new Date(row.t).getTime() < 300000;
        });
        if (cooling && !req.body?.overrideCooldown) return res.json({ match: null, eligible: false });
      }
      if (db.prepare("SELECT 1 FROM matches WHERE station_id=? AND status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED')").get(station.id))
        return fail(res,409,"station occupied","STATION_OCCUPIED");
      const candidates: any[] = db
        .prepare(
          "SELECT * FROM matches WHERE event_id=? AND status IN ('PENDING','SKIPPED') ORDER BY CASE status WHEN 'SKIPPED' THEN 1 ELSE 0 END,round,rowid",
        )
        .all(station.event_id);
      let chosen: any;
      for (const m of candidates) {
        if (m.team_a_id === m.team_b_id || m.team_a_id.startsWith("bye:") || m.team_b_id.startsWith("bye:")) continue;
        const roster = (teamId: string) => db.prepare("SELECT participant_id id FROM team_members WHERE team_id=? AND active=1").all(teamId) as any[];
        const teamA = roster(m.team_a_id), teamB = roster(m.team_b_id);
        if (!teamA.length || !teamB.length) continue;
        const pids = [...teamA,...teamB].map((p) => p.id);
        const inactive = pids.some((id) => !db.prepare("SELECT 1 FROM participants WHERE id=? AND active=1").get(id));
        const busy = pids.some((id) =>
          db
            .prepare(
              "SELECT 1 FROM matches x JOIN team_members a ON a.team_id IN(x.team_a_id,x.team_b_id) WHERE x.status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') AND a.active=1 AND a.participant_id=?",
            )
            .get(id),
        );
        const cooling = pids.some((id) => {
          const r: any = db
            .prepare(
              "SELECT max(completed_at) t FROM matches x JOIN team_members a ON a.team_id IN(x.team_a_id,x.team_b_id) WHERE x.status='FINAL' AND a.participant_id=?",
            )
            .get(id);
          return r?.t && requestedNow.getTime() - new Date(r.t).getTime() < 300000;
        });
        if (!inactive && !busy && (!cooling || req.body?.overrideCooldown)) {
          chosen = m;
          break;
        }
      }
      if (!chosen) return res.json({ match: null });
      tx(() => {
        db.prepare(
          "UPDATE matches SET status='CALLED',station_id=?,called_at=? WHERE id=?",
        ).run(station.id, requestedNow.toISOString(), chosen.id);
        audit(db, req.organizer!, "match.call", "match", chosen.id, {
          stationId: station.id,
        });
      });
      res.json({
        match: matchView(chosen.id),
        reportBy: new Date(requestedNow.getTime() + 300000).toISOString(),
      });
    },
  );
  app.post(
    "/api/matches/:id/check-in",
    participant,
    (req: AuthedRequest, res) => {
      const m: any = db
        .prepare("SELECT * FROM matches WHERE id=?")
        .get(String(req.params.id));
      const teamId =
        m &&
        (isMember(req.participant.id, m.team_a_id)
          ? m.team_a_id
          : isMember(req.participant.id, m.team_b_id)
            ? m.team_b_id
            : null);
      if (!m || !teamId) return fail(res, 403, "not a match participant");
      if (m.status !== "CALLED") {
        const prior = db.prepare("SELECT 1 FROM checkins WHERE match_id=? AND team_id=?").get(m.id, teamId);
        if (m.status === "ACTIVE" && prior) return res.json(matchView(m.id));
        return fail(res, 409, "check-in requires a called match", "MATCH_NOT_CALLED");
      }
      if (!m.called_at || now().getTime() >= new Date(m.called_at).getTime() + 300_000)
        return fail(res, 409, "call window expired; organizer must requeue this match", "CALL_EXPIRED");
      tx(() => {
        const inserted = db.prepare(
          "INSERT OR IGNORE INTO checkins(match_id,team_id,participant_id) VALUES(?,?,?)",
        ).run(m.id, teamId, req.participant.id);
        const count = (
          db
            .prepare("SELECT count(*) n FROM checkins WHERE match_id=?")
            .get(m.id) as any
        ).n;
        if (count === 2)
          {
            db.prepare("UPDATE matches SET status='ACTIVE',started_at=? WHERE id=?").run(now().toISOString(), m.id);
            db.prepare("UPDATE teams SET name_locked=1 WHERE id IN (?,?)").run(m.team_a_id,m.team_b_id);
          }
        if (inserted.changes) audit(db, req.participant.id, "match.checkin", "match", m.id, {
          teamId,
        });
      });
      res.json(matchView(m.id));
    },
  );
  app.post("/api/matches/:id/complete", organizer, (req: AuthedRequest, res) => {
    const m: any = db.prepare("SELECT * FROM matches WHERE id=?").get(String(req.params.id));
    const winner = req.body?.winningTeamId ?? req.body?.winnerTeamId;
    const completedAt = req.body?.completedAt ? new Date(req.body.completedAt) : now();
    if (!m || ![m.team_a_id, m.team_b_id].includes(winner) || Number.isNaN(completedAt.getTime())) return fail(res, 400, "invalid completion", "INVALID_MATCH_COMPLETION");
    if (m.status === "FINAL") {
      if (m.winner_id !== winner || m.completed_at !== completedAt.toISOString()) return fail(res,409,"final match completion conflicts with recorded result","MATCH_FINAL_CONFLICT");
      return res.json({ match: matchView(m.id) });
    }
    tx(() => {
      finalizeMatch(m.id, winner);
      db.prepare("UPDATE matches SET completed_at=? WHERE id=?").run(completedAt.toISOString(), m.id);
      audit(db, req.organizer!, "match.complete", "match", m.id, { winner });
    });
    res.json({ match: matchView(m.id) });
  });
  app.post("/api/schedule/tick", organizer, (req: AuthedRequest, res) => {
    const at = req.body?.now ? new Date(req.body.now) : now();
    if (Number.isNaN(at.getTime())) return fail(res, 400, "invalid tick time", "INVALID_SCHEDULE_TICK");
    const due: any[] = db.prepare("SELECT id FROM matches WHERE status='CALLED' AND called_at<=?").all(new Date(at.getTime() - 300000).toISOString()) as any[];
    tx(() => { for (const row of due) { db.prepare("UPDATE matches SET status='SKIPPED',station_id=NULL WHERE id=?").run(row.id); audit(db, req.organizer!, "match.skip", "match", row.id); } });
    res.json({ skipped: due.map((row) => row.id) });
  });
  app.post("/api/matches/:id/timeout", organizer, (req: AuthedRequest, res) => {
    const m: any = db
      .prepare("SELECT * FROM matches WHERE id=?")
      .get(String(req.params.id));
    if (!m || m.status !== "CALLED")
      return fail(res, 409, "match is not called");
    if (!m.called_at || now().getTime() - new Date(m.called_at).getTime() < 300000)
      return fail(res, 409, "five-minute report window remains", "TIMEOUT_NOT_DUE");
    tx(() => {
      db.prepare(
        "UPDATE matches SET status='SKIPPED',station_id=NULL WHERE id=?",
      ).run(m.id);
      audit(db, req.organizer!, "match.skip", "match", m.id);
    });
    res.json(matchView(m.id));
  });
  app.post("/api/matches/:id/forfeit", organizer, (req: AuthedRequest, res) => {
    const m: any = db
        .prepare("SELECT * FROM matches WHERE id=?")
        .get(String(req.params.id)),
      winner = req.body?.winningTeamId;
    if (!m || ![m.team_a_id, m.team_b_id].includes(winner))
      return fail(res, 400, "invalid forfeit");
    if (m.status === "FINAL") return fail(res, 409, "match is already final", "MATCH_FINAL");
    tx(() => {
      finalizeMatch(m.id, winner);
      audit(db, req.organizer!, "match.forfeit", "match", m.id, { winner });
    });
    res.json(matchView(m.id));
  });
  app.post(
    ["/api/events/:id/substitutions", "/api/matches/:matchId/substitutions/auto"],
    organizer,
    (req: AuthedRequest, res) => {
      const automaticMatchId = req.params.matchId;
      const automaticMatch: any = automaticMatchId
        ? db.prepare("SELECT event_id,team_a_id,team_b_id FROM matches WHERE id=?").get(automaticMatchId)
        : undefined;
      if (automaticMatchId && !automaticMatch)
        return fail(res, 404, "match not found");
      const eventId = automaticMatch?.event_id ?? String(req.params.id);
      const automaticLeaver: any = automaticMatch
        ? db.prepare(
            "SELECT tm.participant_id FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE tm.team_id IN (?,?) AND tm.active=1 AND p.active=0 ORDER BY tm.rowid LIMIT 1",
          ).get(automaticMatch.team_a_id,automaticMatch.team_b_id)
        : undefined;
      const leaving = req.body?.leavingParticipantId ?? automaticLeaver?.participant_id;
      if (!leaving)
        return fail(res, 409, "no departed teammate needs substitution", "NO_SUBSTITUTION_NEEDED");
      const current: any = db
        .prepare(
          automaticMatch
            ? "SELECT tm.team_id FROM team_members tm WHERE tm.team_id IN (?,?) AND tm.participant_id=? AND tm.active=1"
            : "SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=? AND tm.active=1",
        )
        .get(...(automaticMatch ? [automaticMatch.team_a_id, automaticMatch.team_b_id, leaving] : [eventId, leaving]));
      if (!current) return fail(res, 409, "leaving team membership is no longer active", "SUBSTITUTION_ALREADY_APPLIED");
      const requestedReplacement = cleanName(req.body?.replacementParticipantId);
      const replacement: any = requestedReplacement
        ? db.prepare("SELECT p.id FROM participants p WHERE p.id=? AND p.active=1 AND NOT EXISTS(SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=p.id AND tm.active=1)").get(requestedReplacement,eventId)
        : db
            .prepare(
              "SELECT p.id FROM participants p WHERE p.active=1 AND p.id<>? AND NOT EXISTS(SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=p.id AND tm.active=1) ORDER BY EXISTS(SELECT 1 FROM placements pl WHERE pl.event_id=? AND pl.participant_id=p.id),p.created_at LIMIT 1",
            )
            .get(leaving, eventId, eventId) ??
          undefined;
      if (!replacement) return fail(res, 409, "no substitute available");
      const id = randomUUID();
      tx(() => {
        db.prepare(
          "UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?",
        ).run(current.team_id, leaving);
        db.prepare(
          "INSERT INTO team_members(team_id,participant_id,substitute,eligible_points,active) VALUES(?,?,1,?,1) ON CONFLICT(team_id,participant_id) DO UPDATE SET substitute=1,eligible_points=excluded.eligible_points,active=1",
        ).run(
          current.team_id,
          replacement.id,
          db
            .prepare(
              "SELECT 1 FROM placements WHERE event_id=? AND participant_id=?",
            )
            .get(eventId, replacement.id)
            ? 0
            : 1,
        );
        db.prepare(
          "INSERT INTO substitutions(id,event_id,team_id,leaving_id,replacement_id) VALUES(?,?,?,?,?)",
        ).run(
          id,
          eventId,
          current.team_id,
          leaving,
          replacement.id,
        );
        audit(db, req.organizer!, "substitution.create", "substitution", id, {
          leaving,
          replacement: replacement.id,
        });
      });
      const substitution = {
        id,
        teamId: current.team_id,
        leavingParticipantId: leaving,
        outParticipantId: leaving,
        substituteId: replacement.id,
        inParticipantId: replacement.id,
        reversible: true,
        public: true,
      };
      res.status(201).json({ ...substitution, substitution });
    },
  );
  app.post("/api/substitutions/:id/reverse", organizer, (req: AuthedRequest, res) => {
    const sub: any = db.prepare("SELECT * FROM substitutions WHERE id=? AND reversed=0").get(String(req.params.id));
    if (!sub) return fail(res,404,"substitution not found");
    const played = db.prepare("SELECT 1 FROM matches WHERE started_at>? AND (team_a_id=? OR team_b_id=?)").get(sub.created_at,sub.team_id,sub.team_id);
    if (played) return fail(res,409,"substitution is locked by next match");
    tx(() => {
      db.prepare("UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?").run(sub.team_id,sub.replacement_id);
      db.prepare("UPDATE team_members SET active=1 WHERE team_id=? AND participant_id=?").run(sub.team_id,sub.leaving_id);
      db.prepare("UPDATE substitutions SET reversed=1,reversed_at=? WHERE id=?").run(now().toISOString(),sub.id);
      audit(db,req.organizer!,"substitution.reverse","substitution",sub.id);
    });
    res.json({ id: sub.id, reversed: true });
  });

  /* Event-day Control Yard mutations intentionally expose domain verbs rather
     than table/status editing.  Validation happens before the backup; the
     mutation, attributed audit row and replay record commit atomically. */
  const stableJson = (value: any): string => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const controlSnapshot = (entityType: string, entityId: string) => {
    if (entityType === "participant") return {
      participants: db.prepare("SELECT * FROM participants WHERE id=?").all(entityId),
      eventEntries: db.prepare("SELECT * FROM event_entries WHERE participant_id=? ORDER BY event_id").all(entityId),
      teamMembers: db.prepare("SELECT * FROM team_members WHERE participant_id=? ORDER BY team_id").all(entityId),
    };
    if (entityType === "team") {
      const selected: any = db.prepare("SELECT event_id FROM teams WHERE id=?").get(entityId);
      return selected ? {
        teams: db.prepare("SELECT * FROM teams WHERE event_id=? ORDER BY rowid").all(selected.event_id),
        teamMembers: db.prepare("SELECT tm.* FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? ORDER BY tm.team_id,tm.participant_id").all(selected.event_id),
      } : { teams: [], teamMembers: [] };
    }
    if (entityType === "match") {
      const selected: any = db.prepare("SELECT event_id FROM matches WHERE id=?").get(entityId);
      return selected ? {
        events: db.prepare("SELECT * FROM events WHERE id=?").all(selected.event_id),
        matches: db.prepare("SELECT * FROM matches WHERE event_id=? ORDER BY rowid").all(selected.event_id),
        placements: db.prepare("SELECT * FROM placements WHERE event_id=? ORDER BY place,participant_id").all(selected.event_id),
        checkins: db.prepare("SELECT c.* FROM checkins c JOIN matches m ON m.id=c.match_id WHERE m.event_id=? ORDER BY c.match_id,c.team_id").all(selected.event_id),
        disputes: db.prepare("SELECT d.* FROM disputes d JOIN matches m ON m.id=d.match_id WHERE m.event_id=? ORDER BY d.rowid").all(selected.event_id),
      } : { matches: [] };
    }
    if (entityType === "station") return {
      stations: db.prepare("SELECT * FROM stations ORDER BY id").all(),
      matches: db.prepare("SELECT * FROM matches WHERE station_id IS NOT NULL ORDER BY rowid").all(),
    };
    return {
      events: db.prepare("SELECT * FROM events WHERE id=?").all(entityId),
      teams: db.prepare("SELECT * FROM teams WHERE event_id=? ORDER BY rowid").all(entityId),
      teamMembers: db.prepare("SELECT tm.* FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? ORDER BY tm.team_id,tm.participant_id").all(entityId),
      matches: db.prepare("SELECT * FROM matches WHERE event_id=? ORDER BY rowid").all(entityId),
      placements: db.prepare("SELECT * FROM placements WHERE event_id=? ORDER BY place,participant_id").all(entityId),
    };
  };
  const controlSafety = (req: AuthedRequest, res: Response, scope: string) => {
    if (req.body?.confirm !== true)
      return { error: fail(res, 400, "Explicit confirmation is required", "CONTROL_CONFIRMATION_REQUIRED") };
    const reason = cleanName(req.body?.reason, 500);
    if (!reason)
      return { error: fail(res, 400, "A reason is required", "CONTROL_REASON_REQUIRED") };
    const key = cleanName(req.body?.idempotencyKey, 200);
    if (!key)
      return { error: fail(res, 400, "An idempotency key is required", "IDEMPOTENCY_KEY_REQUIRED") };
    const payload = { ...req.body }; delete payload.idempotencyKey;
    const requestHash = createHash("sha256").update(stableJson(payload)).digest("hex");
    const actor = req.organizer!;
    const prior: any = db.prepare("SELECT scope,actor,request_hash,response_json FROM idempotency_keys WHERE key=? AND scope LIKE 'control:%'").get(key);
    if (prior && (prior.scope !== scope || prior.actor !== actor || prior.request_hash !== requestHash))
      return { error: fail(res, 409, "Idempotency key was already used for a different organizer or mutation", "IDEMPOTENCY_KEY_CONFLICT") };
    if (prior) return { prior: JSON.parse(prior.response_json), reason, key, actor, requestHash };
    return { reason, key, actor, requestHash };
  };
  // Two organizers are plenty; one mutation queue makes every backup and
  // before-snapshot truly immediate. Boring serialization beats clever races.
  let controlMutationTail: Promise<unknown> = Promise.resolve();
  const controlCommit = async <T extends object>(
    req: AuthedRequest,
    scope: string,
    action: string,
    entityType: string,
    entityId: string,
    safety: { reason: string; key: string; actor: string; requestHash: string },
    mutate: () => T,
  ) => {
    const task = controlMutationTail.catch(() => undefined).then(async () => {
      const replay: any = db.prepare("SELECT scope,actor,request_hash,response_json FROM idempotency_keys WHERE key=? AND scope LIKE 'control:%'").get(safety.key);
      if (replay) {
        if (replay.scope !== scope || replay.actor !== safety.actor || replay.request_hash !== safety.requestHash)
          throw Object.assign(new Error("Idempotency key conflict"), { code: "IDEMPOTENCY_KEY_CONFLICT" });
        return JSON.parse(replay.response_json);
      }
      const before = controlSnapshot(entityType, entityId);
      const backupId = randomUUID();
      const root = path.resolve(process.env.DATA_DIR ?? "/tmp/junkyard-olympics");
      const destination = path.join(root, "backups", `${backupId}.sqlite`);
      await backupDatabase(db, destination);
      return tx(() => {
        const result = mutate();
        const response = { ...result, backupId };
        const after = controlSnapshot(entityType, entityId);
        db.prepare("INSERT INTO backups(id,path) VALUES(?,?)").run(backupId, destination);
        audit(db, req.organizer!, "backup.create", "backup", backupId, { reason: action, entityId });
        audit(db, req.organizer!, action, entityType, entityId, { reason: safety.reason, backupId, idempotencyKey: safety.key, requestHash: safety.requestHash, before, after });
        db.prepare("INSERT INTO idempotency_keys(scope,key,response_json,actor,request_hash) VALUES(?,?,?,?,?)").run(scope, safety.key, JSON.stringify(response), safety.actor, safety.requestHash);
        return response;
      });
    });
    controlMutationTail = task.then(() => undefined, () => undefined);
    return await task;
  };
  const lineupBlock = (teamId: string) => {
    const called = db.prepare("SELECT id FROM matches WHERE (team_a_id=? OR team_b_id=?) AND status='CALLED' LIMIT 1").get(teamId, teamId);
    if (called) return { status: 409, message: "Requeue this match before editing its lineup", code: "LINEUP_REQUEUE_REQUIRED" };
    const live = db.prepare("SELECT id,status FROM matches WHERE (team_a_id=? OR team_b_id=?) AND status IN ('ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(teamId, teamId) as any;
    if (live) return { status: 409, message: `Lineup is locked while match ${live.id} is ${live.status}`, code: "LINEUP_LIVE_LOCKED" };
    return null;
  };

  app.patch("/api/organizer/participants/:id", organizer, async (req: AuthedRequest, res, next) => {
    try {
      const id = String(req.params.id), scope = `control:participant:${id}`;
      const safety: any = controlSafety(req, res, scope); if (safety.error) return; if (safety.prior) return res.json(safety.prior);
      const current: any = db.prepare("SELECT * FROM participants WHERE id=?").get(id);
      if (!current) return fail(res, 404, "Participant not found", "PARTICIPANT_NOT_FOUND");
      const displayName = Object.hasOwn(req.body, "displayName") ? cleanName(req.body.displayName) : current.display_name;
      const active = Object.hasOwn(req.body, "active") ? req.body.active : !!current.active;
      const eventIds = Object.hasOwn(req.body, "eventIds") ? req.body.eventIds : (db.prepare("SELECT event_id id FROM event_entries WHERE participant_id=?").all(id) as any[]).map(row => row.id);
      if (!displayName || typeof active !== "boolean" || !Array.isArray(eventIds) || eventIds.some((x: unknown) => typeof x !== "string") || new Set(eventIds).size !== eventIds.length)
        return fail(res, 400, "Invalid participant edit", "INVALID_PARTICIPANT");
      const valid = eventIds.length ? (db.prepare(`SELECT count(*) n FROM events WHERE id IN (${eventIds.map(() => "?").join(",")})`).get(...eventIds) as any).n : 0;
      if (valid !== eventIds.length) return fail(res, 400, "One or more activities do not exist", "INVALID_EVENT_SELECTION");
      if (active) {
        const teamEvents = (db.prepare("SELECT DISTINCT t.event_id id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.participant_id=? AND tm.active=1").all(id) as any[]).map(row => row.id);
        if (teamEvents.some(eventId => !eventIds.includes(eventId)))
          return fail(res, 409, "Remove or move this participant from the team before deselecting its activity", "ACTIVE_TEAM_EVENT_REQUIRED");
      }
      if (!active && db.prepare("SELECT 1 FROM matches m JOIN team_members tm ON tm.team_id IN(m.team_a_id,m.team_b_id) WHERE tm.participant_id=? AND tm.active=1 AND m.status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(id))
        return fail(res, 409, "Participant is in a live match; requeue or resolve it before deactivation", "PARTICIPANT_IN_LIVE_MATCH");
      if (!active && db.prepare(`SELECT 1 FROM team_members mine JOIN teams t ON t.id=mine.team_id JOIN events e ON e.id=t.event_id
        WHERE mine.participant_id=? AND mine.active=1 AND e.play_mode<>'CASUAL'
        AND (SELECT count(*) FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE tm.team_id=t.id AND tm.active=1 AND p.active=1)<=2 LIMIT 1`).get(id))
        return fail(res, 409, "Move or substitute this participant before deactivation so every official team keeps two active players", "PLAYABLE_ROSTER_REQUIRED");
      const response = await controlCommit(req, scope, "control.participant.update", "participant", id, safety, () => {
        db.prepare("UPDATE participants SET display_name=?,active=? WHERE id=?").run(displayName, Number(active), id);
        db.prepare("DELETE FROM event_entries WHERE participant_id=?").run(id);
        for (const eventId of eventIds) db.prepare("INSERT INTO event_entries(event_id,participant_id) VALUES(?,?)").run(eventId, id);
        if (!active) db.prepare("UPDATE team_members SET active=0 WHERE participant_id=? AND active=1").run(id);
        return { participant: { id, displayName, active: Number(active), eventIds } };
      });
      res.json(response);
    } catch (error) { next(error); }
  });

  app.post("/api/organizer/teams/:id/rename", organizer, async (req: AuthedRequest, res, next) => {
    try {
      const id = String(req.params.id), scope = `control:team-rename:${id}`, name = cleanName(req.body?.name, 40);
      const safety: any = controlSafety(req, res, scope); if (safety.error) return; if (safety.prior) return res.json(safety.prior);
      const selected: any = db.prepare("SELECT * FROM teams WHERE id=?").get(id);
      if (!selected || !name) return fail(res, 400, "Valid team and name are required", "INVALID_TEAM_RENAME");
      const blocked = lineupBlock(id); if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
      const response = await controlCommit(req, scope, "control.team.rename", "team", id, safety, () => {
        db.prepare("UPDATE teams SET name=?,renamed=1 WHERE id=?").run(name, id);
        return { team: team(id) };
      });
      res.json(response);
    } catch (error: any) { if (error.code?.startsWith("SQLITE_CONSTRAINT")) return fail(res, 409, "That team name is already used in this activity", "TEAM_NAME_CONFLICT"); next(error); }
  });

  app.post("/api/organizer/teams/:id/lineup", organizer, async (req: AuthedRequest, res, next) => {
    try {
      const id = String(req.params.id), operation = req.body?.operation, scope = `control:lineup:${id}`;
      const safety: any = controlSafety(req, res, scope); if (safety.error) return; if (safety.prior) return res.json(safety.prior);
      const selected: any = db.prepare("SELECT * FROM teams WHERE id=?").get(id);
      if (!selected || !["ADD","REMOVE","MOVE","SWAP"].includes(operation)) return fail(res, 400, "Invalid lineup operation", "INVALID_LINEUP_OPERATION");
      const blocked = lineupBlock(id); if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
      if (selected.event_id === "cannon" && db.prepare("SELECT 1 FROM cannon_run_assignments WHERE team_id=?").get(id))
        return fail(res, 409, "Cannon run is confirmed; use the audited substitution action so original shot quotas remain frozen", "CANNON_SUBSTITUTION_REQUIRED");
      const participantId = cleanName(req.body?.participantId), otherParticipantId = cleanName(req.body?.otherParticipantId), toTeamId = cleanName(req.body?.toTeamId);
      if (!participantId || !db.prepare("SELECT 1 FROM participants WHERE id=? AND active=1").get(participantId)) return fail(res, 404, "Active participant not found", "PARTICIPANT_NOT_FOUND");
      if (!db.prepare("SELECT 1 FROM event_entries WHERE event_id=? AND participant_id=?").get(selected.event_id, participantId))
        return fail(res, 409, "Enroll this participant in the activity before changing its lineup", "EVENT_ENROLLMENT_REQUIRED");
      const currentMembership: any = db.prepare("SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=? AND tm.active=1").get(selected.event_id, participantId);
      const targetId = operation === "MOVE" ? toTeamId : id;
      const target: any = targetId ? db.prepare("SELECT * FROM teams WHERE id=? AND event_id=?").get(targetId, selected.event_id) : null;
      if ((operation === "ADD" && currentMembership) || (operation === "MOVE" && (!currentMembership || currentMembership.team_id !== id || !target)))
        return fail(res, 409, "Participant is already active on a team in this activity", "PARTICIPANT_ALREADY_ASSIGNED");
      if (["REMOVE","MOVE","SWAP"].includes(operation) && currentMembership?.team_id !== id)
        return fail(res, 409, "Participant is not active on the selected team", "PARTICIPANT_NOT_ON_TEAM");
      if (operation === "MOVE") {
        const targetBlock = lineupBlock(targetId!);
        if (targetBlock) return fail(res, targetBlock.status, targetBlock.message, targetBlock.code);
      }
      let otherMembership: any;
      if (operation === "SWAP") {
        if (!otherParticipantId) return fail(res, 400, "Swap requires two participants", "INVALID_LINEUP_OPERATION");
        if (!db.prepare("SELECT 1 FROM event_entries WHERE event_id=? AND participant_id=?").get(selected.event_id, otherParticipantId))
          return fail(res, 409, "Enroll both participants in the activity before swapping lineups", "EVENT_ENROLLMENT_REQUIRED");
        otherMembership = db.prepare("SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=? AND tm.active=1").get(selected.event_id, otherParticipantId);
        if (!otherMembership || otherMembership.team_id === id) return fail(res, 409, "Swap participant must be active on another team in this activity", "INVALID_LINEUP_OPERATION");
        const otherBlock = lineupBlock(otherMembership.team_id); if (otherBlock) return fail(res, otherBlock.status, otherBlock.message, otherBlock.code);
      }
      const rosterCount = (teamId: string) => (db.prepare("SELECT count(*) n FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE tm.team_id=? AND tm.active=1 AND p.active=1").get(teamId) as any).n;
      if (["REMOVE","MOVE"].includes(operation) && rosterCount(id) <= 2)
        return fail(res, 409, "Scored official teams must retain at least two active players", "PLAYABLE_ROSTER_REQUIRED");
      const response = await controlCommit(req, scope, `control.team.${operation.toLowerCase()}`, "team", id, safety, () => {
        const activate = (teamId: string, personId: string, substitute = 0) => db.prepare("INSERT INTO team_members(team_id,participant_id,substitute,active) VALUES(?,?,?,1) ON CONFLICT(team_id,participant_id) DO UPDATE SET active=1,substitute=excluded.substitute").run(teamId, personId, substitute);
        if (operation === "ADD") activate(id, participantId!);
        if (operation === "REMOVE") db.prepare("UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?").run(id, participantId);
        if (operation === "MOVE") { db.prepare("UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?").run(id, participantId); activate(targetId!, participantId!); }
        if (operation === "SWAP") {
          db.prepare("UPDATE team_members SET active=0 WHERE (team_id=? AND participant_id=?) OR (team_id=? AND participant_id=?)").run(id, participantId, otherMembership.team_id, otherParticipantId);
          activate(id, otherParticipantId!); activate(otherMembership.team_id, participantId!);
        }
        return { team: team(id), affectedTeam: operation === "MOVE" ? team(targetId!) : operation === "SWAP" ? team(otherMembership.team_id) : null };
      });
      res.json(response);
    } catch (error: any) { if (String(error.message).includes("already active on an event team")) return fail(res, 409, "Participant is already active on a team in this activity", "PARTICIPANT_ALREADY_ASSIGNED"); next(error); }
  });

  app.post("/api/organizer/teams/:id/substitute", organizer, async (req: AuthedRequest, res, next) => {
    try {
      const teamId = String(req.params.id), leaving = cleanName(req.body?.leavingParticipantId), replacement = cleanName(req.body?.replacementParticipantId);
      const scope = `control:team-substitute:${teamId}`, safety: any = controlSafety(req, res, scope);
      if (safety.error) return; if (safety.prior) return res.json(safety.prior);
      const selected: any = db.prepare("SELECT * FROM teams WHERE id=?").get(teamId);
      if (!selected || !leaving || !replacement) return fail(res, 400, "Team, leaving participant, and substitute are required", "INVALID_SUBSTITUTION");
      const blocked = lineupBlock(teamId); if (blocked) return fail(res, blocked.status, blocked.message, blocked.code);
      if (!db.prepare("SELECT 1 FROM team_members WHERE team_id=? AND participant_id=? AND active=1").get(teamId, leaving))
        return fail(res, 409, "Leaving team membership is no longer active", "SUBSTITUTION_ALREADY_APPLIED");
      if (!db.prepare("SELECT 1 FROM participants WHERE id=? AND active=1").get(replacement))
        return fail(res, 404, "Active substitute not found", "PARTICIPANT_NOT_FOUND");
      if (!db.prepare("SELECT 1 FROM event_entries WHERE event_id=? AND participant_id=?").get(selected.event_id, replacement))
        return fail(res, 409, "Enroll the substitute in this activity before changing the lineup", "EVENT_ENROLLMENT_REQUIRED");
      if (db.prepare("SELECT 1 FROM substitutions WHERE team_id=? AND reversed=0 AND (leaving_id=? OR replacement_id=?) LIMIT 1").get(teamId, replacement, replacement))
        return fail(res, 409, "That participant is already in this team's active substitution chain; reverse the chain instead of creating a cycle", "SUBSTITUTION_CYCLE");
      if (db.prepare("SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id=? AND tm.participant_id=? AND tm.active=1").get(selected.event_id, replacement))
        return fail(res, 409, "Substitute is already active on a team in this activity", "PARTICIPANT_ALREADY_ASSIGNED");
      const substitutionId = randomUUID();
      const response = await controlCommit(req, scope, "control.team.substitute", "team", teamId, safety, () => {
        db.prepare("UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?").run(teamId, leaving);
        const eligible = db.prepare("SELECT 1 FROM placements WHERE event_id=? AND participant_id=?").get(selected.event_id, replacement) ? 0 : 1;
        db.prepare("INSERT INTO team_members(team_id,participant_id,substitute,eligible_points,active) VALUES(?,?,1,?,1) ON CONFLICT(team_id,participant_id) DO UPDATE SET substitute=1,eligible_points=excluded.eligible_points,active=1").run(teamId, replacement, eligible);
        db.prepare("INSERT INTO substitutions(id,event_id,team_id,leaving_id,replacement_id) VALUES(?,?,?,?,?)").run(substitutionId, selected.event_id, teamId, leaving, replacement);
        return { substitution: { id: substitutionId, teamId, leavingParticipantId: leaving, replacementParticipantId: replacement, originalQuotasPreserved: selected.event_id === "cannon" } };
      });
      res.status(201).json(response);
    } catch (error) { next(error); }
  });

  app.post("/api/organizer/matches/:id/requeue", organizer, async (req: AuthedRequest, res, next) => {
    try {
      const id = String(req.params.id), scope = `control:match-requeue:${id}`, safety: any = controlSafety(req,res,scope); if(safety.error)return;if(safety.prior)return res.json(safety.prior);
      const m:any=db.prepare("SELECT * FROM matches WHERE id=?").get(id); if(!m)return fail(res,404,"Match not found","MATCH_NOT_FOUND");
      if(m.status==="PENDING"&&!m.station_id)return res.json({match:matchView(id),alreadyRequeued:true});
      if(m.status!=="CALLED")return fail(res,409,"Only a called match can be requeued","MATCH_NOT_CALLED");
      const response=await controlCommit(req,scope,"control.match.requeue","match",id,safety,()=>{db.prepare("DELETE FROM checkins WHERE match_id=?").run(id);db.prepare("UPDATE matches SET status='PENDING',station_id=NULL,called_at=NULL WHERE id=?").run(id);return{match:matchView(id)};});res.json(response);
    }catch(error){next(error);}
  });
  app.post("/api/organizer/matches/:id/cancel", organizer, async (req: AuthedRequest,res,next)=>{try{
    const id=String(req.params.id),scope=`control:match-cancel:${id}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);const m:any=db.prepare("SELECT * FROM matches WHERE id=?").get(id);if(!m)return fail(res,404,"Match not found","MATCH_NOT_FOUND");if(m.status==="CANCELLED")return res.json({match:matchView(id),alreadyCancelled:true});const linked=m.role!=="ADMINISTRATIVE"||m.next_match_id||m.loser_match_id||db.prepare("SELECT 1 FROM matches WHERE next_match_id=? OR loser_match_id=? LIMIT 1").get(id,id);if(linked)return fail(res,409,"Bracket matches cannot be cancelled; requeue or use the explicit forfeit workflow","MATCH_CANCEL_BRACKET_UNSAFE");if(!["PENDING","CALLED","SKIPPED"].includes(m.status))return fail(res,409,"Only a pending or called match can be cancelled","MATCH_CANCEL_LOCKED");const response=await controlCommit(req,scope,"control.match.cancel","match",id,safety,()=>{db.prepare("DELETE FROM checkins WHERE match_id=?").run(id);db.prepare("UPDATE matches SET status='CANCELLED',station_id=NULL,called_at=NULL WHERE id=?").run(id);return{match:matchView(id)};});res.json(response);
  }catch(error){next(error);}});
  app.post("/api/organizer/matches/:id/assign-station", organizer, async(req:AuthedRequest,res,next)=>{try{
    const id=String(req.params.id),stationId=cleanName(req.body?.stationId),scope=`control:match-station:${id}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);const m:any=db.prepare("SELECT * FROM matches WHERE id=?").get(id),station:any=stationId?db.prepare("SELECT * FROM stations WHERE id=?").get(stationId):null;if(!m||!station)return fail(res,404,"Match or station not found","MATCH_OR_STATION_NOT_FOUND");if(station.event_id!==m.event_id)return fail(res,409,"This station is bound to a different activity","STATION_EVENT_MISMATCH");if(!station.available)return fail(res,409,"Open this station before assigning a match","STATION_CLOSED");if(!["PENDING","SKIPPED"].includes(m.status))return fail(res,409,"Requeue this match before changing its station","MATCH_ASSIGNMENT_LOCKED");if(db.prepare("SELECT 1 FROM matches WHERE station_id=? AND id<>? AND status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(stationId,id))return fail(res,409,"This station already has a live match; requeue it before assigning another","STATION_OCCUPIED");const response=await controlCommit(req,scope,"control.match.assign-station","match",id,safety,()=>{if(db.prepare("SELECT 1 FROM matches WHERE station_id=? AND id<>? AND status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(stationId,id))throw Object.assign(new Error("station occupied"),{code:"STATION_OCCUPIED"});db.prepare("UPDATE matches SET station_id=? WHERE id=?").run(stationId,id);return{match:matchView(id)};});res.json(response);
  }catch(error:any){if(error.code==="STATION_OCCUPIED")return fail(res,409,"This station already has a live match; requeue it before assigning another","STATION_OCCUPIED");next(error);}});
  app.patch("/api/organizer/stations/:id",organizer,async(req:AuthedRequest,res,next)=>{try{
    const id=String(req.params.id),available=req.body?.available,scope=`control:station:${id}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);const station:any=db.prepare("SELECT * FROM stations WHERE id=?").get(id);if(!station||typeof available!=="boolean")return fail(res,400,"Valid station availability is required","INVALID_STATION_UPDATE");if(!available&&db.prepare("SELECT 1 FROM matches WHERE station_id=? AND status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED')").get(id))return fail(res,409,"Requeue the called match before closing this occupied station","STATION_OCCUPIED");const response=await controlCommit(req,scope,"control.station.availability","station",id,safety,()=>{db.prepare("UPDATE stations SET available=? WHERE id=?").run(Number(available),id);return{station:{...station,available:Number(available)}};});res.json(response);
  }catch(error){next(error);}});
  app.patch("/api/organizer/stations/:id/event",organizer,async(req:AuthedRequest,res,next)=>{try{
    const id=String(req.params.id),eventId=cleanName(req.body?.eventId),scope=`control:station-event:${id}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);
    const station:any=db.prepare("SELECT * FROM stations WHERE id=?").get(id),target:any=eventId?db.prepare("SELECT * FROM events WHERE id=?").get(eventId):null;
    if(!station||!target)return fail(res,404,"Station or activity not found","STATION_OR_EVENT_NOT_FOUND");
    if(target.kind!=="HEAD_TO_HEAD"||target.play_mode==="CASUAL")return fail(res,409,"Stations may map only to official scored field activities","STATION_EVENT_NOT_OFFICIAL");
    const other:any=db.prepare("SELECT * FROM stations WHERE event_id=? AND id<>?").get(eventId,id);
    for(const stationId of [id,other?.id].filter(Boolean))if(db.prepare("SELECT 1 FROM matches WHERE station_id=? AND status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(stationId))return fail(res,409,"Requeue live matches before changing either station's activity","STATION_OCCUPIED");
    const response=await controlCommit(req,scope,"control.station.event","station",id,safety,()=>{
      db.prepare("UPDATE stations SET event_id=NULL WHERE id=?").run(id);
      if(other)db.prepare("UPDATE stations SET event_id=? WHERE id=?").run(station.event_id,other.id);
      db.prepare("UPDATE stations SET event_id=? WHERE id=?").run(eventId,id);
      return{station:db.prepare("SELECT * FROM stations WHERE id=?").get(id),swappedStation:other?db.prepare("SELECT * FROM stations WHERE id=?").get(other.id):null};
    });res.json(response);
  }catch(error){next(error);}});
  app.patch("/api/organizer/events/:id/availability",organizer,async(req:AuthedRequest,res,next)=>{try{
    const eventId=String(req.params.id),available=req.body?.available,scope=`control:event-availability:${eventId}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);
    const selected:any=db.prepare("SELECT * FROM events WHERE id=?").get(eventId);if(!selected||typeof available!=="boolean")return fail(res,400,"Valid activity availability is required","INVALID_EVENT_UPDATE");
    if(!available&&db.prepare("SELECT 1 FROM matches WHERE event_id=? AND status IN ('CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED') LIMIT 1").get(eventId))return fail(res,409,"Requeue or resolve live matches before closing this activity","EVENT_HAS_LIVE_MATCH");
    const response=await controlCommit(req,scope,"control.event.availability","event",eventId,safety,()=>{db.prepare("UPDATE events SET available=? WHERE id=?").run(Number(available),eventId);return{event:{...selected,available:Number(available)}};});res.json(response);
  }catch(error){next(error);}});

  const rebuildFieldBracket = (eventId: string, eligibleTeams: any[]) => {
    db.prepare("DELETE FROM checkins WHERE match_id IN (SELECT id FROM matches WHERE event_id=?)").run(eventId);
    db.prepare("DELETE FROM disputes WHERE match_id IN (SELECT id FROM matches WHERE event_id=?)").run(eventId);
    db.prepare("DELETE FROM matches WHERE event_id=?").run(eventId);
    db.prepare("DELETE FROM placements WHERE event_id=?").run(eventId);
    db.prepare("UPDATE events SET completed_at=NULL,late_entry_locked=0 WHERE id=?").run(eventId);
    const size = 2 ** Math.ceil(Math.log2(eligibleTeams.length)), rounds = Math.log2(size), byeId = `bye:${eventId}`;
    db.prepare("INSERT OR IGNORE INTO teams(id,event_id,name,name_locked) VALUES(?,?,?,1)").run(byeId,eventId,"BYE");
    const byRound = new Map<number,string[]>();
    for(let round=rounds;round>=1;round--){const ids:string[]=[];for(let i=0;i<size/2**round;i++){const matchId=randomUUID();ids.push(matchId);const role=round===rounds?"FINAL":round===rounds-1?"SEMIFINAL":"STANDARD";db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,?,'MAIN',?,?,?)").run(matchId,eventId,round,role,byeId,byeId);}byRound.set(round,ids);}
    for(let round=1;round<rounds;round++){const current=byRound.get(round)!,next=byRound.get(round+1)!;current.forEach((matchId,index)=>db.prepare("UPDATE matches SET next_match_id=?,next_slot=? WHERE id=?").run(next[Math.floor(index/2)],index%2?"B":"A",matchId));}
    let consolation:string[]=[];const consolationSize=size/2;
    if(eligibleTeams.length>=3&&size<=8){let prior:string[]=[];for(let i=0;i<consolationSize/2;i++){const matchId=randomUUID();prior.push(matchId);consolation.push(matchId);const role=consolationSize===2?"CONSOLATION_FINAL":"STANDARD";db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,1,'CONSOLATION',?,?,?)").run(matchId,eventId,role,byeId,byeId);}let consolationRound=2;while(prior.length>1){const next:string[]=[];for(let i=0;i<prior.length;i+=2){const matchId=randomUUID();next.push(matchId);consolation.push(matchId);const role=prior.length===2?"CONSOLATION_FINAL":"STANDARD";db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,?,'CONSOLATION',?,?,?)").run(matchId,eventId,consolationRound,role,byeId,byeId);db.prepare("UPDATE matches SET next_match_id=?,next_slot='A' WHERE id=?").run(matchId,prior[i]);db.prepare("UPDATE matches SET next_match_id=?,next_slot='B' WHERE id=?").run(matchId,prior[i+1]);}prior=next;consolationRound++;}}
    const thirdId=eligibleTeams.length>=4?randomUUID():null;if(thirdId)db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id) VALUES(?,?,?,'MAIN','THIRD_PLACE',?,?)").run(thirdId,eventId,rounds,byeId,byeId);
    const first=byRound.get(1)!,seeded=seededBracketSlots(eligibleTeams,size,byeId);
    first.forEach((matchId,index)=>{const real=!seeded[index*2]!.startsWith("bye:")&&!seeded[index*2+1]!.startsWith("bye:");const realIndex=first.slice(0,index).filter((_,j)=>!seeded[j*2]!.startsWith("bye:")&&!seeded[j*2+1]!.startsWith("bye:")).length;db.prepare("UPDATE matches SET team_a_id=?,team_b_id=?,loser_match_id=?,loser_slot=? WHERE id=?").run(seeded[index*2],seeded[index*2+1],real?consolation[Math.floor(realIndex/2)]??null:null,real?(realIndex%2?"B":"A"):null,matchId);});
    if(thirdId)byRound.get(rounds-1)!.forEach((matchId,index)=>db.prepare("UPDATE matches SET loser_match_id=?,loser_slot=? WHERE id=?").run(thirdId,index?"B":"A",matchId));
    let changed=true;while(changed){changed=false;const byes:any[]=db.prepare("SELECT * FROM matches WHERE event_id=? AND path='MAIN' AND round=1 AND status='PENDING' AND ((team_a_id=? AND team_b_id<>?) OR (team_b_id=? AND team_a_id<>?))").all(eventId,byeId,byeId,byeId,byeId) as any[];for(const match of byes){finalizeMatch(match.id,match.team_a_id===byeId?match.team_b_id:match.team_a_id);changed=true;}}
    return (db.prepare("SELECT id FROM matches WHERE event_id=? ORDER BY rowid").all(eventId) as any[]).map(row=>row.id);
  };

  app.post("/api/organizer/events/:id/bracket/regenerate",organizer,async(req:AuthedRequest,res,next)=>{try{
    const eventId=String(req.params.id),scope=`control:bracket-regenerate:${eventId}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);
    const rows:any[]=db.prepare("SELECT * FROM matches WHERE event_id=? ORDER BY rowid").all(eventId) as any[];if(!rows.length)return fail(res,409,"Create teams and a bracket before regeneration","BRACKET_NOT_FOUND");
    const genuinelyPlayed=rows.some(row=>row.status!=="PENDING"&&row.status!=="SKIPPED"&&!(row.status==="FINAL"&&(String(row.team_a_id).startsWith("bye:")||String(row.team_b_id).startsWith("bye:"))&&!row.started_at));
    if(genuinelyPlayed)return fail(res,409,"Bracket regeneration is locked after any real match is called or played","BRACKET_PLAY_LOCKED");
    const eligibleTeams:any[]=db.prepare(`SELECT t.id FROM teams t WHERE t.event_id=? AND t.name<>'BYE' AND
      (SELECT count(*) FROM team_members tm JOIN participants p ON p.id=tm.participant_id JOIN event_entries ee ON ee.event_id=t.event_id AND ee.participant_id=tm.participant_id WHERE tm.team_id=t.id AND tm.active=1 AND p.active=1)>=2 ORDER BY t.rowid`).all(eventId) as any[];
    if(eligibleTeams.length<2)return fail(res,409,"At least two playable enrolled teams are required","TEAMS_REQUIRED");
    const response=await controlCommit(req,scope,"control.bracket.regenerate","event",eventId,safety,()=>({eventId,matchIds:rebuildFieldBracket(eventId,eligibleTeams)}));res.json(response);
  }catch(error){next(error);}});

  const rebuildFieldPlacements = (eventId: string) => {
    db.prepare("DELETE FROM placements WHERE event_id=?").run(eventId);
    const final:any=db.prepare("SELECT * FROM matches WHERE event_id=? AND role='FINAL' AND status='FINAL'").get(eventId);
    const third:any=db.prepare("SELECT * FROM matches WHERE event_id=? AND role='THIRD_PLACE' AND status='FINAL'").get(eventId);
    if(!final||!third){db.prepare("UPDATE events SET completed_at=NULL WHERE id=?").run(eventId);return false;}
    const results=[[final.winner_id,1],[final.winner_id===final.team_a_id?final.team_b_id:final.team_a_id,2],[third.winner_id,3],[third.winner_id===third.team_a_id?third.team_b_id:third.team_a_id,4]] as const;
    for(const [teamId,place] of results){const eligible:any[]=db.prepare("SELECT participant_id FROM team_members WHERE team_id=? AND eligible_points=1").all(teamId) as any[];for(const member of eligible)db.prepare("INSERT OR REPLACE INTO placements(event_id,participant_id,place,points) VALUES(?,?,?,?)").run(eventId,member.participant_id,place,pointsForPlace(place));}
    db.prepare("UPDATE events SET completed_at=? WHERE id=?").run(now().toISOString(),eventId);return true;
  };

  app.post("/api/organizer/matches/:id/correct-result",organizer,async(req:AuthedRequest,res,next)=>{try{
    const id=String(req.params.id),winner=cleanName(req.body?.winningTeamId),scope=`control:match-correction:${id}`,safety:any=controlSafety(req,res,scope);if(safety.error)return;if(safety.prior)return res.json(safety.prior);const m:any=db.prepare("SELECT * FROM matches WHERE id=?").get(id);if(!m||![m.team_a_id,m.team_b_id].includes(winner))return fail(res,400,"Select a valid winner for this match","INVALID_WINNER");if(!["FINAL","AWAITING_CONFIRMATION","DISPUTED"].includes(m.status))return fail(res,409,"Only a reported, disputed, or final result can be corrected","RESULT_CORRECTION_LOCKED");if(m.winner_id===winner&&m.status==="FINAL")return res.json({match:matchView(id),alreadyCurrent:true});const descendants:string[]=[];const visit=(nextId:string|null)=>{if(!nextId||descendants.includes(nextId))return;descendants.push(nextId);const row:any=db.prepare("SELECT next_match_id,loser_match_id FROM matches WHERE id=?").get(nextId);if(row){visit(row.next_match_id);visit(row.loser_match_id);}};visit(m.next_match_id);visit(m.loser_match_id);const started=descendants.map(matchId=>db.prepare("SELECT id,status,started_at,completed_at FROM matches WHERE id=?").get(matchId) as any).find(row=>row&&(row.started_at||row.completed_at||!["PENDING","SKIPPED"].includes(row.status)));if(started)return fail(res,409,`Downstream match ${started.id} has started; its result must be resolved before correcting this match`,"DOWNSTREAM_MATCH_STARTED");const oldWinner=m.winner_id??m.reported_winner_id,oldLoser=oldWinner===m.team_a_id?m.team_b_id:m.team_a_id,newLoser=winner===m.team_a_id?m.team_b_id:m.team_a_id;const response=await controlCommit(req,scope,"control.match.correct-result","match",id,safety,()=>{if(m.next_match_id&&m.next_slot)db.prepare(`UPDATE matches SET ${m.next_slot==="A"?"team_a_id":"team_b_id"}=? WHERE id=?`).run(winner,m.next_match_id);if(m.loser_match_id&&m.loser_slot)db.prepare(`UPDATE matches SET ${m.loser_slot==="A"?"team_a_id":"team_b_id"}=? WHERE id=?`).run(newLoser,m.loser_match_id);db.prepare("UPDATE matches SET status='FINAL',winner_id=?,reported_winner_id=?,completed_at=?,advancement_count=CASE WHEN advancement_count<1 THEN 1 ELSE advancement_count END,station_id=NULL WHERE id=?").run(winner,winner,now().toISOString(),id);db.prepare("UPDATE disputes SET resolved_at=? WHERE match_id=? AND resolved_at IS NULL").run(now().toISOString(),id);const placementsRebuilt=rebuildFieldPlacements(m.event_id);return{match:matchView(id),previousWinnerId:oldWinner,previousLoserId:oldLoser,placementsRebuilt};});res.json(response);
  }catch(error){next(error);}});

  app.post("/api/admin/session", rateLimit("organizer-login", 20), (req, res) => {
    const index = ["Chris", "Paul"].indexOf(req.body?.organizer);
    if (index < 0 || req.body?.credential !== organizerTokens[index]) return fail(res,401,"invalid organizer credential","INVALID_CREDENTIAL");
    res.json({ organizer: req.body.organizer });
  });
  const exportTables = () => {
    const tables = ["participants","events","event_entries","teams","team_members","targets","cannon_shots","placements","matches","stations","checkins","flair_props","flair_votes","disputes","substitutions","audit_log"];
    return Object.fromEntries(tables.map(t => [t,db.prepare(`SELECT * FROM ${t}`).all()]));
  };
  app.post("/api/admin/backups", organizer, async (req: AuthedRequest,res,next) => {
    try {
      const id=randomUUID(),root=path.resolve(process.env.DATA_DIR ?? "/tmp/junkyard-olympics"),destination=path.join(root,"backups",`${id}.sqlite`);
      await backupDatabase(db,destination); db.prepare("INSERT INTO backups(id,path) VALUES(?,?)").run(id,destination); audit(db,req.organizer!,"backup.create","backup",id);
      res.status(201).json({backup:db.prepare("SELECT id,path,created_at createdAt FROM backups WHERE id=?").get(id)});
    } catch(error){next(error);}
  });
  app.post("/api/admin/restores", organizer, async (req: AuthedRequest,res,next) => {
    try {
      const backup:any=db.prepare("SELECT * FROM backups WHERE id=?").get(req.body?.backupId),key=cleanName(req.body?.idempotencyKey,200);
      if(!backup||req.body?.confirm!==true||!key)return fail(res,400,"explicit valid restore required","INVALID_RESTORE");
      const prior:any=db.prepare("SELECT response_json FROM idempotency_keys WHERE scope='restore' AND key=?").get(key); if(prior)return res.json(JSON.parse(prior.response_json));
      const root=path.resolve(process.env.DATA_DIR ?? "/tmp/junkyard-olympics"); if(!path.resolve(backup.path).startsWith(`${root}${path.sep}`))return fail(res,400,"restore path escapes data root","INVALID_RESTORE_PATH");
      const preId=randomUUID(),prePath=path.join(root,"backups",`${preId}.sqlite`); await backupDatabase(db,prePath); const response={restored:true,backupId:backup.id,preDestructiveBackupId:preId};
      tx(()=>{db.prepare("INSERT INTO backups(id,path) VALUES(?,?)").run(preId,prePath);audit(db,req.organizer!,"restore","backup",backup.id,{idempotencyKey:key,preDestructiveBackupId:preId});db.prepare("INSERT INTO idempotency_keys(scope,key,response_json) VALUES('restore',?,?)").run(key,JSON.stringify(response));});
      res.status(201).json(response);
    }catch(error){next(error);}
  });
  app.get("/api/admin/audit",organizer,(_req,res)=>res.json({entries:(db.prepare("SELECT actor,action,details,created_at createdAt FROM audit_log ORDER BY rowid").all() as any[]).map(row=>({...row,...JSON.parse(row.details)}))}));
  app.get("/api/admin/export.json",organizer,(_req,res)=>res.json(exportTables()));
  app.get("/api/admin/export", organizer, (_req, res) => {
    res.json(exportTables());
  });
  app.get("/api/admin/export.csv", organizer, (_req, res) => {
    const rows: any[] = db
      .prepare(
        "SELECT id,display_name,active,created_at FROM participants ORDER BY display_name",
      )
      .all();
    const esc = (x: unknown) => {
      const raw = String(x ?? ""), safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    res
      .type("text/csv")
      .send(
        [
          "id,display_name,active,created_at",
          ...rows.map((r) =>
            [r.id, r.display_name, r.active, r.created_at].map(esc).join(","),
          ),
        ].join("\n"),
      );
  });
  app.use((_req, res) => fail(res, 404, "not found", "NOT_FOUND"));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    fail(res, 500, "internal server error");
  });
  return app;
}

export { pointsForPlace };
