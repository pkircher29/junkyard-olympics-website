import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { backupDatabase, createDatabase } from "../src/db.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as rawHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";

const ORG = { Authorization: "Bearer organizer-a-very-strong-secret" };
let db: any, app: any;
beforeEach(() => {
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] });
});
afterEach(() => db.close());

async function signup(name: string, eventIds: string[] = []) {
  const response = await request(app).post("/api/participants").send({ displayName: name, eventIds });
  expect(response.status).toBe(201);
  return response.body.participant;
}
async function teams(eventId = "ladder-ball", count = 4) {
  const people = [];
  for (let i = 0; i < count; i++) people.push(await signup(`P${i}`, [eventId]));
  const formed = await request(app).post(`/api/events/${eventId}/teams/form`).set(ORG).send({ participantIds: people.map(p => p.id) });
  expect(formed.status).toBe(201);
  return { people, teams: formed.body.teams };
}
const safe = (suffix: string, body: any = {}) => request(app).post(suffix).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: `key-${Math.random()}`, ...body });

function expectSafety(action: string, id: string, beforeBackups = 0) {
  expect(db.prepare("SELECT count(*) n FROM backups").get().n).toBeGreaterThan(beforeBackups);
  const row = db.prepare("SELECT actor,details FROM audit_log WHERE action=? AND entity_id=? ORDER BY rowid DESC LIMIT 1").get(action, id);
  expect(row.actor).toBe("Chris");
  expect(JSON.parse(row.details).reason).toBe("event-day correction");
}

