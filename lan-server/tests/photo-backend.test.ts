import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import sharp from "sharp";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, PHOTO_CONSENT_VERSION } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createPhotoStorage } from "../src/photo-storage.js";

const disposable: string[] = [];
afterEach(async () => {
  await Promise.all(disposable.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("photo database migration", () => {
  it("adds the numbered constrained photo lifecycle schema idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junkyard-photo-db-"));
    disposable.push(dir);
    const databasePath = join(dir, "event.sqlite");
    const db = createDatabase(databasePath);

    expect(db.pragma("user_version", { simple: true })).toBe(11);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'photo_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(["photo_export_events", "photo_external_identities", "photo_moderation_events", "photo_uploader_bans", "photo_uploads", "photo_wall_settings"]);
    expect(db.prepare("SELECT enabled,rotation_interval_seconds FROM photo_wall_settings WHERE id=1").get()).toEqual({ enabled: 0, rotation_interval_seconds: 12 });
    expect(() => db.prepare("INSERT INTO photo_uploads(id,participant_id,content_hash,state,consent_version,consent_text,consented_at,width,height,normalized_path) VALUES('bad','missing','hash','PUBLISHED','v','text','now',1,1,'x')").run()).toThrow();
    db.exec(`
      DROP TABLE photo_external_identities;
      DROP TABLE photo_export_events;
      DROP TABLE photo_moderation_events;
      DROP TABLE photo_uploader_bans;
      DROP TABLE photo_wall_settings;
      DROP TABLE photo_uploads;
      DROP INDEX idx_cannon_shots_team_run;
      DROP TABLE cannon_team_runs;
      ALTER TABLE cannon_shots DROP COLUMN team_run_id;
      ALTER TABLE cannon_runs DROP COLUMN mode;
      ALTER TABLE cannon_runs DROP COLUMN duration_seconds;
      ALTER TABLE cannon_runs DROP COLUMN carnage_bonus;
    `);
    db.pragma("user_version = 8");
    db.close();

    const reopened = createDatabase(databasePath);
    expect(reopened.pragma("user_version", { simple: true })).toBe(11);
    expect((reopened.prepare("SELECT count(*) AS count FROM photo_wall_settings").get() as { count: number }).count).toBe(1);
    expect(reopened.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
    reopened.close();

    const idempotent = createDatabase(databasePath);
    expect(idempotent.pragma("user_version", { simple: true })).toBe(11);
    expect(idempotent.pragma("integrity_check", { simple: true })).toBe("ok");
    idempotent.close();
  });
});

describe("normalized photo storage boundary", () => {
  it("creates private runtime directories and normalizes JPEG, PNG and WebP to metadata-free bounded WebP", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "junkyard-photo-data-"));
    disposable.push(dataDir);
    await mkdir(join(dataDir, "photos", "quarantine"), { recursive: true });
    await chmod(join(dataDir, "photos"), 0o755);
    await chmod(join(dataDir, "photos", "quarantine"), 0o755);
    const storage = createPhotoStorage(dataDir);

    for (const format of ["jpeg", "png", "webp"] as const) {
      const input = await sharp({
        create: { width: 2000, height: 1000, channels: 3, background: "#c75b25" },
      }).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
      const normalized = await storage.normalize(input);
      const output = await readFile(normalized.absolutePath);
      const metadata = await sharp(output).metadata();

      expect(normalized).toMatchObject({ width: 800, height: 1600, format: "webp" });
      expect(normalized.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(metadata).toMatchObject({ format: "webp", width: 800, height: 1600 });
      expect(metadata.exif).toBeUndefined();
      expect(relative(dataDir, normalized.absolutePath)).toMatch(/^photos\/quarantine\/[a-f0-9-]+\.webp$/);
    }

    for (const directory of ["originals", "plaques", "quarantine", "exports"]) {
      const details = await stat(join(dataDir, "photos", directory));
      expect(details.isDirectory()).toBe(true);
      expect(details.mode & 0o777).toBe(0o700);
    }
  });
});

