import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";

const ORG = { Authorization: "Bearer organizer-a-very-strong-secret" };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let db: any;
let app: any;
let clock: Date;

beforeEach(() => {
  clock = new Date("2026-08-15T16:00:00.000Z");
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"], now: () => clock });
});
afterEach(() => db.close());

async function setupTimedCannon() {
  const people = [];
  for (let index = 0; index < 4; index += 1) {
    const created = (await request(app).post("/api/participants").send({ displayName: `SIM Timed ${index + 1}` })).body;
    people.push(created);
    await request(app).post("/api/events/cannon/join").set(auth(created.token));
  }
  const teams = (await request(app).post("/api/events/cannon/teams/form").set(ORG)
    .send({ participantIds: people.map(person => person.participant.id) })).body.teams;
  const setup = await request(app).post("/api/cannon/setup").set(ORG).send({
    confirm: true,
    mode: "timed",
    durationSeconds: 300,
    carnageBonus: 1000,
    targets: [
      { name: "SIMULATION TARGET A", points: 10, jackpot: false },
      { name: "SIMULATION TARGET B", points: 20, jackpot: false },
    ],
  });
  return { people, teams, run: setup.body.run, targets: setup.body.targets, target: setup.body.targets[0] };
}

describe("Cannon v2 five-minute timed team runs", () => {
  it("requires ARMED/CLEAR, permits only one active team, and locks scoring at five minutes", async () => {
    const { teams, run, targets, target } = await setupTimedCannon();
    const blocked = await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[0].id}/start`).set(ORG);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CANNON_LANE_NOT_ARMED");

    expect((await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[0].id}/arm`).set(ORG).send({ clear: true })).status).toBe(200);
    const started = await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[0].id}/start`).set(ORG);
    expect(started.status).toBe(201);
    expect(started.body.teamRun).toMatchObject({ teamId: teams[0].id, state: "ACTIVE", durationSeconds: 300 });
    expect(started.body.teamRun.deadlineAt).toBe("2026-08-15T16:05:00.000Z");

    await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[1].id}/arm`).set(ORG).send({ clear: true });
    const simultaneous = await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[1].id}/start`).set(ORG);
    expect(simultaneous.status).toBe(409);
    expect(simultaneous.body.error.code).toBe("CANNON_TEAM_ALREADY_ACTIVE");

    const carnage = await request(app).post(`/api/cannon/team-runs/${started.body.teamRun.id}/shots`).set(ORG)
      .send({ targetIds: targets.map((row: any) => row.id), carnage: true });
    expect(carnage.status).toBe(201);
    expect(carnage.body.shot.total).toBe(1030);
    expect(carnage.body.shot.carnageBonus).toBe(1000);

    for (let sequence = 2; sequence <= 21; sequence += 1) {
      const shot = await request(app).post(`/api/cannon/team-runs/${started.body.teamRun.id}/shots`).set(ORG)
        .send({ targetIds: [target.id], carnage: false });
      expect(shot.status).toBe(201);
      expect(shot.body.shot.sequence).toBe(sequence);
    }

    clock = new Date("2026-08-15T16:05:00.001Z");
    const expired = await request(app).post(`/api/cannon/team-runs/${started.body.teamRun.id}/shots`).set(ORG)
      .send({ targetIds: [target.id] });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe("CANNON_RUN_EXPIRED");
  });

  it("Safety Stop freezes an active team run and rejects later shots", async () => {
    const { teams, run, target } = await setupTimedCannon();
    await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[0].id}/arm`).set(ORG).send({ clear: true });
    const started = await request(app).post(`/api/cannon/runs/${run.id}/teams/${teams[0].id}/start`).set(ORG);
    const stopped = await request(app).post(`/api/cannon/team-runs/${started.body.teamRun.id}/safety-stop`).set(ORG)
      .send({ reason: "person downrange" });
    expect(stopped.status).toBe(200);
    expect(stopped.body.teamRun.state).toBe("SAFETY_STOPPED");
    const shot = await request(app).post(`/api/cannon/team-runs/${started.body.teamRun.id}/shots`).set(ORG)
      .send({ targetIds: [target.id] });
    expect(shot.status).toBe(409);
    expect(shot.body.error.code).toBe("CANNON_RUN_NOT_ACTIVE");
  });

  it("accepts an authoritative Paul host bearer and rejects an authoritative guest bearer", async () => {
    const { teams, run } = await setupTimedCannon();
    const externalApp = createApp({
      db,
      organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"],
      now: () => clock,
      organizerIdentityVerifier: async (token: string) => token === "paul-host-token"
        ? { subject: "user-host-paul", displayName: "Paul Host", role: "host" }
        : token === "paul-guest-token"
          ? { subject: "user-guest", displayName: "Guest User", role: "guest" }
          : null,
    });
    const host = await request(externalApp).post(`/api/cannon/runs/${run.id}/teams/${teams[0].id}/arm`)
      .set("Authorization", "Bearer paul-host-token").send({ clear: true });
    expect(host.status).toBe(200);
    const guest = await request(externalApp).post(`/api/cannon/runs/${run.id}/teams/${teams[1].id}/arm`)
      .set("Authorization", "Bearer paul-guest-token").send({ clear: true });
    expect(guest.status).toBe(401);
  });
});
