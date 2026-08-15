import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Db = Database.Database;

const migrations = [
  `
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('CANNON','HEAD_TO_HEAD')),sort_order INTEGER NOT NULL,available INTEGER NOT NULL DEFAULT 1,late_entry_locked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS event_entries(event_id TEXT NOT NULL REFERENCES events(id),participant_id TEXT NOT NULL REFERENCES participants(id),joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(event_id,participant_id));
  CREATE TABLE IF NOT EXISTS flair_props(id TEXT PRIMARY KEY,giver_id TEXT NOT NULL REFERENCES participants(id),recipient_id TEXT NOT NULL REFERENCES participants(id),category TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(giver_id,recipient_id,category));
  CREATE TABLE IF NOT EXISTS flair_votes(id TEXT PRIMARY KEY,voter_id TEXT NOT NULL UNIQUE REFERENCES participants(id),recipient_id TEXT NOT NULL REFERENCES participants(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),name TEXT NOT NULL,renamed INTEGER NOT NULL DEFAULT 0,name_locked INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,name));
  CREATE TABLE IF NOT EXISTS team_members(team_id TEXT NOT NULL REFERENCES teams(id),participant_id TEXT NOT NULL REFERENCES participants(id),substitute INTEGER NOT NULL DEFAULT 0,eligible_points INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(team_id,participant_id));
  CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),name TEXT NOT NULL,points INTEGER NOT NULL,jackpot INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS cannon_shots(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),team_id TEXT NOT NULL REFERENCES teams(id),practice INTEGER NOT NULL DEFAULT 0,carnage INTEGER NOT NULL DEFAULT 0,points INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS cannon_shot_targets(shot_id TEXT NOT NULL REFERENCES cannon_shots(id),target_id TEXT NOT NULL REFERENCES targets(id),points INTEGER NOT NULL,PRIMARY KEY(shot_id,target_id));
  CREATE TABLE IF NOT EXISTS placements(event_id TEXT NOT NULL REFERENCES events(id),participant_id TEXT NOT NULL REFERENCES participants(id),place INTEGER NOT NULL,points INTEGER NOT NULL,PRIMARY KEY(event_id,participant_id));
  CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),round INTEGER NOT NULL DEFAULT 1,path TEXT NOT NULL DEFAULT 'MAIN',team_a_id TEXT NOT NULL REFERENCES teams(id),team_b_id TEXT NOT NULL REFERENCES teams(id),status TEXT NOT NULL DEFAULT 'PENDING',station_id TEXT,called_at TEXT,started_at TEXT,completed_at TEXT,winner_id TEXT,reported_winner_id TEXT,reporter_id TEXT);
  CREATE TABLE IF NOT EXISTS stations(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,available INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS checkins(match_id TEXT NOT NULL REFERENCES matches(id),team_id TEXT NOT NULL REFERENCES teams(id),participant_id TEXT NOT NULL REFERENCES participants(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(match_id,team_id));
  CREATE TABLE IF NOT EXISTS disputes(id TEXT PRIMARY KEY,match_id TEXT NOT NULL UNIQUE REFERENCES matches(id),opened_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,resolved_at TEXT);
  CREATE TABLE IF NOT EXISTS substitutions(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),team_id TEXT NOT NULL REFERENCES teams(id),leaving_id TEXT NOT NULL,replacement_id TEXT NOT NULL,reversed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT,details TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
  CREATE INDEX IF NOT EXISTS idx_entries_participant ON event_entries(participant_id);
  `,
  `
  ALTER TABLE cannon_shots ADD COLUMN shooter_id TEXT REFERENCES participants(id);
  CREATE INDEX IF NOT EXISTS idx_cannon_shots_quota ON cannon_shots(team_id,shooter_id,practice);
  `,
  `
  ALTER TABLE events ADD COLUMN completed_at TEXT;
  ALTER TABLE team_members ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE matches ADD COLUMN role TEXT NOT NULL DEFAULT 'STANDARD';
  ALTER TABLE matches ADD COLUMN next_match_id TEXT;
  ALTER TABLE matches ADD COLUMN next_slot TEXT;
  ALTER TABLE matches ADD COLUMN loser_match_id TEXT;
  ALTER TABLE matches ADD COLUMN loser_slot TEXT;
  ALTER TABLE matches ADD COLUMN advancement_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE substitutions ADD COLUMN reversed_at TEXT;
  CREATE TABLE team_rename_proposals(team_id TEXT PRIMARY KEY REFERENCES teams(id),proposer_id TEXT NOT NULL REFERENCES participants(id),name TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `,
  `
  CREATE TABLE cannon_runs(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE cannon_run_assignments(run_id TEXT NOT NULL REFERENCES cannon_runs(id),team_id TEXT NOT NULL REFERENCES teams(id),lane_id TEXT NOT NULL,PRIMARY KEY(run_id,team_id),UNIQUE(run_id,lane_id));
  ALTER TABLE cannon_shots ADD COLUMN run_id TEXT REFERENCES cannon_runs(id);
  ALTER TABLE cannon_shots ADD COLUMN lane_id TEXT;
  ALTER TABLE cannon_shots ADD COLUMN kind TEXT NOT NULL DEFAULT 'scored';
  ALTER TABLE cannon_shots ADD COLUMN sequence INTEGER;
  CREATE UNIQUE INDEX cannon_shot_sequence ON cannon_shots(run_id,team_id,kind,sequence) WHERE run_id IS NOT NULL;
  CREATE TABLE cannon_shootout_shots(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES cannon_runs(id),team_id TEXT NOT NULL REFERENCES teams(id),round INTEGER NOT NULL,points INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(run_id,team_id,round));
  CREATE TABLE acceptance_placements(participant_id TEXT PRIMARY KEY REFERENCES participants(id),cannon INTEGER,field_json TEXT NOT NULL);
  CREATE TABLE backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE idempotency_keys(scope TEXT NOT NULL,key TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(scope,key));
  `,
  `
  CREATE TRIGGER team_member_one_active_event_insert
  BEFORE INSERT ON team_members WHEN NEW.active=1
  BEGIN
    SELECT CASE WHEN EXISTS(
      SELECT 1 FROM team_members tm JOIN teams current_team ON current_team.id=tm.team_id JOIN teams new_team ON new_team.id=NEW.team_id
      WHERE tm.participant_id=NEW.participant_id AND tm.active=1 AND current_team.event_id=new_team.event_id
    ) THEN RAISE(ABORT,'participant already active on an event team') END;
  END;
  CREATE TRIGGER team_member_one_active_event_update
  BEFORE UPDATE OF active ON team_members WHEN NEW.active=1 AND OLD.active<>1
  BEGIN
    SELECT CASE WHEN EXISTS(
      SELECT 1 FROM team_members tm JOIN teams current_team ON current_team.id=tm.team_id JOIN teams new_team ON new_team.id=NEW.team_id
      WHERE tm.participant_id=NEW.participant_id AND tm.active=1 AND current_team.event_id=new_team.event_id AND tm.team_id<>NEW.team_id
    ) THEN RAISE(ABORT,'participant already active on an event team') END;
  END;
  `,
  `
  CREATE TABLE cannon_run_assignments_v2(
    run_id TEXT NOT NULL REFERENCES cannon_runs(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    lane_id TEXT NOT NULL,
    PRIMARY KEY(run_id,team_id)
  );
  INSERT INTO cannon_run_assignments_v2(run_id,team_id,lane_id)
    SELECT run_id,team_id,lane_id FROM cannon_run_assignments;
  DROP TABLE cannon_run_assignments;
  ALTER TABLE cannon_run_assignments_v2 RENAME TO cannon_run_assignments;
  CREATE INDEX idx_cannon_assignments_lane ON cannon_run_assignments(run_id,lane_id);
  `,
  `
  ALTER TABLE events ADD COLUMN play_mode TEXT NOT NULL DEFAULT 'OFFICIAL' CHECK(play_mode IN ('OPENING','OFFICIAL','CASUAL'));
  INSERT OR IGNORE INTO events(id,name,kind,sort_order,play_mode) VALUES
    ('cannon','Junkyard Cannon','CANNON',1,'OPENING'),
    ('ladder-ball','Ladder Ball','HEAD_TO_HEAD',2,'OFFICIAL'),
    ('field-pong','Field Pong','HEAD_TO_HEAD',3,'OFFICIAL'),
    ('cornhole','Cornhole','HEAD_TO_HEAD',4,'OFFICIAL'),
    ('kanjam','KanJam','HEAD_TO_HEAD',5,'OFFICIAL'),
    ('lawn-darts','Lawn Darts','HEAD_TO_HEAD',6,'OFFICIAL'),
    ('bocce-ball','Bocce Ball','HEAD_TO_HEAD',7,'OFFICIAL'),
    ('volley-strike','Volley Strike','HEAD_TO_HEAD',8,'OFFICIAL'),
    ('washers','Washers','HEAD_TO_HEAD',9,'OFFICIAL'),
    ('horseshoes','Horseshoes','HEAD_TO_HEAD',10,'CASUAL'),
    ('badminton','Badminton','HEAD_TO_HEAD',11,'CASUAL');
  UPDATE events SET play_mode='OPENING' WHERE id='cannon';
  ALTER TABLE stations ADD COLUMN event_id TEXT REFERENCES events(id);
  INSERT INTO stations(id,name,event_id) VALUES
    ('station-1','The Crusher','ladder-ball'),
    ('station-2','Scrap Heap Two','field-pong')
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,event_id=excluded.event_id;
  INSERT INTO stations(id,name,event_id) VALUES
    ('station-3','Sack Attack','cornhole'),
    ('station-4','Can Crusher Court','kanjam'),
    ('station-5','Flight Risk','lawn-darts'),
    ('station-6','The Gravel Pit','bocce-ball'),
    ('station-7','Strike Yard','volley-strike'),
    ('station-8','Washer Wreck','washers');
  CREATE UNIQUE INDEX idx_stations_event ON stations(event_id) WHERE event_id IS NOT NULL;
  `,
  `
  ALTER TABLE idempotency_keys ADD COLUMN actor TEXT;
  ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT;
  CREATE UNIQUE INDEX idx_control_idempotency_key ON idempotency_keys(key) WHERE scope LIKE 'control:%';
  `,
  `
  CREATE TABLE photo_uploads(
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    content_hash TEXT NOT NULL UNIQUE CHECK(length(content_hash)=64),
    state TEXT NOT NULL CHECK(state IN ('UPLOADED','PROCESSING','PUBLISHED','PENDING_REVIEW','REJECTED','REMOVED','DELETED')),
    optional_names TEXT CHECK(optional_names IS NULL OR length(optional_names)<=120),
    consent_version TEXT NOT NULL,
    consent_text TEXT NOT NULL,
    consented_at TEXT NOT NULL,
    request_correlation_id TEXT NOT NULL,
    width INTEGER NOT NULL CHECK(width>0),
    height INTEGER NOT NULL CHECK(height>0),
    normalized_path TEXT NOT NULL UNIQUE,
    plaque_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    removed_at TEXT,
    removal_requested_at TEXT,
    deleted_at TEXT,
    moderation_summary TEXT,
    plaque_title TEXT CHECK(plaque_title IS NULL OR length(plaque_title)<=60),
    plaque_caption TEXT CHECK(plaque_caption IS NULL OR length(plaque_caption)<=180),
    constellation_export_state TEXT NOT NULL DEFAULT 'NOT_EXPORTED' CHECK(constellation_export_state IN ('NOT_EXPORTED','EXPORTED','TOMBSTONED'))
  );
  CREATE INDEX idx_photo_uploads_participant_created ON photo_uploads(participant_id,created_at);
  CREATE INDEX idx_photo_uploads_state_created ON photo_uploads(state,created_at);
  CREATE TABLE photo_moderation_events(
    id TEXT PRIMARY KEY,
    photo_id TEXT NOT NULL REFERENCES photo_uploads(id),
    stage TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    verdict TEXT NOT NULL,
    confidence REAL,
    reason_codes TEXT NOT NULL DEFAULT '[]',
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_photo_moderation_photo ON photo_moderation_events(photo_id,created_at);
  CREATE TABLE photo_uploader_bans(
    participant_id TEXT PRIMARY KEY REFERENCES participants(id),
    source_photo_id TEXT REFERENCES photo_uploads(id),
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE photo_wall_settings(
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    rotation_interval_seconds INTEGER NOT NULL DEFAULT 12 CHECK(rotation_interval_seconds BETWEEN 5 AND 60),
    updated_actor TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO photo_wall_settings(id,enabled,rotation_interval_seconds,updated_actor,updated_at)
  VALUES(1,0,12,'migration',CURRENT_TIMESTAMP);
  CREATE TABLE photo_export_events(
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    photo_id TEXT NOT NULL REFERENCES photo_uploads(id),
    content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
    state TEXT NOT NULL CHECK(state IN ('EXPORTED','TOMBSTONE')),
    created_at TEXT NOT NULL,
    UNIQUE(bundle_id,photo_id,state)
  );
  CREATE INDEX idx_photo_export_photo ON photo_export_events(photo_id,created_at);
  `,
  `
  CREATE TABLE photo_external_identities(
    provider TEXT NOT NULL,
    subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),
    participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 24),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(provider,subject_hash)
  );
  `,
  `
  ALTER TABLE cannon_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'quota' CHECK(mode IN ('quota','timed'));
  ALTER TABLE cannon_runs ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 300 CHECK(duration_seconds=300);
  ALTER TABLE cannon_runs ADD COLUMN carnage_bonus INTEGER NOT NULL DEFAULT 50 CHECK(carnage_bonus>=0);
  CREATE TABLE cannon_team_runs(
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES cannon_runs(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ACTIVE','COMPLETE','SAFETY_STOPPED')),
    armed_clear INTEGER NOT NULL DEFAULT 0 CHECK(armed_clear IN (0,1)),
    duration_seconds INTEGER NOT NULL DEFAULT 300 CHECK(duration_seconds=300),
    started_at TEXT,
    deadline_at TEXT,
    ended_at TEXT,
    stop_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id,team_id)
  );
  CREATE UNIQUE INDEX idx_cannon_one_active_team ON cannon_team_runs(run_id) WHERE state='ACTIVE';
  ALTER TABLE cannon_shots ADD COLUMN team_run_id TEXT REFERENCES cannon_team_runs(id);
  CREATE INDEX idx_cannon_shots_team_run ON cannon_shots(team_run_id,sequence);
  `,
];

