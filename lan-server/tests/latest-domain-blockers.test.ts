import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";

const ORG = { Authorization: "Bearer organizer-a-very-strong-secret" };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let db: any;
let app: any;
let clock: Date;

beforeEach(() => {
  clock = new Date("2026-08-15T19:00:00.000Z");
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"], now: () => clock });
});
afterEach(() => db.close());

async function signup(name: string) {
  const response = await request(app).post("/api/participants").send({ displayName: name });
  expect(response.status).toBe(201);
  return { id: response.body.participant.id, token: response.body.token };
}
async function formTeams(count: number, eventId = "ladder-ball") {
  const people = [];
  for (let index = 0; index < count * 2; index++) people.push(await signup(`${eventId}-${count}-${index}`));
  const response = await request(app).post(`/api/events/${eventId}/teams/form`).set(ORG).send({ participantIds: people.map(person => person.id) });
  expect(response.status).toBe(201);
  return { people, teams: response.body.teams };
}
async function completePlayable(eventId: string) {
  while (true) {
    const match: any = db.prepare("SELECT * FROM matches WHERE event_id=? AND role<>'THIRD_PLACE' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' ORDER BY CASE path WHEN 'MAIN' THEN 0 ELSE 1 END,round,rowid LIMIT 1").get(eventId);
    if (!match) break;
    const response = await request(app).post(`/api/matches/${match.id}/forfeit`).set(ORG).send({ winningTeamId: match.team_a_id });
    expect(response.status).toBe(200);
  }
}