type PhotoHarness = Awaited<ReturnType<typeof photoHarness>>;
async function photoHarness(photoStorageFactory?: typeof createPhotoStorage) {
  const dataDir = await mkdtemp(join(tmpdir(), "junkyard-photo-api-"));
  disposable.push(dataDir);
  const db = createDatabase(":memory:");
  let timestamp = new Date("2026-08-15T18:00:00.000Z");
  const processed: string[] = [];
  const app = createApp({
    db,
    organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"],
    dataDir,
    now: () => timestamp,
    photoProcessor: async (photo) => { processed.push(photo.id); },
    photoStorageFactory,
  });
  const signup = async (name: string) => {
    const response = await request(app).post("/api/participants").send({ displayName: name });
    return response.body as { participant: { id: string }; token: string };
  };
  const close = () => db.close();
  const advance = (milliseconds: number) => { timestamp = new Date(timestamp.getTime() + milliseconds); };
  return { app, db, dataDir, processed, signup, close, advance };
}

async function fixture(format: "jpeg" | "png" | "webp" = "jpeg", color = "#427b58") {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).toFormat(format).toBuffer();
}

async function upload(harness: PhotoHarness, token: string, image: Buffer, fields: Record<string, string> = {}) {
  let call = request(harness.app)
    .post("/api/photos")
    .set("Authorization", `Bearer ${token}`)
    .field("consent", "true")
    .field("consentVersion", PHOTO_CONSENT_VERSION);
  for (const [key, value] of Object.entries(fields)) call = call.field(key, value);
  return call.attach("photo", image, { filename: "untrusted.jpg", contentType: "application/octet-stream" });
}

const organizerA = { Authorization: "Bearer organizer-a-very-strong-secret" };
const organizerB = { Authorization: "Bearer organizer-b-very-strong-secret" };