const seedEvents = [
  ["cannon", "Junkyard Cannon", "CANNON", 1, "OPENING"],
  ["ladder-ball", "Ladder Ball", "HEAD_TO_HEAD", 2, "OFFICIAL"],
  ["field-pong", "Field Pong", "HEAD_TO_HEAD", 3, "OFFICIAL"],
  ["cornhole", "Cornhole", "HEAD_TO_HEAD", 4, "OFFICIAL"],
  ["kanjam", "KanJam", "HEAD_TO_HEAD", 5, "OFFICIAL"],
  ["lawn-darts", "Lawn Darts", "HEAD_TO_HEAD", 6, "OFFICIAL"],
  ["bocce-ball", "Bocce Ball", "HEAD_TO_HEAD", 7, "OFFICIAL"],
  ["volley-strike", "Volley Strike", "HEAD_TO_HEAD", 8, "OFFICIAL"],
  ["washers", "Washers", "HEAD_TO_HEAD", 9, "OFFICIAL"],
  ["horseshoes", "Horseshoes", "HEAD_TO_HEAD", 10, "CASUAL"],
  ["badminton", "Badminton", "HEAD_TO_HEAD", 11, "CASUAL"],
] as const;
const seedStations = [
  ["station-1", "The Crusher", "ladder-ball"],
  ["station-2", "Scrap Heap Two", "field-pong"],
  ["station-3", "Sack Attack", "cornhole"],
  ["station-4", "Can Crusher Court", "kanjam"],
  ["station-5", "Flight Risk", "lawn-darts"],
  ["station-6", "The Gravel Pit", "bocce-ball"],
  ["station-7", "Strike Yard", "volley-strike"],
  ["station-8", "Washer Wreck", "washers"],
] as const;

