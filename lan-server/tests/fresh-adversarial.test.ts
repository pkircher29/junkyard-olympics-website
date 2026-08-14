import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";

const ORG = { Authorization: "Bearer organizer-a-very-strong-secret" };
const auth = (token: string) => ({ Authorization: "Bearer " + token });
let db: any, app: any;

beforeEach(() => {
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] });
});
afterEach(() => db.close());

async function signup(name: string) {
  const response = await request(app).post("/api/participants").send({ displayName: name });
  return { id: response.body.participant.id, token: response.body.token };
}
async function formTeams(count: number, eventId = "ladder-ball") {
  const people = [];
  for (let index = 0; index < count * 2; index++) {
    const person = await signup(`${eventId}-${index}`);
    people.push(person);
    await request(app).post(`/api/events/${eventId}/join`).set(auth(person.token));
  }
  const teams = (await request(app).post(`/api/events/${eventId}/teams/form`).set(ORG)).body.teams;
  return { people, teams };
}
async function formSamePeople(people: any[], eventId: string) {
  for (const person of people) await request(app).post(`/api/events/${eventId}/join`).set(auth(person.token));
  return (await request(app).post(`/api/events/${eventId}/teams/form`).set(ORG)
    .send({ participantIds: people.map((person) => person.id) })).body.teams;
}
async function forfeit(match: any, winner = match.team_a_id ?? match.teamA.id) {
  return request(app).post(`/api/matches/${match.id}/forfeit`).set(ORG).send({ winningTeamId: winner });
}