describe("participant photo API", () => {
  it("authenticates, records exact consent, normalizes privately and exposes owner-safe processing status", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const outsider = await harness.signup("Outsider");
    const response = await upload(harness, owner.token, await fixture("png"), { names: "Alex & Sam" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.photo).toMatchObject({ state: "PROCESSING", names: "Alex & Sam" });
    expect(response.body.photo).not.toHaveProperty("normalizedPath");
    expect(harness.processed).toEqual([response.body.photo.id]);
    const row = harness.db.prepare("SELECT * FROM photo_uploads WHERE id=?").get(response.body.photo.id) as any;
    expect(row).toMatchObject({ participant_id: owner.participant.id, consent_version: PHOTO_CONSENT_VERSION, state: "PROCESSING" });
    expect(row.normalized_path).toMatch(/^photos\/quarantine\//);
    expect(await stat(join(harness.dataDir, row.normalized_path))).toBeTruthy();

    expect((await request(harness.app).get(`/api/photos/${row.id}`).set("Authorization", `Bearer ${owner.token}`)).status).toBe(200);
    expect((await request(harness.app).get(`/api/photos/${row.id}`).set("Authorization", `Bearer ${outsider.token}`)).status).toBe(404);
    expect((await request(harness.app).get("/api/photos").set("Authorization", `Bearer ${owner.token}`)).body.photos).toHaveLength(1);
    expect(JSON.stringify((await request(harness.app).get("/api/state")).body)).not.toContain(row.id);
    harness.close();
  });

  it("fails closed for anonymous, organizer, cross-origin, missing consent and hostile names", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const image = await fixture();
    expect((await request(harness.app).post("/api/photos").attach("photo", image, "x.jpg")).status).toBe(401);
    expect((await upload(harness, "organizer-a-very-strong-secret", image)).status).toBe(401);
    expect((await request(harness.app).post("/api/photos").set("Authorization", `Bearer ${owner.token}`).set("Origin", "https://attacker.example").field("consent", "true").field("consentVersion", PHOTO_CONSENT_VERSION).attach("photo", image, "x.jpg")).status).toBe(403);
    expect((await request(harness.app).post("/api/photos").set("Authorization", `Bearer ${owner.token}`).field("consent", "false").field("consentVersion", PHOTO_CONSENT_VERSION).attach("photo", image, "x.jpg")).status).toBe(400);
    expect((await upload(harness, owner.token, image, { names: "../victim\r\nX-Evil: yes" })).status).toBe(400);
    expect((harness.db.prepare("SELECT count(*) count FROM photo_uploads").get() as any).count).toBe(0);
    harness.close();
  });

  it("rejects malformed, non-image, trailing polyglot, over-8-MiB and over-20MP payloads without retaining files", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    expect((await upload(harness, owner.token, Buffer.from("not an image"))).status).toBe(400);
    const polyglot = Buffer.concat([await fixture(), Buffer.from("<script>alert(1)</script>")]);
    expect((await upload(harness, owner.token, polyglot)).status).toBe(400);
    expect((await upload(harness, owner.token, Buffer.alloc(8 * 1024 * 1024 + 1))).status).toBe(413);
    const bomb = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: "black" } }).png().toBuffer();
    expect((await upload(harness, owner.token, bomb)).status).toBe(400);
    expect((harness.db.prepare("SELECT count(*) count FROM photo_uploads").get() as any).count).toBe(0);
    harness.close();
  });

  it("rejects duplicate replay, enforces the durable minute/event limits and never auto-publishes", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const first = await fixture("jpeg", "#111111");
    expect((await upload(harness, owner.token, first)).status).toBe(201);
    harness.advance(60_001);
    expect((await upload(harness, owner.token, first)).status).toBe(409);
    expect((await upload(harness, owner.token, await fixture("jpeg", "#222222"))).status).toBe(201);
    expect((await upload(harness, owner.token, await fixture("jpeg", "#333333"))).status).toBe(429);
    for (let index = 2; index < 12; index++) {
      harness.advance(60_001);
      expect((await upload(harness, owner.token, await fixture("png", `rgb(${index},${index * 2},${index * 3})`))).status).toBe(201);
    }
    harness.advance(60_001);
    expect((await upload(harness, owner.token, await fixture("png", "white"))).status).toBe(429);
    expect((harness.db.prepare("SELECT count(*) count FROM photo_uploads WHERE state='PUBLISHED'").get() as any).count).toBe(0);
    harness.close();
  });

  it("allows one owner removal request and rejects IDOR or lifecycle replay", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const outsider = await harness.signup("Outsider");
    const created = await upload(harness, owner.token, await fixture());
    const endpoint = `/api/photos/${created.body.photo.id}/removal-request`;
    expect((await request(harness.app).post(endpoint).set("Authorization", `Bearer ${outsider.token}`)).status).toBe(404);
    expect((await request(harness.app).post(endpoint).set("Authorization", `Bearer ${owner.token}`)).status).toBe(200);
    expect((await request(harness.app).post(endpoint).set("Authorization", `Bearer ${owner.token}`)).status).toBe(409);
    expect((harness.db.prepare("SELECT removal_requested_at FROM photo_uploads WHERE id=?").get(created.body.photo.id) as any).removal_requested_at).toBeTruthy();
    harness.close();
  });

  it("fails processor errors closed and reconciles stuck processing rows to private review on restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "junkyard-photo-reconcile-"));
    disposable.push(dataDir);
    const db = createDatabase(":memory:");
    const tokens = ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"];
    const failing = createApp({ db, organizerTokens: tokens, dataDir, photoProcessor: async () => { throw new Error("offline"); } });
    const participant = (await request(failing).post("/api/participants").send({ displayName: "Pending" })).body;
    const failed = await request(failing).post("/api/photos").set("Authorization", `Bearer ${participant.token}`).field("consent", "true").field("consentVersion", PHOTO_CONSENT_VERSION).attach("photo", await fixture(), "x.jpg");
    expect(failed.body.photo.state).toBe("PENDING_REVIEW");

    db.prepare("UPDATE photo_uploads SET state='PROCESSING' WHERE id=?").run(failed.body.photo.id);
    createApp({ db, organizerTokens: tokens, dataDir });
    expect((db.prepare("SELECT state FROM photo_uploads WHERE id=?").get(failed.body.photo.id) as any).state).toBe("PENDING_REVIEW");
    db.close();
  });

  it("matches the participant UI contract for consentAccepted and the owner-only mine route", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const outsider = await harness.signup("Outsider");
    const created = await request(harness.app)
      .post("/api/photos")
      .set("Authorization", `Bearer ${owner.token}`)
      .field("consentAccepted", "true")
      .field("consentVersion", PHOTO_CONSENT_VERSION)
      .field("names", "Alex")
      .attach("photo", await fixture("webp"), { filename: "../../private.webp", contentType: "text/plain" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await request(harness.app).get("/api/photos/mine").set("Authorization", `Bearer ${owner.token}`)).body.photos).toEqual([
      expect.objectContaining({ id: created.body.photo.id, names: "Alex" }),
    ]);
    expect((await request(harness.app).get(`/api/photos/${created.body.photo.id}`).set("Authorization", `Bearer ${outsider.token}`)).status).toBe(404);
    harness.close();
  });

  it("provides attributable organizer moderation, settings and private previews without leaking paths", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Uploader");
    const created = await upload(harness, owner.token, await fixture("png"), { names: "Pat" });
    const id = created.body.photo.id;
    harness.db.prepare("UPDATE photo_uploads SET state='PENDING_REVIEW',moderation_summary='AGE_UNCERTAIN' WHERE id=?").run(id);
    harness.db.prepare("INSERT INTO photo_moderation_events(id,photo_id,stage,rule_version,verdict,reason_codes,actor,created_at) VALUES('reason-event',?,'LOCAL_VISION','v1','PENDING_REVIEW','[\"AGE_UNCERTAIN\"]','system','2026-08-15T18:00:01.000Z')").run(id);

    expect((await request(harness.app).get("/api/organizer/photos")).status).toBe(401);
    expect((await request(harness.app).get(`/api/organizer/photos/${id}/preview`).set("Authorization", `Bearer ${owner.token}`)).status).toBe(401);
    const queue = await request(harness.app).get("/api/organizer/photos").set(organizerA);
    expect(queue.status).toBe(200);
    expect(queue.body).toMatchObject({ settings: { enabled: false, rotationIntervalSeconds: 12 }, pending: [expect.objectContaining({ id, uploaderDisplayName: "Uploader", names: "Pat", reasonCodes: ["AGE_UNCERTAIN"] })], published: [], removed: [] });
    expect(JSON.stringify(queue.body)).not.toMatch(/normalized_path|normalizedPath|content_hash|participant_id/i);
    const preview = await request(harness.app).get(`/api/organizer/photos/${id}/preview`).set(organizerB);
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toMatch(/^image\/webp/);
    expect(preview.headers["cache-control"]).toContain("no-store");

    expect((await request(harness.app).patch("/api/organizer/photo-wall").set(organizerA).send({ enabled: "yes" })).status).toBe(400);
    expect((await request(harness.app).patch("/api/organizer/photo-wall").set(organizerA).send({ enabled: true })).body.settings.enabled).toBe(true);
    const published = await request(harness.app).post(`/api/organizer/photos/${id}/publish`).set(organizerB).send({});
    expect(published.status).toBe(200);
    expect(published.body.photo.state).toBe("PUBLISHED");
    expect(harness.db.prepare("SELECT actor,action FROM audit_log WHERE entity_id=? ORDER BY rowid DESC LIMIT 1").get(id)).toEqual({ actor: "Paul", action: "photo.publish" });
    expect((await request(harness.app).post(`/api/organizer/photos/${id}/remove`).set(organizerA).set("Origin", "https://attacker.example").send({})).status).toBe(403);
    expect((await request(harness.app).post(`/api/organizer/photos/${id}/remove`).set(organizerA).send({})).body.photo.state).toBe("REMOVED");
    expect((await request(harness.app).post(`/api/organizer/photos/${id}/remove`).set(organizerA).send({})).body.photo.state).toBe("REMOVED");
    expect((await request(harness.app).post(`/api/organizer/photos/${id}/restore`).set(organizerB).send({})).body.photo.state).toBe("PUBLISHED");
    expect((await request(harness.app).post(`/api/organizer/photos/${id}/reject`).set(organizerB).send({})).status).toBe(409);
    harness.close();
  });

  it("exposes only enabled published descriptors and version-bound no-store image bytes", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const created = await upload(harness, owner.token, await fixture());
    const id = created.body.photo.id;
    harness.db.prepare("UPDATE photo_uploads SET state='PENDING_REVIEW' WHERE id=?").run(id);
    expect((await request(harness.app).get("/api/photo-wall")).body).toMatchObject({ enabled: false, photos: [] });
    expect((await request(harness.app).get(`/api/photo-wall/photos/${id}/image`)).status).toBe(404);
    await request(harness.app).post(`/api/organizer/photos/${id}/publish`).set(organizerA).send({});
    await request(harness.app).patch("/api/organizer/photo-wall").set(organizerA).send({ enabled: true });
    const wall = await request(harness.app).get("/api/photo-wall");
    expect(wall.body.enabled).toBe(true);
    expect(wall.body.photos).toEqual([expect.objectContaining({ id, version: expect.any(String), imageUrl: expect.stringMatching(/^\/api\/photo-wall\/photos\//) })]);
    expect(JSON.stringify(wall.body)).not.toMatch(/participant|moderation|reason|path|hash/i);
    const image = await request(harness.app).get(wall.body.photos[0].imageUrl);
    expect(image.status).toBe(200);
    expect(image.headers["cache-control"]).toContain("no-store");
    expect((await request(harness.app).get(`/api/photo-wall/photos/${id}/image?version=stale`)).status).toBe(404);

    const removal = await request(harness.app).post(`/api/photos/${id}/removal-request`).set("Authorization", `Bearer ${owner.token}`).send({});
    expect(removal.body.photo.state).toBe("REMOVAL_REQUESTED");
    expect((await request(harness.app).get("/api/photo-wall")).body.photos).toEqual([]);
    expect((await request(harness.app).get(wall.body.photos[0].imageUrl)).status).toBe(404);
    harness.close();
  });

  it("serializes the injectable processor and closes concurrent durable rate-limit races", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "junkyard-photo-serial-"));
    disposable.push(dataDir);
    const db = createDatabase(":memory:");
    let active = 0, maximumActive = 0;
    const app = createApp({
      db,
      organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"],
      dataDir,
      photoProcessor: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return "PENDING_REVIEW";
      },
    });
    const first = (await request(app).post("/api/participants").send({ displayName: "First" })).body;
    const second = (await request(app).post("/api/participants").send({ displayName: "Second" })).body;
    const [one, two] = await Promise.all([upload({ app } as PhotoHarness, first.token, await fixture("jpeg", "#101010")), upload({ app } as PhotoHarness, second.token, await fixture("jpeg", "#202020"))]);
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(maximumActive).toBe(1);

    const third = (await request(app).post("/api/participants").send({ displayName: "Third" })).body;
    const concurrent = await Promise.all([
      upload({ app } as PhotoHarness, third.token, await fixture("png", "#303030")),
      upload({ app } as PhotoHarness, third.token, await fixture("png", "#404040")),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 429]);
    db.close();
  });

  it("defaults an unavailable processor to private pending review", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "junkyard-photo-default-"));
    disposable.push(dataDir);
    const db = createDatabase(":memory:");
    const app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"], dataDir });
    const participant = (await request(app).post("/api/participants").send({ displayName: "Pending" })).body;
    const created = await upload({ app } as PhotoHarness, participant.token, await fixture());
    expect(created.status).toBe(201);
    expect(created.body.photo.state).toBe("PENDING_REVIEW");
    expect((await request(app).get("/api/photo-wall")).body.photos).toEqual([]);
    db.close();
  });

  it("maps a verified Paul identity only for photo routes without storing the bearer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "junkyard-photo-paul-"));
    disposable.push(dataDir);
    const db = createDatabase(":memory:");
    const app = createApp({
      db,
      organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"],
      dataDir,
      photoIdentityVerifier: async (token) => token === "paul-test-bearer" ? { subject: "paul-user-123", displayName: "Paul Guest" } : null,
    });
    const verified = await request(app).get("/api/photos/mine").set("Authorization", "Bearer paul-test-bearer").set("X-Junkyard-User-Name", "Mallory Cannot Rename Paul");
    expect(verified.status).toBe(200);
    expect(verified.body.photos).toEqual([]);
    expect((db.prepare("SELECT count(*) count FROM photo_external_identities").get() as any).count).toBe(1);
    expect((db.prepare("SELECT display_name displayName FROM photo_external_identities").get() as any).displayName).toBe("Paul Guest");
    expect((db.prepare("SELECT count(*) count FROM event_entries").get() as any).count).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT * FROM photo_external_identities").all())).not.toContain("paul-test-bearer");
    expect((await request(app).get("/api/photos/mine").set("Authorization", "Bearer forged").set("X-Junkyard-User-Name", "Paul Guest")).status).toBe(401);
    db.close();
  });

  it("deletes pixels after a pre-action backup and bans an uploader durably", async () => {
    const harness = await photoHarness();
    const owner = await harness.signup("Owner");
    const first = await upload(harness, owner.token, await fixture());
    const firstRow = harness.db.prepare("SELECT normalized_path FROM photo_uploads WHERE id=?").get(first.body.photo.id) as any;
    harness.db.prepare("UPDATE photo_uploads SET state='PENDING_REVIEW' WHERE id=?").run(first.body.photo.id);
    expect((await request(harness.app).post(`/api/organizer/photos/${first.body.photo.id}/ban-uploader`).set(organizerA).send({})).status).toBe(200);
    harness.advance(60_001);
    expect((await upload(harness, owner.token, await fixture("png", "#123456"))).status).toBe(403);
    const deleted = await request(harness.app).post(`/api/organizer/photos/${first.body.photo.id}/delete`).set(organizerB).send({});
    expect(deleted.status).toBe(200);
    expect(deleted.body.photo.state).toBe("DELETED");
    await expect(stat(join(harness.dataDir, firstRow.normalized_path))).rejects.toMatchObject({ code: "ENOENT" });
    expect((harness.db.prepare("SELECT count(*) count FROM backups").get() as any).count).toBe(1);
    expect((harness.db.prepare("SELECT count(*) count FROM photo_uploader_bans WHERE participant_id=?").get(owner.participant.id) as any).count).toBe(1);
    harness.close();
  });

  it("commits DELETED before file cleanup and safely resumes a partial cleanup", async () => {
    let storage: ReturnType<typeof createPhotoStorage> | undefined;
    let removalCalls = 0;
    const harness = await photoHarness((dataDir) => {
      const base = createPhotoStorage(dataDir);
      storage = {
        ...base,
        removeStored: async (storedPath) => {
          removalCalls += 1;
          if (removalCalls === 2) throw new Error("injected second-file cleanup failure");
          return base.removeStored(storedPath);
        },
      };
      return storage;
    });
    const owner = await harness.signup("Cleanup Owner");
    const created = await upload(harness, owner.token, await fixture());
    const id = created.body.photo.id;
    const original: any = harness.db.prepare("SELECT normalized_path FROM photo_uploads WHERE id=?").get(id);
    const plaque = await storage!.normalize(await fixture("png", "#654321"));
    harness.db.prepare("UPDATE photo_uploads SET state='PUBLISHED',plaque_path=? WHERE id=?").run(plaque.relativePath, id);
    await request(harness.app).patch("/api/organizer/photo-wall").set(organizerA).send({ enabled: true });

    const interrupted = await request(harness.app).post(`/api/organizer/photos/${id}/delete`).set(organizerA).send({});
    expect(interrupted.status).toBe(500);
    expect((harness.db.prepare("SELECT state,normalized_path,plaque_path FROM photo_uploads WHERE id=?").get(id) as any)).toEqual({
      state: "DELETED",
      normalized_path: original.normalized_path,
      plaque_path: plaque.relativePath,
    });
    expect((await request(harness.app).get("/api/photo-wall")).body.photos).toEqual([]);

    const resumed = await request(harness.app).post(`/api/organizer/photos/${id}/delete`).set(organizerB).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.photo.state).toBe("DELETED");
    await expect(stat(join(harness.dataDir, original.normalized_path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(harness.dataDir, plaque.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((harness.db.prepare("SELECT plaque_path FROM photo_uploads WHERE id=?").get(id) as any).plaque_path).toBeNull();
    expect((harness.db.prepare("SELECT count(*) count FROM backups").get() as any).count).toBe(1);
    harness.close();
  });
});