export function createDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  const seed = db.prepare(
    "INSERT OR IGNORE INTO events(id,name,kind,sort_order,play_mode) VALUES(?,?,?,?,?)",
  );
  const seedStation = db.prepare(
    "INSERT OR IGNORE INTO stations(id,name,event_id) VALUES(?,?,?)",
  );
  db.transaction(() => {
    seedEvents.forEach((e) => seed.run(...e));
    seedStations.forEach((station) => seedStation.run(...station));
  })();
  return db;
}

export function audit(
  db: Db,
  actor: string,
  action: string,
  entityType: string,
  entityId?: string,
  details: unknown = {},
): void {
  db.prepare(
    "INSERT INTO audit_log(id,actor,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    actor,
    action,
    entityType,
    entityId ?? null,
    JSON.stringify(details),
  );
}

export async function backupDatabase(
  db: Db,
  destination: string,
): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  await db.backup(destination);
  const check = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    if (check.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("backup integrity check failed");
  } finally {
    check.close();
  }
  return destination;
}

export async function restoreDatabase(
  source: string,
  destination: string,
  allowedRoot = dirname(resolve(destination)),
): Promise<string> {
  const root = resolve(allowedRoot), sourcePath = resolve(source), destinationPath = resolve(destination);
  if ((!sourcePath.startsWith(`${root}/`) && sourcePath !== root) || (!destinationPath.startsWith(`${root}/`) && destinationPath !== root))
    throw new Error("restore path escapes allowed root");
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporary = `${destinationPath}.restore-${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporary);
    const check = new Database(temporary, { readonly: true });
    try {
      if (check.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error("backup integrity check failed");
    } finally {
      check.close();
    }
    await rename(temporary, destinationPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return destinationPath;
}