describe("fresh adversarial engine blockers", () => {
  it("scheduler only calls bracket-ready matches with two real populated active teams", async () => {
    await formTeams(5);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    db.prepare("UPDATE matches SET status='DISPUTED' WHERE event_id='ladder-ball' AND round=1 AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%'").run();

    const called = await request(app).post("/api/stations/station-1/call-next").set(ORG);
    expect(called.status).toBe(200);
    expect(called.body.match).toBeNull();
    const syntheticCalls = db.prepare("SELECT count(*) n FROM matches WHERE status='CALLED' AND (team_a_id LIKE 'bye:%' OR team_b_id LIKE 'bye:%')").get().n;
    expect(syntheticCalls).toBe(0);
  });

  it("late-entry play-in feeds an unstarted main slot and its winner can reach placement", async () => {
    const { people } = await formTeams(8);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const completed = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='MAIN' AND role='STANDARD' LIMIT 1").get();
    await forfeit(completed);
    const completedBefore = db.prepare("SELECT id,winner_id FROM matches WHERE id=?").get(completed.id);
    const late = await signup("Late entrant");

    const response = await request(app).post("/api/events/ladder-ball/bracket/late-entries").set(ORG).send({ participantId: late.id });
    expect(response.status).toBe(201);
    const projection = await request(app).get("/api/events/ladder-ball/bracket");
    expect(projection.body.bracket.playInMatches).toHaveLength(1);
    expect(projection.body.bracket.playInMatches[0]).toMatchObject({ path: "PLAY_IN" });
    const playIn = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='PLAY_IN'").get();
    expect(playIn.next_match_id).toBeTruthy();
    expect(["A", "B"]).toContain(playIn.next_slot);
    const destinationBefore = db.prepare("SELECT * FROM matches WHERE id=?").get(playIn.next_match_id);
    expect(destinationBefore.status).toBe("PENDING");
    await forfeit(playIn, response.body.team.id);
    const destinationAfter = db.prepare("SELECT * FROM matches WHERE id=?").get(playIn.next_match_id);
    expect(destinationAfter[playIn.next_slot === "A" ? "team_a_id" : "team_b_id"]).toBe(response.body.team.id);

    // The play-in's destination remains on the existing path to the final/placements.
    let cursor = destinationAfter;
    while (cursor.role !== "FINAL") cursor = db.prepare("SELECT * FROM matches WHERE id=?").get(cursor.next_match_id);
    expect(cursor.role).toBe("FINAL");
    expect(db.prepare("SELECT id,winner_id FROM matches WHERE id=?").get(completed.id)).toEqual(completedBefore);
    expect(people).toHaveLength(16);
  });

  it("rejects late entry atomically when no unstarted main-bracket slot can be connected", async () => {
    await formTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    db.prepare("UPDATE matches SET status='CALLED' WHERE event_id='ladder-ball' AND path='MAIN' AND round=1").run();
    const late = await signup("Disconnected");
    const before = db.prepare("SELECT count(*) n FROM teams WHERE event_id='ladder-ball'").get().n;
    const response = await request(app).post("/api/events/ladder-ball/bracket/late-entries").set(ORG).send({ participantId: late.id });
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM teams WHERE event_id='ladder-ball'").get().n).toBe(before);
    expect(db.prepare("SELECT count(*) n FROM matches WHERE path='PLAY_IN'").get().n).toBe(0);
  });

  it("eight-team consolation gives every first-match loser a second match and advances to a final", async () => {
    await formTeams(8);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const first: any[] = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='MAIN' AND round=1").all();
    const consolation: any[] = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='CONSOLATION' ORDER BY round,rowid").all();
    expect(consolation).toHaveLength(3);
    const consolationFinal = consolation.find((match) => match.role === "CONSOLATION_FINAL");
    expect(consolationFinal).toBeTruthy();
    for (const match of first) expect(match.loser_match_id).toBeTruthy();

    for (const match of first) await forfeit(match, match.team_a_id);
    const openingConsolation: any[] = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='CONSOLATION' AND role='STANDARD'").all();
    expect(openingConsolation).toHaveLength(2);
    expect(openingConsolation.every((match) => match.team_a_id !== match.team_b_id && !match.team_a_id.startsWith("bye:") && !match.team_b_id.startsWith("bye:"))).toBe(true);
    for (const match of openingConsolation) {
      expect(match.next_match_id).toBe(consolationFinal.id);
      await forfeit(match, match.team_a_id);
    }
    const readyFinal = db.prepare("SELECT * FROM matches WHERE id=?").get(consolationFinal.id);
    expect(readyFinal.team_a_id).not.toBe(readyFinal.team_b_id);
    expect(readyFinal.team_a_id.startsWith("bye:") || readyFinal.team_b_id.startsWith("bye:")).toBe(false);
  });

  it("DISPUTED participants remain busy across events", async () => {
    const { people } = await formTeams(2);
    const fieldTeams = await formSamePeople(people, "field-pong");
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    await request(app).post("/api/events/field-pong/bracket").set(ORG);
    db.prepare("UPDATE matches SET status='DISPUTED' WHERE event_id='ladder-ball'").run();
    const response = await request(app).post("/api/stations/station-1/call-next").set(ORG);
    expect(response.body.match).toBeNull();
    expect(fieldTeams).toHaveLength(2);
  });

  it("explicit and automatic substitutes cannot already be active on another event team", async () => {
    const { people, teams } = await formTeams(3);
    const leaving = people.find((person) => teams[0].participantIds.includes(person.id))!;
    const occupied = people.find((person) => teams[1].participantIds.includes(person.id))!;
    await request(app).post("/api/me/depart").set(auth(leaving.token));
    const explicit = await request(app).post("/api/events/ladder-ball/substitutions").set(ORG)
      .send({ leavingParticipantId: leaving.id, replacementParticipantId: occupied.id });
    expect(explicit.status).toBe(409);
    expect(db.prepare("SELECT active FROM team_members WHERE team_id=? AND participant_id=?").get(teams[0].id, leaving.id).active).toBe(1);

    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const match = db.prepare("SELECT id FROM matches WHERE event_id='ladder-ball' AND (team_a_id=? OR team_b_id=?) LIMIT 1").get(teams[0].id, teams[0].id);
    const automatic = await request(app).post(`/api/matches/${match.id}/substitutions/auto`).set(ORG);
    expect(automatic.status).toBe(409);
  });

  it("inactive membership cannot report, confirm, check in, or shoot Cannon", async () => {
    const { people, teams } = await formTeams(2);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const match = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='MAIN'").get();
    const historical = people.find((person) => teams[0].participantIds.includes(person.id))!;
    const opponent = people.find((person) => teams[1].participantIds.includes(person.id))!;
    db.prepare("UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?").run(teams[0].id, historical.id);
    expect((await request(app).post(`/api/matches/${match.id}/report`).set(auth(historical.token)).send({ winningTeamId: teams[0].id })).status).toBe(403);
    db.prepare("UPDATE matches SET status='AWAITING_CONFIRMATION',reporter_id=?,reported_winner_id=? WHERE id=?").run(opponent.id, teams[1].id, match.id);
    expect((await request(app).post(`/api/matches/${match.id}/confirm`).set(auth(historical.token)).send({ agree: true })).status).toBe(403);
    db.prepare("UPDATE matches SET status='CALLED' WHERE id=?").run(match.id);
    expect((await request(app).post(`/api/matches/${match.id}/check-in`).set(auth(historical.token))).status).toBe(403);

    const cannonTeams = await formSamePeople(people, "cannon");
    const shooter = people.find((person) => cannonTeams[0].participantIds.includes(person.id))!;
    db.prepare("UPDATE team_members SET active=0 WHERE team_id=? AND participant_id=?").run(cannonTeams[0].id, shooter.id);
    expect((await request(app).post(`/api/events/cannon/teams/${cannonTeams[0].id}/shots`).set(ORG).send({ shooterId: shooter.id, targetIds: [] })).status).toBe(400);
  });

  it("generic Cannon scoring rejects non-Cannon events and inactive shooters", async () => {
    const { people, teams } = await formTeams(2);
    const shooter = people.find((person) => teams[0].participantIds.includes(person.id))!;
    expect((await request(app).post(`/api/events/ladder-ball/teams/${teams[0].id}/shots`).set(ORG).send({ shooterId: shooter.id, targetIds: [] })).status).toBe(400);
    const cannonTeams = await formSamePeople(people, "cannon");
    const cannonShooter = people.find((person) => cannonTeams[0].participantIds.includes(person.id))!;
    db.prepare("UPDATE participants SET active=0 WHERE id=?").run(cannonShooter.id);
    expect((await request(app).post(`/api/events/cannon/teams/${cannonTeams[0].id}/shots`).set(ORG).send({ shooterId: cannonShooter.id, targetIds: [] })).status).toBe(400);
  });

  it("organizer Cannon finalization gates unresolved sudden death and writes top four idempotently", async () => {
    const { teams } = await formTeams(4, "cannon");
    const target = (await request(app).post("/api/cannon/targets").set(ORG).send({ targets: [{ name: "Can", points: 10 }] })).body.targets[0];
    const run = (await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: teams.map((team: any) => team.id), laneIds: teams.map((_: any, index: number) => `lane-${index}`) })).body.run;
    const scoreCounts = [0, 0, 1, 2];
    for (let index = 0; index < teams.length; index++) {
      for (let sequence = 1; sequence <= scoreCounts[index]!; sequence++) await request(app).post(`/api/cannon/runs/${run.id}/shots`).set(ORG).send({ teamId: teams[index].id, laneId: `lane-${index}`, kind: "scored", sequence, targetIds: [target.id] });
    }
    expect((await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG)).status).toBe(409);
    const tied = teams.slice(0, 2);
    await request(app).post(`/api/cannon/runs/${run.id}/shootout-shots`).set(ORG).send({ teamId: tied[0].id, round: 1, points: 5 });
    await request(app).post(`/api/cannon/runs/${run.id}/shootout-shots`).set(ORG).send({ teamId: tied[1].id, round: 1, points: 0 });
    for (let index = 0; index < teams.length; index++) {
      for (let sequence = scoreCounts[index]! + 1; sequence <= 20; sequence++) await request(app).post(`/api/cannon/runs/${run.id}/shots`).set(ORG).send({ teamId: teams[index].id, laneId: `lane-${index}`, kind: "scored", sequence, targetIds: [] });
    }
    const first = await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG);
    const second = await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const placements = db.prepare("SELECT place,count(*) n FROM placements WHERE event_id='cannon' GROUP BY place ORDER BY place").all();
    expect(placements).toEqual([{ place: 1, n: 2 }, { place: 2, n: 2 }, { place: 3, n: 2 }, { place: 4, n: 2 }]);
    expect(db.prepare("SELECT completed_at FROM events WHERE id='cannon'").get().completed_at).toBeTruthy();
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='event.finalize' AND entity_id='cannon'").get().n).toBe(1);
  });

  it("forfeit rejects a finalized match without adding another audit record", async () => {
    await formTeams(2);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const match = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball'").get();
    expect((await forfeit(match)).status).toBe(200);
    const audits = db.prepare("SELECT count(*) n FROM audit_log WHERE action='match.forfeit' AND entity_id=?").get(match.id).n;
    expect((await forfeit(match)).status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='match.forfeit' AND entity_id=?").get(match.id).n).toBe(audits);
    expect(db.prepare("SELECT advancement_count n FROM matches WHERE id=?").get(match.id).n).toBe(1);
  });
});