// These are the exact independent-review blocker reproductions. They must fail before production repair.
describe("latest domain blocker regressions", () => {
  it("normalizes an explicit participant pool before applying the intended shuffle", async () => {
    for (const [id, name] of [["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"], ["d", "Delta"]]) {
      db.prepare("INSERT INTO participants(id,display_name,token_hash) VALUES(?,?,?)").run(id, name, `hash-${id}`);
    }
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const response = await request(app)
        .post("/api/events/ladder-ball/teams/form")
        .set(ORG)
        .send({ participantIds: ["d", "b", "a", "c"] });
      expect(response.status).toBe(201);
      expect(response.body.teams.map((team: any) => team.participantIds)).toEqual([["b", "a"], ["c", "d"]]);
    } finally {
      random.mockRestore();
    }
  });

  it("finds the unique zero-repeat grouping even when every random shuffle is the same bad arrangement", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (const id of ids) db.prepare("INSERT INTO participants(id,display_name,token_hash) VALUES(?,?,?)").run(id, id.toUpperCase(), `hash-${id}`);
    const allowed = new Set(["a:b", "c:d", "e:f"]);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      for (let left = 0; left < ids.length; left++) for (let right = left + 1; right < ids.length; right++) {
        const pair = `${ids[left]}:${ids[right]}`;
        if (allowed.has(pair)) continue;
        const history = await request(app).post("/api/events/ladder-ball/teams/form").set(ORG).send({ participantIds: [ids[left], ids[right]] });
        expect(history.status).toBe(201);
      }
      const response = await request(app).post("/api/events/ladder-ball/teams/form").set(ORG).send({ participantIds: ids });
      expect(response.status).toBe(201);
      const groups = response.body.teams.map((team: any) => [...team.participantIds].sort().join(":"));
      expect(new Set(groups)).toEqual(allowed);
    } finally {
      random.mockRestore();
    }
  });

  it.each([3, 5, 6, 8])("gives every loser of a first actual playable match a completed second playable match in a %i-team bracket", async teamCount => {
    const { teams } = await formTeams(teamCount);
    expect((await request(app).post("/api/events/ladder-ball/bracket").set(ORG)).status).toBe(201);

    const firstLosses = new Map<string, string>();
    while (true) {
      const match: any = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' ORDER BY CASE path WHEN 'MAIN' THEN 0 WHEN 'CONSOLATION' THEN 1 ELSE 2 END,round,rowid LIMIT 1").get();
      if (!match) break;
      const priorLoserGames = (teamId: string) => (db.prepare("SELECT count(*) n FROM matches WHERE status='FINAL' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' AND (team_a_id=? OR team_b_id=?)").get(teamId, teamId) as any).n;
      const aGames = priorLoserGames(match.team_a_id), bGames = priorLoserGames(match.team_b_id);
      const loserId = aGames === 0 ? match.team_a_id : match.team_b_id;
      const winnerId = loserId === match.team_a_id ? match.team_b_id : match.team_a_id;
      if ((loserId === match.team_a_id ? aGames : bGames) === 0) firstLosses.set(loserId, match.id);
      expect((await request(app).post(`/api/matches/${match.id}/forfeit`).set(ORG).send({ winningTeamId: winnerId })).status).toBe(200);
    }

    expect(firstLosses.size, "simulation must exercise real first-game losers").toBeGreaterThan(0);
    for (const [teamId, firstMatchId] of firstLosses) {
      const second: any = db.prepare("SELECT id,status FROM matches WHERE id<>? AND status='FINAL' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' AND (team_a_id=? OR team_b_id=?) ORDER BY rowid LIMIT 1").get(firstMatchId, teamId, teamId);
      expect(second, `first-game loser ${teamId} has a completed second playable match`).toBeTruthy();
    }
    expect(db.prepare("SELECT count(*) n FROM matches WHERE event_id='ladder-ball' AND status='PENDING'").get().n).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM matches WHERE event_id='ladder-ball' AND path='CONSOLATION' AND status='PENDING' AND (team_a_id LIKE 'bye:%' OR team_b_id LIKE 'bye:%')").get().n).toBe(0);
    expect(new Set(teams.map((team: any) => team.id))).toHaveLength(teamCount);
  });

  it("terminates randomized bracket completion for sizes 2-15 without stranded BYEs and gives first-playable losers a second match when possible", async () => {
    for (let teamCount = 2; teamCount <= 15; teamCount++) {
      for (let seed = 1; seed <= 8; seed++) {
        db.close();
        db = createDatabase(":memory:");
        app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"], now: () => clock });
        await formTeams(teamCount);
        expect((await request(app).post("/api/events/ladder-ball/bracket").set(ORG)).status).toBe(201);
        let state = (teamCount * 0x9e3779b1 + seed) >>> 0;
        const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
        const firstLosses = new Map<string, string>();
        for (let step = 0; step < 500; step++) {
          const playable: any[] = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%'").all();
          if (!playable.length) break;
          const match = playable[Math.floor(random() * playable.length)]!;
          const winnerId = random() < 0.5 ? match.team_a_id : match.team_b_id;
          const loserId = winnerId === match.team_a_id ? match.team_b_id : match.team_a_id;
          const priorGames = (db.prepare("SELECT count(*) n FROM matches WHERE id<>? AND status='FINAL' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' AND (team_a_id=? OR team_b_id=?)").get(match.id, loserId, loserId) as any).n;
          if (priorGames === 0 && match.path === "MAIN") firstLosses.set(loserId, match.id);
          expect((await request(app).post(`/api/matches/${match.id}/forfeit`).set(ORG).send({ winningTeamId: winnerId })).status).toBe(200);
        }
        const stranded = db.prepare("SELECT id,path,round,team_a_id,team_b_id FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND ((team_a_id LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%') OR (team_b_id LIKE 'bye:%' AND team_a_id NOT LIKE 'bye:%'))").all();
        expect(stranded, `${teamCount} teams seed ${seed} stranded real-vs-BYE matches`).toEqual([]);
        expect(db.prepare("SELECT count(*) n FROM matches WHERE event_id='ladder-ball' AND status='PENDING' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%'").get().n).toBe(0);
        if (teamCount >= 3) for (const [teamId, firstMatchId] of firstLosses) {
          const second = db.prepare("SELECT 1 FROM matches WHERE id<>? AND status='FINAL' AND team_a_id NOT LIKE 'bye:%' AND team_b_id NOT LIKE 'bye:%' AND (team_a_id=? OR team_b_id=?) LIMIT 1").get(firstMatchId, teamId, teamId);
          expect(second, `${teamCount} teams seed ${seed}: first-playable loser ${teamId} needs a second playable match; first=${firstMatchId}; ${JSON.stringify(db.prepare("SELECT id,round,path,role,status,team_a_id,team_b_id,loser_match_id,loser_slot FROM matches WHERE team_a_id=? OR team_b_id=?").all(teamId, teamId))}`).toBeTruthy();
        }
      }
    }
  }, 120_000);

  it("rejects a late entrant already active on any team in the event", async () => {
    const { people, teams } = await formTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const entrant = people.find(person => teams.some((team: any) => team.participantIds.includes(person.id)))!;
    const before = db.prepare("SELECT count(*) n FROM teams WHERE event_id='ladder-ball'").get().n;
    const response = await request(app).post("/api/events/ladder-ball/bracket/late-entries").set(ORG).send({ participantId: entrant.id });
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM teams WHERE event_id='ladder-ball'").get().n).toBe(before);
  });

  it("rejects repeat substitution for an inactive leaver membership and preserves the intended active roster", async () => {
    const { people, teams } = await formTeams(2);
    const leaver = people.find(person => teams[0].participantIds.includes(person.id))!;
    const first = await signup("replacement-one");
    const second = await signup("replacement-two");
    await request(app).post("/api/me/depart").set(auth(leaver.token));
    expect((await request(app).post("/api/events/ladder-ball/substitutions").set(ORG).send({ leavingParticipantId: leaver.id, replacementParticipantId: first.id })).status).toBe(201);
    expect((await request(app).post("/api/events/ladder-ball/substitutions").set(ORG).send({ leavingParticipantId: leaver.id, replacementParticipantId: second.id })).status).toBe(409);
    const active = db.prepare("SELECT participant_id id FROM team_members WHERE team_id=? AND active=1 ORDER BY participant_id").all(teams[0].id).map((row: any) => row.id);
    expect(active).toEqual([first.id, ...teams[0].participantIds.filter((id: string) => id !== leaver.id)].sort());
  });

  it("auto-substitutes only a departed member of the selected match", async () => {
    const { people, teams } = await formTeams(3);
    const bracket = (await request(app).post("/api/events/ladder-ball/bracket").set(ORG)).body.bracket;
    const selected = bracket.mainMatches.find((match: any) => match.teamIds.includes(teams[0].id))!;
    const unrelated = people.find(person => teams[2].participantIds.includes(person.id))!;
    const selectedLeaver = people.find(person => selected.participantIds.includes(person.id))!;
    const replacement = await signup("match-scoped-replacement");

    await request(app).post("/api/me/depart").set(auth(unrelated.token));
    expect((await request(app).post(`/api/matches/${selected.id}/substitutions/auto`).set(ORG)).status).toBe(409);
    expect(db.prepare("SELECT active FROM team_members WHERE team_id=? AND participant_id=?").get(teams[2].id, unrelated.id).active).toBe(1);

    await request(app).post("/api/me/depart").set(auth(selectedLeaver.token));
    const response = await request(app).post(`/api/matches/${selected.id}/substitutions/auto`).set(ORG);
    expect(response.status).toBe(201);
    expect(response.body.substitution).toMatchObject({ leavingParticipantId: selectedLeaver.id, inParticipantId: replacement.id });
  });

  it("publishes a championship podium containing eligible competitors only", async () => {
    const competitors = [];
    for (let index = 0; index < 4; index++) competitors.push(await signup(`podium-${index}`));
    const [first, second, third, fourth] = competitors;
    expect(first && second && third && fourth).toBeTruthy();
    const fixtures = [
      { participantId: first!.id, cannon: 10, field: [10, 7, 5] },
      { participantId: second!.id, cannon: 7, field: [10, 7, 5] },
      { participantId: third!.id, cannon: null, field: [10, 7, 5, 3] },
      { participantId: fourth!.id, cannon: 10, field: [10, 7] },
    ];
    for (const fixture of fixtures) {
      expect((await request(app).post("/api/admin/acceptance/placements").set(ORG).send(fixture)).status).toBe(201);
    }
    const response = await request(app).get("/api/standings/championship");
    expect(response.body.podium.map((row: any) => row.participantId)).toEqual([first!.id, second!.id]);
    expect(response.body.podium.every((row: any) => row.eligible)).toBe(true);
    expect(response.body.standings).toHaveLength(4);
  });

  it("serves both canonical championship endpoints from the same full-standings eligible-podium response", async () => {
    const eligible = await signup("canonical eligible");
    const ineligible = await signup("canonical ineligible");
    await request(app).post("/api/admin/acceptance/placements").set(ORG).send({ participantId: eligible.id, cannon: 10, field: [10, 7, 5] });
    await request(app).post("/api/admin/acceptance/placements").set(ORG).send({ participantId: ineligible.id, cannon: null, field: [10, 7, 5, 3] });
    const primary = await request(app).get("/api/standings/championship");
    const alias = await request(app).get("/api/championship/standings");
    expect(primary.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(alias.body).toEqual(primary.body);
    expect(primary.body.standings).toHaveLength(2);
    expect(primary.body.podium.map((row: any) => row.participantId)).toEqual([eligible.id]);
  });

  it("detects every top-four Cannon tie including the fourth/fifth boundary until all tied groups resolve", async () => {
    const { teams } = await formTeams(5, "cannon");
    const run = (await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: teams.map((team: any) => team.id), laneIds: teams.map((_: any, index: number) => `lane-${index}`) })).body.run;
    const scores = [40, 30, 20, 0, 0];
    teams.forEach((team: any, index: number) => db.prepare("INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,points,run_id,lane_id,kind,sequence) VALUES(?,?,?,?,?,?,?,?,?)").run(`shot-${index}`, "cannon", team.id, team.participantIds[0], scores[index], run.id, `lane-${index}`, "scored", 1));
    let standings = (await request(app).get(`/api/cannon/runs/${run.id}/standings`)).body;
    expect(new Set(standings.tie.teamIds)).toEqual(new Set(teams.slice(3).map((team: any) => team.id)));
    expect(standings.tie.unresolved).toBe(true);
    for (const [index, team] of teams.slice(3).entries()) await request(app).post(`/api/cannon/runs/${run.id}/shootout-shots`).set(ORG).send({ teamId: team.id, round: 1, points: index });
    standings = (await request(app).get(`/api/cannon/runs/${run.id}/standings`)).body;
    expect(standings.tie.unresolved).toBe(false);

    db.prepare("DELETE FROM cannon_shootout_shots").run();
    db.prepare("UPDATE cannon_shots SET points=0").run();
    for (const [index, team] of teams.entries()) await request(app).post(`/api/cannon/runs/${run.id}/shootout-shots`).set(ORG).send({ teamId: team.id, round: 1, points: index < 2 ? 5 : 0 });
    standings = (await request(app).get(`/api/cannon/runs/${run.id}/standings`)).body;
    expect(standings.tie.unresolved).toBe(true);
    expect((await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG)).status).toBe(409);
  });

  it.each([{ kind: "practice", individual: 5, team: 10 }, { kind: "scored", individual: 10, team: 20 }])("enforces run-based Cannon $kind quotas after shooter departure", async quota => {
    const { people, teams } = await formTeams(1, "cannon");
    const run = (await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: [teams[0].id], laneIds: ["lane-1"] })).body.run;
    const departed = people.find(person => teams[0].participantIds.includes(person.id))!;
    await request(app).post("/api/me/depart").set(auth(departed.token));
    for (let sequence = 1; sequence <= quota.individual; sequence++) expect((await request(app).post(`/api/cannon/runs/${run.id}/shots`).set(ORG).send({ teamId: teams[0].id, laneId: "lane-1", kind: quota.kind, sequence, targetIds: [] })).status).toBe(201);
    const excess = await request(app).post(`/api/cannon/runs/${run.id}/shots`).set(ORG).send({ teamId: teams[0].id, laneId: "lane-1", kind: quota.kind, sequence: quota.individual + 1, targetIds: [] });
    expect(excess.status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND kind=?").get(run.id, teams[0].id, quota.kind).n).toBe(quota.individual);
  });

  it("rejects bracket creation for Cannon", async () => {
    await formTeams(2, "cannon");
    expect((await request(app).post("/api/events/cannon/bracket").set(ORG)).status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM matches WHERE event_id='cannon'").get().n).toBe(0);
  });

  it.each(["PENDING", "CALLED"])("rejects result reports from an unplayed %s match", async status => {
    const { people } = await formTeams(2);
    const bracket = (await request(app).post("/api/events/ladder-ball/bracket").set(ORG)).body.bracket;
    const match = bracket.mainMatches.find((candidate: any) => candidate.teamA?.participantIds.length && candidate.teamB?.participantIds.length);
    db.prepare("UPDATE matches SET status=? WHERE id=?").run(status, match.id);
    const reporter = people.find(person => match.teamA.participantIds.includes(person.id))!;
    expect((await request(app).post(`/api/matches/${match.id}/result-reports`).set(auth(reporter.token)).send({ winnerTeamId: match.teamA.id })).status).toBe(409);
  });

  it("makes identical organizer completion idempotent without rewriting timestamp/audit and rejects a conflicting winner", async () => {
    await formTeams(2);
    const match: any = db.prepare("SELECT * FROM matches WHERE 0").get();
    const created = (await request(app).post("/api/events/ladder-ball/bracket").set(ORG)).body.bracket.mainMatches[0];
    const t1 = "2026-08-15T19:00:00.000Z", t2 = "2026-08-15T20:00:00.000Z";
    expect((await request(app).post(`/api/matches/${created.id}/complete`).set(ORG).send({ winnerTeamId: created.teamA.id, completedAt: t1 })).status).toBe(200);
    const audits = db.prepare("SELECT count(*) n FROM audit_log WHERE action='match.complete' AND entity_id=?").get(created.id).n;
    expect((await request(app).post(`/api/matches/${created.id}/complete`).set(ORG).send({ winnerTeamId: created.teamA.id, completedAt: t1 })).status).toBe(200);
    expect(db.prepare("SELECT completed_at FROM matches WHERE id=?").get(created.id).completed_at).toBe(t1);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='match.complete' AND entity_id=?").get(created.id).n).toBe(audits);
    expect((await request(app).post(`/api/matches/${created.id}/complete`).set(ORG).send({ winnerTeamId: created.teamB.id, completedAt: t2 })).status).toBe(409);
    expect(db.prepare("SELECT completed_at,winner_id FROM matches WHERE id=?").get(created.id)).toEqual({ completed_at: t1, winner_id: created.teamA.id });
    void match;
  });

  it("does not duplicate head-to-head finalization audit", async () => {
    await formTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    db.prepare("UPDATE matches SET status='FINAL',winner_id=team_a_id WHERE event_id='ladder-ball' AND role IN ('FINAL','THIRD_PLACE')").run();
    expect((await request(app).post("/api/events/ladder-ball/finalize").set(ORG)).status).toBe(200);
    expect((await request(app).post("/api/events/ladder-ball/finalize").set(ORG)).status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='event.finalize' AND entity_id='ladder-ball'").get().n).toBe(1);
  });

  it("ranks a four-team multi-round sudden death using every round in repeated-elimination order", async () => {
    const { teams } = await formTeams(4, "cannon");
    const run = (await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: teams.map((team: any) => team.id), laneIds: teams.map((_: any, index: number) => `lane-${index}`) })).body.run;
    for (const [teamIndex, team] of teams.entries()) {
      for (let sequence = 1; sequence <= 20; sequence++) {
        const shooterId = team.participantIds[sequence <= 10 ? 0 : 1];
        db.prepare("INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,points,run_id,lane_id,kind,sequence) VALUES(?,?,?,?,0,?,?,'scored',?)").run(`full-${teamIndex}-${sequence}`, "cannon", team.id, shooterId, run.id, `lane-${teamIndex}`, sequence);
      }
    }
    const rounds = [[5, 5, 0, 0], [1, 0, 1, 1]];
    for (const [roundIndex, scores] of rounds.entries()) for (const [teamIndex, team] of teams.entries())
      db.prepare("INSERT INTO cannon_shootout_shots(id,run_id,team_id,round,points) VALUES(?,?,?,?,?)").run(`sd-${roundIndex}-${teamIndex}`, run.id, team.id, roundIndex + 1, scores[teamIndex]);
    db.prepare("INSERT INTO cannon_shootout_shots(id,run_id,team_id,round,points) VALUES(?,?,?,?,?)").run("sd-2-2", run.id, teams[2].id, 3, 1);
    db.prepare("INSERT INTO cannon_shootout_shots(id,run_id,team_id,round,points) VALUES(?,?,?,?,?)").run("sd-2-3", run.id, teams[3].id, 3, 0);

    const standings = (await request(app).get(`/api/cannon/runs/${run.id}/standings`)).body;
    expect(standings.tie.unresolved).toBe(false);
    expect((await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG)).status).toBe(200);
    const places = teams.map((team: any) => (db.prepare("SELECT place FROM placements WHERE event_id='cannon' AND participant_id=?").get(team.participantIds[0]) as any)?.place);
    expect(places).toEqual([1, 2, 3, 4]);
  });

  it("rejects Cannon finalization until every active original pair member has ten scored shots", async () => {
    const { teams } = await formTeams(4, "cannon");
    const run = (await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: teams.map((team: any) => team.id), laneIds: teams.map((_: any, index: number) => `lane-${index}`) })).body.run;
    for (const [teamIndex, team] of teams.entries())
      db.prepare("INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,points,run_id,lane_id,kind,sequence) VALUES(?,?,?,?,?, ?,?, 'scored',1)").run(`short-${teamIndex}`, "cannon", team.id, team.participantIds[0], 40 - teamIndex * 10, run.id, `lane-${teamIndex}`);
    const response = await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CANNON_SHOTS_INCOMPLETE");
    expect(db.prepare("SELECT completed_at FROM events WHERE id='cannon'").get().completed_at).toBeNull();
  });

  it("keeps ten scored shots owed by each original Cannon member after departure and substitution", async () => {
    const { people, teams } = await formTeams(4, "cannon");
    const run = (await request(app).post("/api/cannon/runs").set(ORG).send({ eventId: "cannon", teamIds: teams.map((team: any) => team.id), laneIds: teams.map((_: any, index: number) => `lane-${index}`) })).body.run;
    const departed = people.find(person => teams[0].participantIds.includes(person.id))!;
    const remainingOriginal = teams[0].participantIds.find((id: string) => id !== departed.id)!;
    const replacement = await signup("Cannon substitute cannot erase debt");
    await request(app).post("/api/me/depart").set(auth(departed.token));
    expect((await request(app).post("/api/events/cannon/substitutions").set(ORG).send({ leavingParticipantId: departed.id, replacementParticipantId: replacement.id })).status).toBe(201);

    for (const [teamIndex, team] of teams.entries()) {
      for (let sequence = 1; sequence <= 20; sequence++) {
        const shooterId = teamIndex === 0
          ? (sequence <= 10 ? remainingOriginal : replacement.id)
          : team.participantIds[sequence <= 10 ? 0 : 1];
        db.prepare("INSERT INTO cannon_shots(id,event_id,team_id,shooter_id,points,run_id,lane_id,kind,sequence) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(`original-debt-${teamIndex}-${sequence}`, "cannon", team.id, shooterId, teamIndex * 10, run.id, `lane-${teamIndex}`, "scored", sequence);
      }
    }

    const response = await request(app).post(`/api/cannon/runs/${run.id}/finalize`).set(ORG);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CANNON_SHOTS_INCOMPLETE");
    expect(db.prepare("SELECT count(*) n FROM cannon_shots WHERE run_id=? AND team_id=? AND shooter_id=?",).get(run.id, teams[0].id, departed.id).n).toBe(0);
  });

  it("validates semifinal topology and makes a ready retry state-and-audit idempotent", async () => {
    expect((await request(app).post("/api/events/missing/bracket/semifinals/start").set(ORG)).status).toBe(404);
    expect((await request(app).post("/api/events/cannon/bracket/semifinals/start").set(ORG)).status).toBe(409);
    expect((await request(app).post("/api/events/ladder-ball/bracket/semifinals/start").set(ORG)).status).toBe(409);
    await formTeams(8);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    expect((await request(app).post("/api/events/ladder-ball/bracket/semifinals/start").set(ORG)).status).toBe(409);
    const quarters: any[] = db.prepare("SELECT * FROM matches WHERE event_id='ladder-ball' AND path='MAIN' AND round=1").all();
    for (const match of quarters) expect((await request(app).post(`/api/matches/${match.id}/forfeit`).set(ORG).send({ winningTeamId: match.team_a_id })).status).toBe(200);
    expect((await request(app).post("/api/events/ladder-ball/bracket/semifinals/start").set(ORG)).status).toBe(200);
    const lockedAtFirst = db.prepare("SELECT late_entry_locked FROM events WHERE id='ladder-ball'").get();
    expect((await request(app).post("/api/events/ladder-ball/bracket/semifinals/start").set(ORG)).status).toBe(200);
    expect(db.prepare("SELECT late_entry_locked FROM events WHERE id='ladder-ball'").get()).toEqual(lockedAtFirst);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='bracket.semifinals.start' AND entity_id='ladder-ball'").get().n).toBe(1);
  });

  it.each(["CALLED", "ACTIVE", "AWAITING_CONFIRMATION", "FINAL", "DISPUTED", "SKIPPED"])("rejects late entry once any semifinal is %s without relying on manual lock", async status => {
    await formTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    const late = await signup(`late-after-${status}`);
    db.prepare("UPDATE matches SET status=? WHERE event_id='ladder-ball' AND role='SEMIFINAL' AND rowid=(SELECT min(rowid) FROM matches WHERE event_id='ladder-ball' AND role='SEMIFINAL')").run(status);
    expect(db.prepare("SELECT late_entry_locked FROM events WHERE id='ladder-ball'").get().late_entry_locked).toBe(0);
    const response = await request(app).post("/api/events/ladder-ball/bracket/late-entries").set(ORG).send({ participantId: late.id });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LATE_ENTRY_CLOSED");
  });

  it("rejects late-entry endpoint for non-head-to-head events", async () => {
    const late = await signup("not a Cannon bracket entrant");
    const response = await request(app).post("/api/events/cannon/bracket/late-entries").set(ORG).send({ participantId: late.id });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("BRACKET_NOT_SUPPORTED");
  });

  it("retires prior same-event memberships when explicit team formation is repeated", async () => {
    const people = [];
    for (let index = 0; index < 4; index++) people.push(await signup(`repeat-${index}`));
    const ids = people.map(person => person.id);
    const first = (await request(app).post("/api/events/ladder-ball/teams/form").set(ORG).send({ participantIds: ids })).body.teams;
    const secondResponse = await request(app).post("/api/events/ladder-ball/teams/form").set(ORG).send({ participantIds: ids });
    expect(secondResponse.status).toBe(201);
    for (const participantId of ids) {
      expect(db.prepare("SELECT count(*) n FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id='ladder-ball' AND tm.participant_id=? AND tm.active=1").get(participantId).n).toBe(1);
      expect(db.prepare("SELECT count(*) n FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.event_id='ladder-ball' AND tm.participant_id=?").get(participantId).n).toBe(2);
    }
    expect(first.every((team: any) => team.participantIds.every((id: string) => (db.prepare("SELECT active FROM team_members WHERE team_id=? AND participant_id=?").get(team.id, id) as any).active === 0))).toBe(true);
  });

  it("rolls back semifinal lock when its audit insert fails", async () => {
    await formTeams(4);
    await request(app).post("/api/events/ladder-ball/bracket").set(ORG);
    db.exec("CREATE TRIGGER fail_semifinal_audit BEFORE INSERT ON audit_log WHEN NEW.action='bracket.semifinals.start' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
    expect((await request(app).post("/api/events/ladder-ball/bracket/semifinals/start").set(ORG)).status).toBe(500);
    expect(db.prepare("SELECT late_entry_locked FROM events WHERE id='ladder-ball'").get().late_entry_locked).toBe(0);
  });
});
