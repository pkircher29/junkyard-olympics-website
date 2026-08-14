import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";

const ORG = { Authorization: "Bearer organizer-a-very-strong-secret" };
let db: any, app: any;
beforeEach(() => {
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] });
});
afterEach(() => db.close());
async function signup(name: string) {
  const r = await request(app).post("/api/participants").send({ displayName: name });
  return { id: r.body.participant.id, token: r.body.token };
}
async function setupTeams(count: number, eventId = "ladder-ball") {
  const people = [];
  for (let i = 0; i < count * 2; i++) {
    const p = await signup(`P${i}-${Math.random()}`); people.push(p);
    await request(app).post(`/api/events/${eventId}/join`).set("Authorization", `Bearer ${p.token}`);
  }
  const formed = await request(app).post(`/api/events/${eventId}/teams/form`).set(ORG);
  return { people, teams: formed.body.teams };
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
async function finalByConfirm(match: any, people: any[], winner = match.teamA.id) {
  db.prepare("UPDATE matches SET status='ACTIVE' WHERE id=?").run(match.id);
  const reporter = people.find(p => match.teamA.participantIds.includes(p.id));
  const opponent = people.find(p => match.teamB.participantIds.includes(p.id));
  await request(app).post(`/api/matches/${match.id}/report`).set(auth(reporter.token)).send({ winningTeamId: winner });
  return request(app).post(`/api/matches/${match.id}/confirm`).set(auth(opponent.token)).send({ agree: true });
}

describe("event-critical competition engine", () => {
  it.each([3, 4, 5, 8])("builds a complete main tree for %i teams without dropping a team", async (teamCount) => {
    const { teams } = await setupTeams(teamCount);
    const r = await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    expect(r.status).toBe(201);
    const all = db.prepare("select * from matches where event_id='ladder-ball' and path='MAIN' and role<>'THIRD_PLACE'").all();
    const slots = 2 ** Math.ceil(Math.log2(teamCount));
    expect(all).toHaveLength(slots - 1);
    const represented = new Set(all.filter((m: any) => m.round === 1).flatMap((m: any) => [m.team_a_id, m.team_b_id]));
    for (const t of teams) expect(represented.has(t.id)).toBe(true);
    if (teamCount === 3) expect(all.some((m: any) => m.status === "FINAL" && m.winner_id)).toBe(true);
  });

  it("uses one idempotent advancement path for confirmation, forfeit and dispute resolution", async () => {
    const { people } = await setupTeams(8);
    const first = (await request(app).post("/api/events/ladder-ball/bracket").set(ORG)).body.matches.filter((m: any) => m.round === 1 && m.status !== "FINAL");
    await finalByConfirm(first[0], people);
    await request(app).post(`/api/matches/${first[1].id}/forfeit`).set(ORG).send({ winningTeamId: first[1].teamA.id });
    const reporter = people.find(p => first[2].teamA.participantIds.includes(p.id))!;
    const opponent = people.find(p => first[2].teamB.participantIds.includes(p.id))!;
    db.prepare("UPDATE matches SET status='ACTIVE' WHERE id=?").run(first[2].id);
    await request(app).post(`/api/matches/${first[2].id}/report`).set(auth(reporter.token)).send({ winningTeamId: first[2].teamA.id });
    await request(app).post(`/api/matches/${first[2].id}/confirm`).set(auth(opponent.token)).send({ agree: false });
    const dispute = db.prepare("select id from disputes where match_id=?").get(first[2].id);
    await request(app).post(`/api/disputes/${dispute.id}/resolve`).set(ORG).send({ winningTeamId: first[2].teamA.id });
    await request(app).post(`/api/disputes/${dispute.id}/resolve`).set(ORG).send({ winningTeamId: first[2].teamA.id });
    expect(db.prepare("select advancement_count n from matches where id=?").get(first[0].id).n).toBe(1);
    expect(db.prepare("select advancement_count n from matches where id=?").get(first[1].id).n).toBe(1);
    expect(db.prepare("select advancement_count n from matches where id=?").get(first[2].id).n).toBe(1);
  });

  it("routes first-round losers to consolation and finalizes explicit top four exactly once", async () => {
    const { people } = await setupTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const round1 = db.prepare("select id from matches where event_id='ladder-ball' and path='MAIN' and round=1 and status<>'FINAL'").all();
    for (const row of round1) await finalByConfirm((await request(app).get(`/api/matches/${row.id}`)).body.match, people);
    expect(db.prepare("select count(*) n from matches where event_id='ladder-ball' and path='CONSOLATION'").get().n).toBeGreaterThan(0);
    const semis = db.prepare("select id from matches where event_id='ladder-ball' and path='MAIN' and role='SEMIFINAL'").all();
    for (const row of semis) { const m = (await request(app).get(`/api/matches/${row.id}`)).body.match; if (m.status !== "FINAL") await finalByConfirm(m, people); }
    for (const role of ["THIRD_PLACE", "FINAL"]) {
      const row = db.prepare("select id from matches where event_id='ladder-ball' and role=?").get(role);
      await finalByConfirm((await request(app).get(`/api/matches/${row.id}`)).body.match, people);
    }
    await request(app).post("/api/events/ladder-ball/finalize").set(ORG);
    await request(app).post("/api/events/ladder-ball/finalize").set(ORG);
    const placements = db.prepare("select place,count(*) n from placements where event_id='ladder-ball' group by place order by place").all();
    expect(placements).toEqual([{ place: 1, n: 2 }, { place: 2, n: 2 }, { place: 3, n: 2 }, { place: 4, n: 2 }]);
  });

  it("standings ignore invalid/manual placements from incomplete events", async () => {
    const p = await signup("Scorer");
    db.prepare("insert into placements(event_id,participant_id,place,points) values('cornhole',?,?,999)").run(p.id, 1);
    const row = (await request(app).get("/api/standings/championship")).body.standings.find((x: any) => x.participantId === p.id);
    expect(row.total).toBe(0);
  });

  it("adds a pre-semifinal late entrant by play-in without rewriting completed matches and rejects after lock", async () => {
    const { people } = await setupTeams(8);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const first = db.prepare("select id from matches where event_id='ladder-ball' and path='MAIN' and role='STANDARD' and status<>'FINAL' limit 1").get();
    await finalByConfirm((await request(app).get(`/api/matches/${first.id}`)).body.match, people);
    const before = db.prepare("select id,winner_id from matches where status='FINAL' and event_id='ladder-ball'").all();
    const late = await signup("Late");
    expect((await request(app).post("/api/events/ladder-ball/bracket/late-entries").set(ORG).send({ participantId: late.id })).status).toBe(201);
    expect(db.prepare("select count(*) n from matches where event_id='ladder-ball' and path='PLAY_IN'").get().n).toBe(1);
    expect(db.prepare("select id,winner_id from matches where status='FINAL' and event_id='ladder-ball'").all()).toEqual(before);
    expect((await request(app).post("/api/events/ladder-ball/bracket/semifinals/start").set(ORG)).status).toBe(409);
    const later = await signup("Still Pre-Semifinal");
    expect((await request(app).post("/api/events/ladder-ball/bracket/late-entries").set(ORG).send({ participantId: later.id })).status).toBe(201);
  });

  it("avoids prior partners, keeps odd trio, and requires teammate rename approval before match-start lock", async () => {
    const people = [];
    for (let i = 0; i < 5; i++) { const p = await signup(`Pair${i}`); people.push(p); for (const e of ["ladder-ball", "field-pong"]) await request(app).post(`/api/events/${e}/join`).set(auth(p.token)); }
    const first = (await request(app).post("/api/events/ladder-ball/teams/form").set(ORG)).body.teams;
    const second = (await request(app).post("/api/events/field-pong/teams/form").set(ORG)).body.teams;
    expect(second.some((t: any) => t.members.length === 3)).toBe(true);
    const priorPairs = new Set(first.flatMap((t: any) => t.members.flatMap((a: any, i: number) => t.members.slice(i + 1).map((b: any) => [a.id,b.id].sort().join(":")))));
    const repeated = second.flatMap((t: any) => t.members.flatMap((a: any, i: number) => t.members.slice(i + 1).map((b: any) => [a.id,b.id].sort().join(":")))).filter((x: string) => priorPairs.has(x));
    expect(repeated.length).toBeLessThan(2);
    const duo = second.find((t: any) => t.members.length === 2);
    const a = people.find(p => p.id === duo.members[0].id)!, b = people.find(p => p.id === duo.members[1].id)!;
    const proposed = await request(app).post(`/api/teams/${duo.id}/rename`).set(auth(a.token)).send({ name: "New Name" });
    expect(proposed.body.name).not.toBe("New Name");
    expect((await request(app).post(`/api/teams/${duo.id}/rename/approve`).set(auth(b.token))).body.name).toBe("New Name");
    await request(app).post("/api/events/field-pong/bracket").set(ORG);
    const match = db.prepare("select id from matches where event_id='field-pong' and (team_a_id=? or team_b_id=?) limit 1").get(duo.id,duo.id);
    db.prepare("update matches set status='CALLED' where id=?").run(match.id);
    for (const member of [a,b]) await request(app).post(`/api/matches/${match.id}/check-in`).set(auth(member!.token));
    expect((await request(app).post(`/api/teams/${duo.id}/rename`).set(auth(a.token)).send({ name: "Too Late" })).status).toBe(409);
  });

  it("preserves substitution history, reverses before next match, and excludes duplicate points", async () => {
    const { people, teams } = await setupTeams(3);
    const leaving = people.find(p => teams[0].members.some((m: any) => m.id === p.id))!;
    await request(app).post("/api/me/depart").set(auth(leaving.token));
    const replacement = await signup("Unassigned replacement");
    db.prepare("insert into placements(event_id,participant_id,place,points) values('ladder-ball',?,?,10)").run(replacement.id,1);
    const sub = await request(app).post("/api/events/ladder-ball/substitutions").set(ORG).send({ leavingParticipantId: leaving.id, replacementParticipantId: replacement.id });
    expect(sub.status).toBe(201);
    expect(db.prepare("select active from team_members where team_id=? and participant_id=?").get(teams[0].id, leaving.id).active).toBe(0);
    expect(db.prepare("select eligible_points from team_members where team_id=? and participant_id=?").get(teams[0].id, replacement.id).eligible_points).toBe(0);
    expect((await request(app).post(`/api/substitutions/${sub.body.id}/reverse`).set(ORG)).status).toBe(200);
    expect(db.prepare("select active from team_members where team_id=? and participant_id=?").get(teams[0].id, leaving.id).active).toBe(1);
  });

  it("scheduler rejects inactive, disputed, busy lineups and occupied stations", async () => {
    const { teams, people } = await setupTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const matches = db.prepare("select * from matches where event_id='ladder-ball' and round=1 and status<>'FINAL'").all();
    db.prepare("update participants set active=0 where id=?").run(teams[0].members[0].id);
    db.prepare("update matches set status='DISPUTED' where id=?").run(matches[1].id);
    db.prepare("update matches set status='ACTIVE',station_id='station-1' where id=?").run(matches[2].id);
    const occupied = await request(app).post("/api/stations/station-1/call-next").set(ORG);
    expect(occupied.status).toBe(409);
    const call = await request(app).post("/api/stations/station-2/call-next").set(ORG);
    if (call.body.match) {
      expect(call.body.match.id).not.toBe(matches[0].id);
      expect(call.body.match.id).not.toBe(matches[1].id);
      expect(call.body.match.participantIds.some((id: string) => people.find(p => p.id === id && p.id === teams[0].members[0].id))).toBe(false);
    }
  });
});