describe("full event-day Control Yard", { timeout: 30_000 }, () => {
  it("edits only one stable-id participant with same-name isolation and activities", async () => {
    const a = await signup("Same Name", ["ladder-ball"]), b = await signup("Same Name", ["field-pong"]);
    expect((await request(app).patch(`/api/organizer/participants/${a.id}`).send({ confirm: true })).status).toBe(401);
    const response = await request(app).patch(`/api/organizer/participants/${a.id}`).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "participant-a", displayName: "Correct Name", active: false, eventIds: ["cornhole"] });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT display_name,active FROM participants WHERE id=?").get(a.id)).toEqual({ display_name: "Correct Name", active: 0 });
    expect(db.prepare("SELECT display_name,active FROM participants WHERE id=?").get(b.id)).toEqual({ display_name: "Same Name", active: 1 });
    expect(db.prepare("SELECT event_id FROM event_entries WHERE participant_id=?").all(a.id)).toEqual([{ event_id: "cornhole" }]);
    expectSafety("control.participant.update", a.id);
    const replay = await request(app).patch(`/api/organizer/participants/${a.id}`).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "participant-a", displayName: "Correct Name", active: false, eventIds: ["cornhole"] });
    expect(replay.status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='control.participant.update'").get().n).toBe(1);
  });

  it("preserves event membership while a participant remains on an active team", async () => {
    const fixture = await teams();
    const participantId = fixture.teams[0].participantIds[0];
    const blocked = await request(app).patch(`/api/organizer/participants/${participantId}`).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "membership-conservation", eventIds: [] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("ACTIVE_TEAM_EVENT_REQUIRED");
    expect(db.prepare("SELECT 1 FROM event_entries WHERE event_id='ladder-ball' AND participant_id=?").get(participantId)).toBeTruthy();
  });

  it("requires called requeue before lineup editing and locks live lineups", async () => {
    const fixture = await teams();
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const match: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' LIMIT 1").get();
    db.prepare("UPDATE matches SET status='CALLED',station_id='station-1' WHERE id=?").run(match.id);
    let blocked = await safe(`/api/organizer/teams/${match.team_a_id}/lineup`, { operation: "REMOVE", participantId: fixture.teams[0].participantIds[0] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe("Requeue this match before editing its lineup");
    expect((await safe(`/api/organizer/matches/${match.id}/requeue`)).status).toBe(200);
    for (const status of ["ACTIVE", "AWAITING_CONFIRMATION", "DISPUTED"]) {
      db.prepare("UPDATE matches SET status=? WHERE id=?").run(status, match.id);
      blocked = await safe(`/api/organizer/teams/${match.team_a_id}/lineup`, { operation: "ADD", participantId: fixture.people[3].id });
      expect(blocked.status, status).toBe(409);
      expect(blocked.body.error.code).toBe("LINEUP_LIVE_LOCKED");
    }
  });

  it("supports rename, move, swap, add and remove while preserving one team per event and a playable roster", async () => {
    const { people, teams: formed } = await teams();
    expect((await safe(`/api/organizer/teams/${formed[0].id}/rename`, { name: "Renamed Team" })).status).toBe(200);
    const outsider = await signup("Outsider", ["ladder-ball"]);
    expect((await safe(`/api/organizer/teams/${formed[0].id}/lineup`, { operation: "ADD", participantId: outsider.id })).status).toBe(200);
    const duplicate = await safe(`/api/organizer/teams/${formed[1].id}/lineup`, { operation: "ADD", participantId: outsider.id });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("PARTICIPANT_ALREADY_ASSIGNED");
    const firstMember = db.prepare("SELECT participant_id id FROM team_members WHERE team_id=? AND active=1 LIMIT 1").get(formed[0].id).id;
    const secondMember = db.prepare("SELECT participant_id id FROM team_members WHERE team_id=? AND active=1 LIMIT 1").get(formed[1].id).id;
    expect((await safe(`/api/organizer/teams/${formed[0].id}/lineup`, { operation: "SWAP", participantId: firstMember, otherParticipantId: secondMember })).status).toBe(200);
    const onlyTwo = db.prepare("SELECT participant_id id FROM team_members WHERE team_id=? AND active=1").all(formed[1].id);
    const blocked = await safe(`/api/organizer/teams/${formed[1].id}/lineup`, { operation: "REMOVE", participantId: onlyTwo[0].id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PLAYABLE_ROSTER_REQUIRED");
  });

  it("preserves Cannon original quotas through backed-up audited substitution replay", async () => {
    const fixture = await teams("cannon");
    const run = await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: fixture.teams.map((team: any) => team.id), laneIds: fixture.teams.map((_: any, index: number) => `Lane ${index + 1}`) });
    expect(run.status).toBe(201);
    const leaving = fixture.teams[0].participantIds[0], replacement = await signup("Cannon replacement", ["cannon"]);
    const body = { confirm: true, reason: "event-day correction", idempotencyKey: "cannon-sub", leavingParticipantId: leaving, replacementParticipantId: replacement.id };
    const first = await request(app).post(`/api/organizer/teams/${fixture.teams[0].id}/substitute`).set(ORG).send(body);
    expect(first.status).toBe(201);
    expect(first.body.substitution.originalQuotasPreserved).toBe(true);
    expect(db.prepare("SELECT active,substitute FROM team_members WHERE team_id=? AND participant_id=?").get(fixture.teams[0].id, leaving)).toEqual({ active: 0, substitute: 0 });
    expect(db.prepare("SELECT active,substitute FROM team_members WHERE team_id=? AND participant_id=?").get(fixture.teams[0].id, replacement.id)).toEqual({ active: 1, substitute: 1 });
    const replay = await request(app).post(`/api/organizer/teams/${fixture.teams[0].id}/substitute`).set(ORG).send(body);
    expect(replay.body).toEqual(first.body);
    expect(db.prepare("SELECT count(*) n FROM substitutions WHERE team_id=?").get(fixture.teams[0].id).n).toBe(1);
    expectSafety("control.team.substitute", fixture.teams[0].id);
  });

  it("requeues/cancels safely and enforces station event binding and occupied close", async () => {
    await teams(); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const match: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' LIMIT 1").get();
    expect((await safe(`/api/organizer/matches/${match.id}/assign-station`, { stationId: "station-2" })).status).toBe(409);
    expect((await safe(`/api/organizer/matches/${match.id}/assign-station`, { stationId: "station-1" })).status).toBe(200);
    db.prepare("UPDATE matches SET status='CALLED' WHERE id=?").run(match.id);
    const close = await request(app).patch("/api/organizer/stations/station-1").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "close", available: false });
    expect(close.status).toBe(409);
    expect(close.body.error.message).toContain("Requeue");
    expect((await safe(`/api/organizer/matches/${match.id}/requeue`)).status).toBe(200);
    expect((await request(app).patch("/api/organizer/stations/station-1").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "close-2", available: false })).status).toBe(200);
    const cancel = await safe(`/api/organizer/matches/${match.id}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("MATCH_CANCEL_BRACKET_UNSAFE");
    expect(db.prepare("SELECT status FROM matches WHERE id=?").get(match.id).status).toBe("PENDING");
  });

  it("regenerates only an unplayed bracket", async () => {
    await teams(); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const before = db.prepare("SELECT id FROM matches WHERE event_id='ladder-ball' ORDER BY rowid").all().map((x: any) => x.id);
    const regenerated = await safe("/api/organizer/events/ladder-ball/bracket/regenerate");
    expect(regenerated.status).toBe(200);
    const after = db.prepare("SELECT id FROM matches WHERE event_id='ladder-ball' ORDER BY rowid").all().map((x: any) => x.id);
    expect(after.length).toBe(before.length);
    expect(after).not.toEqual(before);
    db.prepare("UPDATE matches SET status='CALLED' WHERE id=?").run(after.find((id: string) => !db.prepare("SELECT team_a_id FROM matches WHERE id=?").get(id).team_a_id.startsWith("bye:")));
    const blocked = await safe("/api/organizer/events/ladder-ball/bracket/regenerate");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("BRACKET_PLAY_LOCKED");
  });

  it("corrects a final winner through unstarted downstream slots but rejects started downstream impact", async () => {
    await teams("ladder-ball", 8); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const source: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND round=1 AND next_match_id IS NOT NULL AND team_a_id NOT LIKE 'bye:%' LIMIT 1").get();
    await request(app).post(`/api/matches/${source.id}/complete`).set(ORG).send({ winnerTeamId: source.team_a_id });
    const corrected = await safe(`/api/organizer/matches/${source.id}/correct-result`, { winningTeamId: source.team_b_id });
    expect(corrected.status).toBe(200);
    const slot = source.next_slot === "A" ? "team_a_id" : "team_b_id";
    expect(db.prepare(`SELECT ${slot} value FROM matches WHERE id=?`).get(source.next_match_id).value).toBe(source.team_b_id);
    expectSafety("control.match.correct-result", source.id);
    db.prepare("UPDATE matches SET status='ACTIVE',started_at=CURRENT_TIMESTAMP WHERE id=?").run(source.next_match_id);
    const blocked = await safe(`/api/organizer/matches/${source.id}/correct-result`, { winningTeamId: source.team_a_id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("DOWNSTREAM_MATCH_STARTED");
  });

  it("scopes idempotency to actor and canonical payload and deterministically replays a duplicate race", async () => {
    const person = await signup("Replay");
    const body = { confirm: true, reason: "event-day correction", idempotencyKey: "shared", displayName: "Replay One", active: true, eventIds: [] };
    const [a, b] = await Promise.all([
      request(app).patch(`/api/organizer/participants/${person.id}`).set(ORG).send(body),
      request(app).patch(`/api/organizer/participants/${person.id}`).set(ORG).send(body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='control.participant.update'").get().n).toBe(1);
    const payloadConflict = await request(app).patch(`/api/organizer/participants/${person.id}`).set(ORG).send({ ...body, displayName: "Other" });
    expect(payloadConflict.status).toBe(409);
    expect(payloadConflict.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    const actorConflict = await request(app).patch(`/api/organizer/participants/${person.id}`).set({ Authorization: "Bearer organizer-b-very-strong-secret" }).send(body);
    expect(actorConflict.status).toBe(409);
    expect(actorConflict.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("rejects deactivation that would leave an official team below two players", async () => {
    const fixture = await teams("ladder-ball", 2);
    const id = fixture.people[0].id;
    const response = await request(app).patch(`/api/organizer/participants/${id}`).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "under-two", active: false });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PLAYABLE_ROSTER_REQUIRED");
    expect(db.prepare("SELECT active FROM participants WHERE id=?").get(id).active).toBe(1);
  });

  it("fails closed when lineup participants or substitutes lack authoritative event enrollment", async () => {
    const fixture = await teams();
    const outsider = await signup("Not enrolled");
    for (const [path, body] of [
      [`/api/organizer/teams/${fixture.teams[0].id}/lineup`, { operation: "ADD", participantId: outsider.id }],
      [`/api/organizer/teams/${fixture.teams[0].id}/substitute`, { leavingParticipantId: fixture.teams[0].participantIds[0], replacementParticipantId: outsider.id }],
    ] as const) {
      const response = await safe(path, body);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("EVENT_ENROLLMENT_REQUIRED");
      expect(response.body.error.message).toMatch(/enroll/i);
    }
  });

  it("rejects assigning a match to a live-occupied station", async () => {
    await teams("ladder-ball", 8); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const rows: any[] = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' LIMIT 2").all();
    db.prepare("UPDATE matches SET station_id='station-1',status='ACTIVE',started_at=CURRENT_TIMESTAMP WHERE id=?").run(rows[0].id);
    const response = await safe(`/api/organizer/matches/${rows[1].id}/assign-station`, { stationId: "station-1" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("STATION_OCCUPIED");
    expect(db.prepare("SELECT station_id FROM matches WHERE id=?").get(rows[1].id).station_id).toBeNull();
  });

  it("regenerates a truly unplayed bye bracket from current eligible teams", async () => {
    const fixture = await teams("ladder-ball", 6); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    expect(db.prepare("SELECT 1 FROM matches WHERE event_id='ladder-ball' AND status='FINAL'").get()).toBeTruthy();
    const extra = await signup("Late eligible", ["ladder-ball"]);
    const target = fixture.teams[0];
    await safe(`/api/organizer/teams/${target.id}/lineup`, { operation: "ADD", participantId: extra.id });
    const regenerated = await safe("/api/organizer/events/ladder-ball/bracket/regenerate");
    expect(regenerated.status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM matches WHERE event_id='ladder-ball'").get().n).toBeGreaterThan(0);
    const real = db.prepare("SELECT id FROM matches WHERE event_id='ladder-ball' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' LIMIT 1").get() as any;
    db.prepare("UPDATE matches SET status='CALLED' WHERE id=?").run(real.id);
    expect((await safe("/api/organizer/events/ladder-ball/bracket/regenerate")).body.error.code).toBe("BRACKET_PLAY_LOCKED");
  });

  it("rejects result correction when any loser-edge descendant has started", async () => {
    await teams("ladder-ball", 8); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const source: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND loser_match_id IS NOT NULL AND team_a_id NOT LIKE 'bye:%' LIMIT 1").get();
    await request(app).post(`/api/matches/${source.id}/complete`).set(ORG).send({ winnerTeamId: source.team_a_id });
    db.prepare("UPDATE matches SET status='ACTIVE',started_at=CURRENT_TIMESTAMP WHERE id=?").run(source.loser_match_id);
    const response = await safe(`/api/organizer/matches/${source.id}/correct-result`, { winningTeamId: source.team_b_id });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DOWNSTREAM_MATCH_STARTED");
  });

  it("records structured truthful before and after snapshots on every control audit", async () => {
    const person = await signup("Snapshot");
    await request(app).patch(`/api/organizer/participants/${person.id}`).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "snap", displayName: "After", eventIds: [] });
    const details = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='control.participant.update'").get().details);
    expect(details.before.participants.find((row: any) => row.id === person.id).display_name).toBe("Snapshot");
    expect(details.after.participants.find((row: any) => row.id === person.id).display_name).toBe("After");
  });

  it("corrects station mapped event only for idle official head-to-head targets", async () => {
    const ok = await request(app).patch("/api/organizer/stations/station-1/event").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "map", eventId: "kanjam" });
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT event_id FROM stations WHERE id='station-1'").get().event_id).toBe("kanjam");
    expectSafety("control.station.event", "station-1");
    const casual = await request(app).patch("/api/organizer/stations/station-1/event").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "map-casual", eventId: "horseshoes" });
    expect(casual.status).toBe(409);
  });

  it("allows cancellation only for provably standalone administrative matches", async () => {
    await teams(); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const bracket: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND status='PENDING' LIMIT 1").get();
    const blocked = await safe(`/api/organizer/matches/${bracket.id}/cancel`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("MATCH_CANCEL_BRACKET_UNSAFE");
    expect(db.prepare("SELECT status FROM matches WHERE id=?").get(bracket.id).status).not.toBe("CANCELLED");
  });

  it.each([0, 4, 10])("transfers only the original Cannon member's remaining quota after %i shots", async completed => {
    const fixture = await teams("cannon");
    const team = fixture.teams[0], leaving = team.participantIds[0], other = team.participantIds[1];
    const replacement = await signup(`Replacement ${completed}`, ["cannon"]);
    const run = await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: fixture.teams.map((row: any) => row.id), laneIds: fixture.teams.map((_: any, index: number) => `Lane ${index + 1}`) });
    expect(run.status).toBe(201);
    const runId = run.body.run.id;
    for (let sequence = 1; sequence <= completed; sequence++) expect((await request(app).post(`/api/cannon/runs/${runId}/shots`).set(ORG).send({ teamId: team.id, laneId: "Lane 1", kind: "scored", sequence, shooterId: leaving, targetIds: [] })).status).toBe(201);
    expect((await request(app).post(`/api/organizer/teams/${team.id}/substitute`).set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: `quota-${completed}`, leavingParticipantId: leaving, replacementParticipantId: replacement.id })).status).toBe(201);
    for (let sequence = completed + 1; sequence <= 10; sequence++) expect((await request(app).post(`/api/cannon/runs/${runId}/shots`).set(ORG).send({ teamId: team.id, laneId: "Lane 1", kind: "scored", sequence, shooterId: replacement.id, targetIds: [] })).status).toBe(201);
    const exhausted = await request(app).post(`/api/cannon/runs/${runId}/shots`).set(ORG).send({ teamId: team.id, laneId: "Lane 1", kind: "scored", sequence: 11, shooterId: replacement.id, targetIds: [] });
    expect(exhausted.status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind='scored' AND shooter_id=?").get(runId, team.id, leaving).n).toBe(10);
    for (let sequence = 11; sequence <= 20; sequence++) expect((await request(app).post(`/api/cannon/runs/${runId}/shots`).set(ORG).send({ teamId: team.id, laneId: "Lane 1", kind: "scored", sequence, shooterId: other, targetIds: [] })).status).toBe(201);
    expect(db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind='scored'").get(runId, team.id).n).toBe(20);
  });

  it("rebuilds terminal top-four placements after a corrected final", async () => {
    const fixture = await teams("ladder-ball", 8); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const final: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND role='FINAL'").get();
    const third: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND role='THIRD_PLACE'").get();
    const ids = fixture.teams.slice(0, 4).map((row: any) => row.id);
    db.prepare("UPDATE matches SET team_a_id=?,team_b_id=?,status='FINAL',winner_id=?,reported_winner_id=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(ids[0], ids[1], ids[0], ids[0], final.id);
    db.prepare("UPDATE matches SET team_a_id=?,team_b_id=?,status='FINAL',winner_id=?,reported_winner_id=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(ids[2], ids[3], ids[2], ids[2], third.id);
    db.prepare("UPDATE events SET completed_at=CURRENT_TIMESTAMP WHERE id='ladder-ball'").run();
    const corrected = await safe(`/api/organizer/matches/${final.id}/correct-result`, { winningTeamId: ids[1] });
    expect(corrected.status).toBe(200);
    expect(corrected.body.placementsRebuilt).toBe(true);
    const firstMembers = db.prepare("SELECT participant_id FROM team_members WHERE team_id=? AND active=1").all(ids[1]) as any[];
    for (const member of firstMembers) expect(db.prepare("SELECT place FROM placements WHERE event_id='ladder-ball' AND participant_id=?").get(member.participant_id).place).toBe(1);
    expect(db.prepare("SELECT completed_at FROM events WHERE id='ladder-ball'").get().completed_at).toBeTruthy();
  });

  it("rejects a corrupt backup artifact before any caller can mutate", async () => {
    const root = await mkdtemp(join(tmpdir(), "junkyard-backup-check-")), destination = join(root, "broken.sqlite");
    try {
      const fakeDb = { backup: async (path: string) => { await writeFile(path, "not a sqlite database"); } };
      await expect(backupDatabase(fakeDb as any, destination)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("opens and closes activities but refuses to close one with a live match", async () => {
    let changed = await request(app).patch("/api/organizer/events/ladder-ball/availability").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "event-close", available: false });
    expect(changed.status).toBe(200);
    changed = await request(app).patch("/api/organizer/events/ladder-ball/availability").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "event-open", available: true });
    expect(changed.status).toBe(200);
    await teams(); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const match: any = db.prepare("SELECT id FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' LIMIT 1").get();
    db.prepare("UPDATE matches SET status='CALLED' WHERE id=?").run(match.id);
    const blocked = await request(app).patch("/api/organizer/events/ladder-ball/availability").set(ORG).send({ confirm: true, reason: "event-day correction", idempotencyKey: "event-live", available: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("EVENT_HAS_LIVE_MATCH");
  });

  it("locks both source and destination teams before MOVE", async () => {
    const fixture = await teams("ladder-ball", 8);
    const source = fixture.teams[2], destination = fixture.teams[0], destinationMatchId = "destination-live-match";
    db.prepare("INSERT INTO matches(id,event_id,round,path,role,team_a_id,team_b_id,status) VALUES(?,'ladder-ball',1,'MAIN','STANDARD',?,?,'CALLED')").run(destinationMatchId, destination.id, fixture.teams[1].id);
    const moved = await safe(`/api/organizer/teams/${source.id}/lineup`, { operation: "MOVE", participantId: source.participantIds[0], toTeamId: destination.id });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe("LINEUP_REQUEUE_REQUIRED");
    expect(db.prepare("SELECT active FROM team_members WHERE team_id=? AND participant_id=?").get(source.id, source.participantIds[0]).active).toBe(1);
  });

  it("resolves chained Cannon substitutions to the original quota owner", async () => {
    const fixture = await teams("cannon"), team = fixture.teams[0], original = team.participantIds[0], other = team.participantIds[1];
    const replacementA = await signup("Replacement chain A", ["cannon"]), replacementB = await signup("Replacement chain B", ["cannon"]);
    const run = await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: fixture.teams.map((row: any) => row.id), laneIds: fixture.teams.map((_: any, index: number) => `Lane ${index + 1}`) });
    const runId = run.body.run.id;
    const shot = (sequence: number, shooterId: string) => request(app).post(`/api/cannon/runs/${runId}/shots`).set(ORG).send({ teamId: team.id, laneId: "Lane 1", kind: "scored", sequence, shooterId, targetIds: [] });
    for (let sequence=1; sequence<=4; sequence++) expect((await shot(sequence, original)).status).toBe(201);
    expect((await request(app).post(`/api/organizer/teams/${team.id}/substitute`).set(ORG).send({ confirm:true, reason:"first replacement", idempotencyKey:"chain-a", leavingParticipantId:original, replacementParticipantId:replacementA.id })).status).toBe(201);
    for (let sequence=5; sequence<=6; sequence++) expect((await shot(sequence, replacementA.id)).status).toBe(201);
    expect((await request(app).post(`/api/organizer/teams/${team.id}/substitute`).set(ORG).send({ confirm:true, reason:"second replacement", idempotencyKey:"chain-b", leavingParticipantId:replacementA.id, replacementParticipantId:replacementB.id })).status).toBe(201);
    for (let sequence=7; sequence<=10; sequence++) expect((await shot(sequence, replacementB.id)).status).toBe(201);
    expect((await shot(11, replacementB.id)).status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind='scored' AND shooter_id=?").get(runId, team.id, original).n).toBe(10);
    for (let sequence=11; sequence<=20; sequence++) expect((await shot(sequence, other)).status).toBe(201);
    expect(db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind='scored'").get(runId, team.id).n).toBe(20);
  });

  it("rejects a Cannon substitution that would cycle back to an earlier substitute", async () => {
    const fixture = await teams("cannon"), team = fixture.teams[0], original = team.participantIds[0];
    const replacementA = await signup("Cycle replacement A", ["cannon"]), replacementB = await signup("Cycle replacement B", ["cannon"]);
    expect((await request(app).post(`/api/organizer/teams/${team.id}/substitute`).set(ORG).send({ confirm:true, reason:"first", idempotencyKey:"cycle-a", leavingParticipantId:original, replacementParticipantId:replacementA.id })).status).toBe(201);
    expect((await request(app).post(`/api/organizer/teams/${team.id}/substitute`).set(ORG).send({ confirm:true, reason:"second", idempotencyKey:"cycle-b", leavingParticipantId:replacementA.id, replacementParticipantId:replacementB.id })).status).toBe(201);
    const cycle = await request(app).post(`/api/organizer/teams/${team.id}/substitute`).set(ORG).send({ confirm:true, reason:"cycle", idempotencyKey:"cycle-back", leavingParticipantId:replacementB.id, replacementParticipantId:replacementA.id });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe("SUBSTITUTION_CYCLE");
    expect(db.prepare("SELECT active FROM team_members WHERE team_id=? AND participant_id=?").get(team.id, replacementB.id).active).toBe(1);
  });

  it("releases the mutation queue when a waiting HTTP client disconnects", async () => {
    const originalBackup = db.backup.bind(db);
    let signalStarted!: () => void, releaseBackup!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseBackup = resolve; });
    db.backup = async (destination: string) => { signalStarted(); await held; return originalBackup(destination); };
    const firstPromise = request(app).post("/api/admin/backups").set(ORG).send({});
    void firstPromise.then(() => undefined);
    await started;
    const server = app.listen(0), port = (server.address() as AddressInfo).port;
    await new Promise<void>(resolve => {
      const aborted = rawHttpRequest({ hostname:"127.0.0.1", port, path:"/api/participants", method:"POST", headers:{ "content-type":"application/json" } });
      aborted.on("error", () => undefined);
      aborted.end(JSON.stringify({ displayName:"Disconnected signup", eventIds:[] }));
      setTimeout(() => { aborted.destroy(); resolve(); }, 25);
    });
    releaseBackup();
    expect((await firstPromise).status).toBe(201);
    const third: any = await Promise.race([
      request(app).post("/api/participants").send({ displayName:"Queue recovered", eventIds:[] }),
      new Promise(resolve => setTimeout(() => resolve({ timeout:true }), 750)),
    ]);
    expect(third.timeout).not.toBe(true);
    expect(third.status).toBe(201);
    db.backup = originalBackup;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("keeps the mutation lock until an active disconnected handler finishes", async () => {
    const originalBackup = db.backup.bind(db);
    let signalStarted!: () => void, releaseBackup!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseBackup = resolve; });
    db.backup = async (destination: string) => { signalStarted(); await held; return originalBackup(destination); };
    const server = app.listen(0), port = (server.address() as AddressInfo).port;
    const active = rawHttpRequest({ hostname:"127.0.0.1", port, path:"/api/admin/backups", method:"POST", headers:{ authorization:ORG.Authorization, "content-type":"application/json" } });
    active.on("error", () => undefined);
    active.end("{}");
    await started;
    active.destroy();
    const thirdPromise = request(app).post("/api/participants").send({ displayName:"Waited for active backup", eventIds:[] });
    const tracked = thirdPromise.then(response => ({ response }));
    const early: any = await Promise.race([tracked, new Promise(resolve => setTimeout(() => resolve({ timeout:true }), 100))]);
    expect(early.timeout).toBe(true);
    releaseBackup();
    const recovered: any = await Promise.race([tracked, new Promise(resolve => setTimeout(() => resolve({ timeout:true }), 750))]);
    expect(recovered.timeout).not.toBe(true);
    expect(recovered.response.status).toBe(201);
    db.backup = originalBackup;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("serializes different-key control mutations so backups and before snapshots are immediately truthful", async () => {
    const person = await signup("Concurrent original", ["ladder-ball"]);
    const mutate = (name: string, key: string) => request(app).patch(`/api/organizer/participants/${person.id}`).set(ORG).send({ confirm:true, reason:`rename to ${name}`, idempotencyKey:key, displayName:name, active:true, eventIds:["ladder-ball"] });
    const responses = await Promise.all([mutate("Concurrent alpha", "entity-race-a"), mutate("Concurrent beta", "entity-race-b")]);
    expect(responses.map(response => response.status)).toEqual([200,200]);
    const audits = (db.prepare("SELECT details FROM audit_log WHERE action='control.participant.update' AND entity_id=? ORDER BY rowid").all(person.id) as any[]).map(row => JSON.parse(row.details));
    expect(audits).toHaveLength(2);
    expect(audits[0].before.participants[0].display_name).toBe("Concurrent original");
    expect(audits[1].before.participants[0].display_name).toBe(audits[0].after.participants[0].display_name);
    for (const auditEntry of audits) {
      const backup: any = db.prepare("SELECT path FROM backups WHERE id=?").get(auditEntry.backupId);
      const backupDb = createDatabase(backup.path);
      const backupParticipant: any = backupDb.prepare("SELECT display_name FROM participants WHERE id=?").get(person.id);
      expect(backupParticipant.display_name).toBe(auditEntry.before.participants[0].display_name);
      backupDb.close();
    }
  });

  it("distributes six-team BYEs across separate semifinal branches on create and regenerate", async () => {
    await teams("ladder-ball", 12); await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const byeBranches = () => (db.prepare("SELECT DISTINCT next_match_id FROM matches WHERE event_id='ladder-ball' AND path='MAIN' AND round=1 AND (team_a_id LIKE 'bye:%' OR team_b_id LIKE 'bye:%')").all() as any[]).map(row => row.next_match_id);
    expect(byeBranches()).toHaveLength(2);
    const regenerated = await safe("/api/organizer/events/ladder-ball/bracket/regenerate");
    expect(regenerated.status).toBe(200);
    expect(byeBranches()).toHaveLength(2);
  });

  it("exposes exact-value final confirmations, mapped-event correction, and no unsafe bracket cancel UI", () => {
    const html = readFileSync(new URL("../public/organizer.html", import.meta.url), "utf8");
    const js = readFileSync(new URL("../public/js/organizer-console.js", import.meta.url), "utf8");
    for (const id of ["participant-search", "team-event-filter", "control-participants", "control-teams", "control-matches", "control-stations", "bracket-regenerate"]) expect(html).toContain(`id="${id}"`);
    for (const route of ["/api/organizer/participants/", "/api/organizer/teams/", "/api/organizer/matches/", "/api/organizer/stations/", "/bracket/regenerate", "/event"]) expect(js).toContain(route);
    expect(js).toContain("Final confirmation");
    expect(js).toContain("displayName: ${nextName}");
    expect(js).toContain("eventIds: ${eventIds.join(', ')}");
    const teamHandler = js.slice(js.indexOf("q('#teams').addEventListener"), js.indexOf("q('#matches').addEventListener"));
    expect(teamHandler.indexOf("New team name:")).toBeLessThan(teamHandler.indexOf("const reason = confirmReason"));
    expect(js).not.toContain('data-action="cancel"');
    expect(`${html}\n${js}`).not.toMatch(/raw sql|database editor|status dropdown/i);
  });
});
