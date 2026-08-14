import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
let db: any, app: any;
beforeEach(() => {
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] });
});
afterEach(() => db.close());
const org = { Authorization: "Bearer organizer-a-very-strong-secret" };
async function signup(name: string) {
  const r = await request(app)
    .post("/api/participants")
    .send({ displayName: name });
  expect(r.status).toBe(201);
  return r.body;
}
async function seed(n = 4) {
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(await signup(`Player ${i}`));
  return ps;
}
describe("foundation", () => {
  it("migrates/seeds idempotently and reports health", async () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(0);
    expect(db.prepare("select count(*) n from events").get().n).toBe(11);
    expect((await request(app).get("/health")).body.ok).toBe(true);
  });

  it("serves the integrated UI surfaces and API health route", async () => {
    for (const path of ["/", "/organizer", "/tv", "/print", "/station/station-1"])
      expect((await request(app).get(path).set("Accept", "text/html")).type).toBe("text/html");
    expect((await request(app).get("/api/health")).body.ok).toBe(true);
    expect((await request(app).get("/styles.css")).type).toContain("text/css");
  });

  it("aggregates public state in the shape consumed by the browser UI", async () => {
    await signup("State Player");
    const state = (await request(app).get("/api/state")).body;
    expect(state.participants).toHaveLength(1);
    expect(state.events).toHaveLength(11);
    expect(state).toMatchObject({ teams: [], matches: [] });
    expect(state.stations).toHaveLength(8);
    expect(state).toMatchObject({ cannonRuns: [], cannonAssignments: [], targets: [], teamMembers: [], cannonShots: [], flairFeed: [] });
    expect(JSON.stringify(state)).not.toContain("token_hash");
  });

  it("exposes safe authoritative TV fields for calls, Cannon progress, and Flair feed", async () => {
    const [a, b] = await seed(2);
    db.prepare("insert into teams(id,event_id,name) values('ta','ladder-ball','Axles'),('tb','ladder-ball','Bearings'),('tc','cannon','Clankers')").run();
    db.prepare("insert into team_members(team_id,participant_id) values('ta',?),('tb',?)").run(a.participant.id, b.participant.id);
    db.prepare("insert into matches(id,event_id,team_a_id,team_b_id,status,station_id,called_at,started_at) values('m-tv','ladder-ball','ta','tb','ACTIVE','station-1','2026-08-15T18:00:00.000Z','2026-08-15T18:01:00.000Z')").run();
    db.prepare("insert into cannon_runs(id,event_id,created_at) values('r-tv','cannon','2026-08-15T17:00:00.000Z')").run();
    db.prepare("insert into cannon_run_assignments(run_id,team_id,lane_id) values('r-tv','tc','lane-1')").run();
    db.prepare("insert into targets(id,event_id,name,points) values('hubcap','cannon','Hubcap',25)").run();
    db.prepare("insert into cannon_shots(id,event_id,team_id,practice,carnage,points,run_id,lane_id,kind,sequence) values('shot-tv','cannon','tc',0,0,25,'r-tv','lane-1','scored',1)").run();
    db.prepare("insert into cannon_shot_targets(shot_id,target_id,points) values('shot-tv','hubcap',25)").run();
    await request(app).post("/api/flair/props").set("Authorization", `Bearer ${a.token}`).send({ recipientId: b.participant.id, category: "BEST_COSTUME" });

    const state = (await request(app).get("/api/state")).body;
    expect(state.matches[0]).toMatchObject({ id: "m-tv", calledAt: "2026-08-15T18:00:00.000Z", startedAt: "2026-08-15T18:01:00.000Z" });
    expect(state.cannonShots[0]).toMatchObject({ runId: "r-tv", laneId: "lane-1", kind: "scored", sequence: 1, points: 25, targetNames: ["Hubcap"] });
    expect(state.flairFeed[0]).toMatchObject({ recipientDisplayName: "Player 1", category: "BEST_COSTUME" });
    expect(JSON.stringify(state)).not.toMatch(/token|giverId/i);
  });
});
describe("identity/events/flair", () => {
  it("rejects weak or duplicate organizer credentials", () => {
    expect(() => createApp({ db, organizerTokens: ["x", "different-but-still-strong-secret"] })).toThrow();
    expect(() => createApp({ db, organizerTokens: ["same-organizer-secret-123456", "same-organizer-secret-123456"] })).toThrow();
  });
  it("rejects mutations after a participant departs", async () => {
    const [a, b] = await seed(2);
    await request(app).post("/api/me/depart").set("Authorization", `Bearer ${a.token}`);
    expect((await request(app).post("/api/flair/props").set("Authorization", `Bearer ${a.token}`).send({ recipientId: b.participant.id, category: "BEST_COSTUME" })).status).toBe(403);
  });
  it("exposes roster and supports bounded participant self updates", async () => {
    const p = await signup("Before");
    expect((await request(app).get("/api/participants")).body.participants[0].displayName).toBe("Before");
    const changed = await request(app)
      .patch("/api/me")
      .set("Authorization", `Bearer ${p.token}`)
      .send({ displayName: "After", active: false });
    expect(changed.status).toBe(200);
    expect(changed.body.participant).toMatchObject({ displayName: "After", active: 0 });
    expect((await request(app).patch("/api/me").set("Authorization", `Bearer ${p.token}`).send({ displayName: "x".repeat(61) })).status).toBe(403);
  });

  it("supports UI-compatible event membership and departure aliases", async () => {
    const p = await signup("Alias Player");
    const event = db.prepare("select id from events where kind='HEAD_TO_HEAD' limit 1").get();
    expect((await request(app).put(`/api/events/${event.id}/participants/me`).set("Authorization", `Bearer ${p.token}`)).status).toBe(200);
    expect((await request(app).get(`/api/events/${event.id}`)).body.event.participantIds).toContain(p.participant.id);
    expect((await request(app).delete(`/api/events/${event.id}/participants/me`).set("Authorization", `Bearer ${p.token}`)).status).toBe(204);
    expect((await request(app).post("/api/participants/me/departure").set("Authorization", `Bearer ${p.token}`)).status).toBe(200);
  });

  it("deactivates only the selected accidental signup with backup and audit", async () => {
    const first = await signup("Same Name"), second = await signup("Same Name");
    expect((await request(app).post(`/api/organizer/participants/${first.participant.id}/deactivate`).send({ confirm: true })).status).toBe(401);
    const response = await request(app).post(`/api/organizer/participants/${first.participant.id}/deactivate`).set(org).send({ confirm: true });
    expect(response.status).toBe(200);
    expect(response.body.participant).toMatchObject({ id: first.participant.id, active: 0 });
    expect(db.prepare("SELECT active FROM participants WHERE id=?").get(first.participant.id).active).toBe(0);
    expect(db.prepare("SELECT active FROM participants WHERE id=?").get(second.participant.id).active).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM backups").get().n).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='participant.deactivate' AND entity_id=?").get(first.participant.id).n).toBe(1);
    expect((await request(app).post(`/api/organizer/participants/${first.participant.id}/deactivate`).set(org).send({ confirm: true })).status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM backups").get().n).toBe(1);
  });

  it("rate limits signup bursts with a stable error and Retry-After", async () => {
    let limited: any;
    for (let i = 0; i < 40; i++) {
      const response = await request(app).post("/api/participants").send({ displayName: `Burst ${i}` });
      if (response.status === 429) { limited = response; break; }
    }
    expect(limited?.headers["retry-after"]).toBeTruthy();
    expect(limited?.body.error.code).toBe("RATE_LIMITED");
  });
  it("restores identity and joins/leaves events", async () => {
    const p = await signup("Alex");
    expect(
      (
        await request(app)
          .get("/api/me")
          .set("Authorization", `Bearer ${p.token}`)
      ).body.participant.id,
    ).toBe(p.participant.id);
    const e = db
      .prepare("select id from events where kind='HEAD_TO_HEAD' limit 1")
      .get();
    expect(
      (
        await request(app)
          .post(`/api/events/${e.id}/join`)
          .set("Authorization", `Bearer ${p.token}`)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .delete(`/api/events/${e.id}/join`)
          .set("Authorization", `Bearer ${p.token}`)
      ).status,
    ).toBe(204);
  });
  it("enforces flair rules and final vote worth 3", async () => {
    const [a, b] = await seed(2);
    expect(
      (
        await request(app)
          .post("/api/flair/props")
          .set("Authorization", `Bearer ${a.token}`)
          .send({ recipientId: a.participant.id, category: "BEST_COSTUME" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/flair/props")
          .set("Authorization", `Bearer ${a.token}`)
          .send({ recipientId: b.participant.id, category: "BEST_COSTUME" })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post("/api/flair/props")
          .set("Authorization", `Bearer ${a.token}`)
          .send({ recipientId: b.participant.id, category: "BEST_COSTUME" })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post("/api/flair/vote")
          .set("Authorization", `Bearer ${a.token}`)
          .send({ recipientId: b.participant.id })
      ).status,
    ).toBe(201);
    expect(
      (await request(app).get("/api/flair/standings")).body[0].points,
    ).toBe(4);
  });
  it("accepts every Flair option shown on the participant page", async () => {
    const [giver, recipient] = await seed(2);
    const labels = [
      "Best Costume", "Epic Entrance", "Creative Trash Talk", "Spectacular Failure",
      "Unnecessary Showmanship", "Junkyard Ingenuity", "Great Sportsmanship", "Spectacular Destruction",
    ];
    for (const category of labels) {
      const response = await request(app).post("/api/flair/props")
        .set("Authorization", `Bearer ${giver.token}`)
        .send({ recipientId: recipient.participant.id, category });
      expect(response.status, category).toBe(201);
    }
    expect((await request(app).get("/api/flair/standings")).body[0].propPoints).toBe(8);
  });
});
describe("teams/cannon/standings", () => {
  it("exposes acceptance event kinds and forms teams from an explicit participant pool", async () => {
    const ps = await seed(4);
    const events = (await request(app).get("/api/events")).body.events;
    expect(events.find((event: any) => event.id === "cannon").kind).toBe("cannon");
    expect(events.find((event: any) => event.id === "ladder-ball").kind).toBe("head-to-head");
    const formed = await request(app)
      .post("/api/events/cannon/teams/form")
      .set(org)
      .send({ participantIds: ps.map((p) => p.participant.id) });
    expect(formed.status).toBe(201);
    expect(formed.body.teams).toHaveLength(2);
    expect(new Set(formed.body.teams.flatMap((team: any) => team.participantIds))).toEqual(
      new Set(ps.map((p) => p.participant.id)),
    );
  });

  it("supports the Cannon run, target, idempotent shot and standings contract", async () => {
    const ps = await seed(4);
    const teams = (await request(app).post("/api/events/cannon/teams/form").set(org)
      .send({ participantIds: ps.map((p) => p.participant.id) })).body.teams;
    const targets = await request(app).post("/api/cannon/targets").set(org).send({
      targets: [{ name: "Can", points: 10 }, { name: "Washer", points: 1000000, jackpot: true }],
    });
    expect(targets.status).toBe(201);
    const run = await request(app).post("/api/cannon/runs").set(org).send({
      eventId: "cannon", teamIds: teams.map((team: any) => team.id), laneIds: ["lane-1", "lane-2"],
    });
    expect(run.status).toBe(201);
    expect(run.body.run.assignments).toHaveLength(2);
    const shot = { teamId: teams[0].id, laneId: "lane-1", kind: "scored", sequence: 1, targetIds: [targets.body.targets[0].id] };
    expect((await request(app).post(`/api/cannon/runs/${run.body.run.id}/shots`).set(org).send(shot)).body.shot.total).toBe(10);
    expect((await request(app).post(`/api/cannon/runs/${run.body.run.id}/shots`).set(org).send(shot)).status).toBe(200);
    expect((await request(app).get(`/api/cannon/runs/${run.body.run.id}/shots`).set(org)).body.shots).toHaveLength(1);
    expect((await request(app).get(`/api/cannon/runs/${run.body.run.id}/standings`)).body.standings[0].teamId).toBe(teams[0].id);
    const state = (await request(app).get("/api/state")).body;
    expect(state.cannonRuns).toContainEqual(expect.objectContaining({ id: run.body.run.id, eventId: "cannon" }));
    expect(state.cannonAssignments).toContainEqual(expect.objectContaining({ runId: run.body.run.id, teamId: teams[0].id, laneId: "lane-1" }));
    expect(state.targets).toContainEqual(expect.objectContaining({ id: targets.body.targets[0].id, eventId: "cannon" }));
    expect(state.teamMembers).toContainEqual(expect.objectContaining({ teamId: teams[0].id, participantId: teams[0].participantIds[0] }));
  });

  it("honors a valid explicitly selected Cannon run shooter", async () => {
    const ps = await seed(2);
    const team = (await request(app).post("/api/events/cannon/teams/form").set(org).send({ participantIds: ps.map(p => p.participant.id) })).body.teams[0];
    const target = (await request(app).post("/api/cannon/targets").set(org).send({ targets: [{ name: "Drum", points: 7 }] })).body.targets[0];
    const run = (await request(app).post("/api/cannon/runs").set(org).send({ eventId: "cannon", teamIds: [team.id], laneIds: ["lane-a"] })).body.run;
    const shooterId = team.participantIds[1];
    const response = await request(app).post(`/api/cannon/runs/${run.id}/shots`).set(org).send({ teamId: team.id, shooterId, laneId: "lane-a", kind: "scored", sequence: 1, targetIds: [target.id] });
    expect(response.status).toBe(201);
    expect(db.prepare("SELECT shooter_id shooterId FROM cannon_shots WHERE id=?").get(response.body.shot.id).shooterId).toBe(shooterId);
  });
  it("lists eight event-bound stations and accepts Cannon lane-compatible scoring", async () => {
    const stations = (await request(app).get("/api/stations")).body.stations;
    expect(stations).toHaveLength(8);
    const ps = await seed(2);
    const e = db.prepare("select id from events where kind='CANNON'").get();
    for (const p of ps)
      await request(app)
        .post(`/api/events/${e.id}/join`)
        .set("Authorization", `Bearer ${p.token}`);
    const team = (
      await request(app).post(`/api/events/${e.id}/teams/form`).set(org)
    ).body.teams[0];
    const shot = await request(app)
      .post("/api/cannon/lanes/lane-1/shots")
      .set(org)
      .send({
        eventId: e.id,
        teamId: team.id,
        shooterId: team.members[0].id,
        targetIds: [],
        kind: "scored",
        sequence: 1,
      });
    expect(shot.status).toBe(201);
    expect(shot.body).toMatchObject({
      laneId: "lane-1",
      teamId: team.id,
      total: 0,
    });
  });

  it("forms pairs and a trio without dropping anyone", async () => {
    const ps = await seed(5);
    const e = db
      .prepare("select id from events where kind='HEAD_TO_HEAD' limit 1")
      .get();
    for (const p of ps)
      await request(app)
        .post(`/api/events/${e.id}/join`)
        .set("Authorization", `Bearer ${p.token}`);
    const r = await request(app)
      .post(`/api/events/${e.id}/teams/form`)
      .set(org);
    expect(r.status).toBe(201);
    expect(r.body.teams.flatMap((x: any) => x.members).length).toBe(5);
    expect(r.body.teams.some((x: any) => x.members.length === 3)).toBe(true);
  });
  it("scores multi-target cannon shots, carnage and jackpot ranking", async () => {
    const ps = await seed(4);
    const e = db.prepare("select id from events where kind='CANNON'").get();
    for (const p of ps)
      await request(app)
        .post(`/api/events/${e.id}/join`)
        .set("Authorization", `Bearer ${p.token}`);
    const teams = (
      await request(app).post(`/api/events/${e.id}/teams/form`).set(org)
    ).body.teams;
    const t1 = (
      await request(app)
        .post(`/api/events/${e.id}/targets`)
        .set(org)
        .send({ name: "Can", points: 10 })
    ).body;
    const t2 = (
      await request(app)
        .post(`/api/events/${e.id}/targets`)
        .set(org)
        .send({ name: "Washer", points: 1000000, jackpot: true })
    ).body;
    expect(
      (
        await request(app)
          .post(`/api/events/${e.id}/teams/${teams[0].id}/shots`)
          .set(org)
          .send({ targetIds: [t1.id], shooterId: teams[0].members[0].id, carnage: true, carnageConfirmed: true })
      ).body.points,
    ).toBe(60);
    await request(app)
      .post(`/api/events/${e.id}/teams/${teams[1].id}/shots`)
      .set(org)
      .send({ targetIds: [t2.id], shooterId: teams[1].members[0].id });
    const ranking = (
      await request(app).get(`/api/events/${e.id}/cannon/standings`)
    ).body;
    expect(ranking[0].teamId).toBe(teams[1].id);
    expect(ranking[0].jackpot).toBe(true);
  });
  it("counts a stacked Cannon shot once and enforces team/member shot quotas", async () => {
    const ps = await seed(4);
    const cannon = db.prepare("select id from events where kind='CANNON'").get();
    const foreign = db.prepare("select id from events where kind='HEAD_TO_HEAD' limit 1").get();
    for (const p of ps) {
      await request(app).post(`/api/events/${cannon.id}/join`).set("Authorization", `Bearer ${p.token}`);
      await request(app).post(`/api/events/${foreign.id}/join`).set("Authorization", `Bearer ${p.token}`);
    }
    const cannonTeam = (await request(app).post(`/api/events/${cannon.id}/teams/form`).set(org)).body.teams[0];
    const foreignTeam = (await request(app).post(`/api/events/${foreign.id}/teams/form`).set(org)).body.teams[0];
    const a = (await request(app).post(`/api/events/${cannon.id}/targets`).set(org).send({ name: "A", points: 10 })).body;
    const b = (await request(app).post(`/api/events/${cannon.id}/targets`).set(org).send({ name: "B", points: 20 })).body;
    expect((await request(app).post(`/api/events/${cannon.id}/teams/${foreignTeam.id}/shots`).set(org).send({ shooterId: foreignTeam.members[0].id, targetIds: [] })).status).toBe(400);
    const outsider = ps.find(p => !cannonTeam.members.some((m: any) => m.id === p.participant.id))!;
    expect((await request(app).post(`/api/events/${cannon.id}/teams/${cannonTeam.id}/shots`).set(org).send({ shooterId: outsider.participant.id, targetIds: [] })).status).toBe(400);
    expect((await request(app).post(`/api/events/${cannon.id}/teams/${cannonTeam.id}/shots`).set(org).send({ shooterId: cannonTeam.members[0].id, targetIds: [a.id, b.id] })).status).toBe(201);
    expect((await request(app).get(`/api/events/${cannon.id}/cannon/standings`)).body.find((x: any) => x.teamId === cannonTeam.id).total).toBe(30);
    for (let i = 1; i < 10; i++) expect((await request(app).post(`/api/events/${cannon.id}/teams/${cannonTeam.id}/shots`).set(org).send({ shooterId: cannonTeam.members[0].id, targetIds: [] })).status).toBe(201);
    expect((await request(app).post(`/api/events/${cannon.id}/teams/${cannonTeam.id}/shots`).set(org).send({ shooterId: cannonTeam.members[0].id, targetIds: [] })).status).toBe(409);
  });
  it("counts cannon plus best three fields and eligibility", async () => {
    const [p] = await seed(1);
    for (const [i, kind] of [
      "CANNON",
      "HEAD_TO_HEAD",
      "HEAD_TO_HEAD",
      "HEAD_TO_HEAD",
      "HEAD_TO_HEAD",
    ].entries()) {
      const id = `x${i}`;
      db.prepare(
        "insert into events(id,name,kind,sort_order) values(?,?,?,?)",
      ).run(id, id, kind, i + 20);
      db.prepare("update events set completed_at=CURRENT_TIMESTAMP where id=?").run(id);
      db.prepare(
        "insert into placements(event_id,participant_id,place,points) values(?,?,?,?)",
      ).run(id, p.participant.id, i + 1, [10, 7, 5, 3, 1][i]);
    }
    const row = (
      await request(app).get("/api/standings/championship")
    ).body.standings.find((x: any) => x.participantId === p.participant.id);
    expect(row.total).toBe(25);
    expect(row.eligible).toBe(true);
    expect(row.dropped).toEqual([1]);
  });
});
describe("brackets/results/scheduling", () => {
  it("exposes bracket, result-confirmation and scheduler acceptance aliases", async () => {
    const ps = await seed(8);
    const formed = await request(app).post("/api/events/ladder-ball/teams/form").set(org)
      .send({ participantIds: ps.map((p) => p.participant.id) });
    const created = await request(app).post("/api/events/ladder-ball/bracket").set(org)
      .send({ teamIds: formed.body.teams.map((team: any) => team.id) });
    expect(created.body.bracket.mainMatches.filter((match: any) => match.round === 1)).toHaveLength(2);
    expect(created.body.bracket.consolationMatches.length).toBeGreaterThan(0);
    const match = created.body.bracket.mainMatches[0];
    const reporter = ps.find((p) => match.teamIds[0] && match.participantIds.includes(p.participant.id))!;
    const reportingTeam = formed.body.teams.find((team: any) => team.participantIds.includes(reporter.participant.id));
    const opponent = ps.find((p) => match.participantIds.includes(p.participant.id) && !reportingTeam.participantIds.includes(p.participant.id))!;
    db.prepare("UPDATE matches SET status='ACTIVE' WHERE id=?").run(match.id);
    expect((await request(app).post(`/api/matches/${match.id}/result-reports`).set("Authorization", `Bearer ${reporter.token}`).send({ winnerTeamId: reportingTeam.id, idempotencyKey: "report-1" })).status).toBe(201);
    expect((await request(app).post(`/api/matches/${match.id}/result-confirmations`).set("Authorization", `Bearer ${opponent.token}`).send({ agree: true, idempotencyKey: "confirm-1" })).status).toBe(200);
    expect((await request(app).get(`/api/matches/${match.id}`)).body.match).toMatchObject({ status: "confirmed", winnerTeamId: reportingTeam.id, advancementCount: 1 });
    const called = await request(app).post("/api/schedule/call-next").set(org).send({ stationId: "station-1", now: new Date().toISOString() });
    expect(called.status).toBe(200);
  });

  it("exposes completion, tick and automatic substitution aliases", async () => {
    const ps = await seed(5);
    const teams = (await request(app).post("/api/events/ladder-ball/teams/form").set(org).send({ participantIds: ps.slice(0, 4).map((p) => p.participant.id) })).body.teams;
    const bracket = (await request(app).post("/api/events/ladder-ball/bracket").set(org).send({ teamIds: teams.map((team: any) => team.id) })).body.bracket;
    const match = bracket.mainMatches[0];
    expect((await request(app).post(`/api/matches/${match.id}/complete`).set(org).send({ winnerTeamId: match.teamIds[0], completedAt: new Date().toISOString() })).status).toBe(200);
    await request(app).post("/api/participants/me/departure").set("Authorization", `Bearer ${ps[0].token}`);
    const sub = await request(app).post(`/api/matches/${match.id}/substitutions/auto`).set(org);
    expect(sub.body.substitution).toMatchObject({ reversible: true, public: true });
  });
  it("advances confirmed winners into the next main-bracket round", async () => {
    const ps = await seed(16);
    const e = db
      .prepare("select id from events where kind='HEAD_TO_HEAD' limit 1")
      .get();
    for (const p of ps)
      await request(app)
        .post(`/api/events/${e.id}/join`)
        .set("Authorization", `Bearer ${p.token}`);
    await request(app).post(`/api/events/${e.id}/teams/form`).set(org);
    const firstRound = (
      await request(app).post(`/api/events/${e.id}/bracket`).set(org)
    ).body.matches;
    expect(firstRound).toHaveLength(4);
    for (const match of firstRound.slice(0, 2)) {
      db.prepare("UPDATE matches SET status='ACTIVE' WHERE id=?").run(match.id);
      const reporter = ps.find((p) =>
        match.teamA.participantIds.includes(p.participant.id),
      );
      const opponent = ps.find((p) =>
        match.teamB.participantIds.includes(p.participant.id),
      );
      await request(app)
        .post(`/api/matches/${match.id}/report`)
        .set("Authorization", `Bearer ${reporter.token}`)
        .send({ winningTeamId: match.teamA.id });
      await request(app)
        .post(`/api/matches/${match.id}/confirm`)
        .set("Authorization", `Bearer ${opponent.token}`)
        .send({ agree: true });
    }
    const semifinal = db
      .prepare("select * from matches where event_id=? and round=2")
      .get(e.id);
    expect(semifinal).toMatchObject({ status: "PENDING" });
  });
  it("creates bracket, confirms only by opponent and disputes freeze", async () => {
    const ps = await seed(4);
    const e = db
      .prepare("select id from events where kind='HEAD_TO_HEAD' limit 1")
      .get();
    for (const p of ps)
      await request(app)
        .post(`/api/events/${e.id}/join`)
        .set("Authorization", `Bearer ${p.token}`);
    await request(app).post(`/api/events/${e.id}/teams/form`).set(org);
    const bracket = (
      await request(app).post(`/api/events/${e.id}/bracket`).set(org)
    ).body;
    const m = bracket.matches[0];
    const reporter = ps.find((p) =>
      m.teamA.participantIds.includes(p.participant.id),
    );
    const opponent = ps.find((p) =>
      m.teamB.participantIds.includes(p.participant.id),
    );
    const winningTeamId = m.teamA.id;
    db.prepare("UPDATE matches SET status='ACTIVE' WHERE id=?").run(m.id);
    expect(
      (
        await request(app)
          .post(`/api/matches/${m.id}/report`)
          .set("Authorization", `Bearer ${reporter.token}`)
          .send({ winningTeamId })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post(`/api/matches/${m.id}/confirm`)
          .set("Authorization", `Bearer ${reporter.token}`)
          .send({ agree: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/matches/${m.id}/confirm`)
          .set("Authorization", `Bearer ${opponent.token}`)
          .send({ agree: false })
      ).status,
    ).toBe(409);
    expect(
      db.prepare("select status from matches where id=?").get(m.id).status,
    ).toBe("DISPUTED");
  });
  it("rejects check-in outside CALLED and enforces the full five-minute timeout", async () => {
    const ps = await seed(4);
    const e = db.prepare("select id from events where kind='HEAD_TO_HEAD' limit 1").get();
    for (const p of ps) await request(app).post(`/api/events/${e.id}/join`).set("Authorization", `Bearer ${p.token}`);
    await request(app).post(`/api/events/${e.id}/teams/form`).set(org);
    const match = (await request(app).post(`/api/events/${e.id}/bracket`).set(org)).body.matches[0];
    expect((await request(app).post(`/api/matches/${match.id}/check-in`).set("Authorization", `Bearer ${ps[0].token}`)).status).toBe(409);
    db.prepare("update matches set status='CALLED',called_at=? where id=?").run(new Date().toISOString(), match.id);
    expect((await request(app).post(`/api/matches/${match.id}/timeout`).set(org)).status).toBe(409);
    db.prepare("update matches set called_at=? where id=?").run(new Date(Date.now() - 300001).toISOString(), match.id);
    expect((await request(app).post(`/api/matches/${match.id}/check-in`).set("Authorization", `Bearer ${ps[0].token}`)).status).toBe(409);
    expect((await request(app).post(`/api/matches/${match.id}/timeout`).set(org)).status).toBe(200);
    db.prepare("update matches set status='FINAL' where id=?").run(match.id);
    expect((await request(app).post(`/api/matches/${match.id}/check-in`).set("Authorization", `Bearer ${ps[0].token}`)).status).toBe(409);
    expect(db.prepare("select status from matches where id=?").get(match.id).status).toBe("FINAL");
  });
  it("prevents double booking, supports checkins, timeout and cooldown", async () => {
    const ps = await seed(4);
    const events = db
      .prepare("select id from events where kind='HEAD_TO_HEAD' limit 2")
      .all();
    for (const e of events) {
      for (const p of ps)
        await request(app)
          .post(`/api/events/${e.id}/join`)
          .set("Authorization", `Bearer ${p.token}`);
      await request(app).post(`/api/events/${e.id}/teams/form`).set(org);
      await request(app).post(`/api/events/${e.id}/bracket`).set(org);
    }
    const station = (await request(app).get("/api/stations")).body.stations.find((item: any) => item.eventId === events[0].id);
    expect(station).toBeTruthy();
    const first = (
      await request(app).post(`/api/stations/${station.id}/call-next`).set(org)
    ).body;
    expect(first.match).toBeTruthy();
    const second = (
      await request(app).post(`/api/stations/${station.id}/call-next`).set(org)
    ).body;
    expect(second.match?.id).not.toBe(first.match.id);
    await request(app)
      .post(`/api/matches/${first.match.id}/check-in`)
      .set("Authorization", `Bearer ${ps[0].token}`);
    db.prepare("update matches set called_at=? where id=?").run(new Date(Date.now() - 300001).toISOString(), first.match.id);
    await request(app).post(`/api/matches/${first.match.id}/timeout`).set(org);
    expect(
      db.prepare("select status from matches where id=?").get(first.match.id)
        .status,
    ).toBe("SKIPPED");
  });
  it("marks departure and records organizer substitution", async () => {
    const ps = await seed(5);
    const e = db
      .prepare("select id from events where kind='HEAD_TO_HEAD' limit 1")
      .get();
    for (const p of ps.slice(0, 4))
      await request(app)
        .post(`/api/events/${e.id}/join`)
        .set("Authorization", `Bearer ${p.token}`);
    await request(app).post(`/api/events/${e.id}/teams/form`).set(org);
    await request(app)
      .post("/api/me/depart")
      .set("Authorization", `Bearer ${ps[0].token}`);
    const r = await request(app)
      .post(`/api/events/${e.id}/substitutions`)
      .set(org)
      .send({ leavingParticipantId: ps[0].participant.id });
    expect(r.status).toBe(201);
    expect(r.body.substituteId).not.toBe(ps[0].participant.id);
  });
});
describe("ops", () => {
  it("audits mutations, exports state and emits SSE bootstrap", async () => {
    await signup("Audit Me");
    expect(
      db.prepare("select count(*) n from audit_log").get().n,
    ).toBeGreaterThan(0);
    expect(
      (await request(app).get("/api/admin/export").set(org)).body.participants
        .length,
    ).toBe(1);
    const r = await request(app)
      .get("/api/events/stream")
      .buffer(true)
      .parse((res, cb) => {
        let s = "";
        res.on("data", (c) => {
          s += c;
          if (s.includes("event: ready")) {
            (res as any).destroy();
            cb(null, s);
          }
        });
      });
    expect(r.text ?? r.body).toContain("event: ready");
  });
});
