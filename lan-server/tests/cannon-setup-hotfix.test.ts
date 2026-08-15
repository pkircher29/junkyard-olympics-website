import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

let db: any;
let app: any;
const ORG = { Authorization: 'Bearer organizer-a-very-strong-secret' };

beforeEach(() => {
  db = createDatabase(':memory:');
  app = createApp({ db, organizerTokens: ['organizer-a-very-strong-secret', 'organizer-b-very-strong-secret'] });
});
afterEach(() => db.close());

async function cannonEntrants(count: number) {
  for (let index = 0; index < count; index++) {
    const response = await request(app).post('/api/participants').send({ displayName: `Cannon Adult ${index + 1}`, eventIds: ['cannon'] });
    expect(response.status).toBe(201);
  }
}

describe('Cannon physical setup hotfix', () => {
  it('migrates assignments to permit reusable physical lane ids', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cannon_run_assignments'").get().sql).toLowerCase();
    expect(sql).toContain('primary key(run_id,team_id)');
    expect(sql).not.toContain('unique(run_id,lane_id)');
  });

  it('atomically configures fifteen Cannon teams across exactly two physical lanes', async () => {
    await cannonEntrants(30);
    const formed = await request(app).post('/api/events/cannon/teams/form').set(ORG).send({});
    expect(formed.status).toBe(201);
    expect(formed.body.teams).toHaveLength(15);

    const setup = await request(app).post('/api/cannon/setup').set(ORG).send({
      confirm: true,
      targets: [
        { name: 'Rusty Bucket', points: 10 },
        { name: 'Million Point Washer', points: 1_000_000, jackpot: true },
      ],
    });
    expect(setup.status).toBe(201);
    expect(setup.body.run.assignments).toHaveLength(15);
    expect(new Set(setup.body.run.assignments.map((item: any) => item.laneId))).toEqual(new Set(['Lane 1', 'Lane 2']));
    expect(setup.body.run.assignments.filter((item: any) => item.laneId === 'Lane 1')).toHaveLength(8);
    expect(setup.body.run.assignments.filter((item: any) => item.laneId === 'Lane 2')).toHaveLength(7);

    const state = (await request(app).get('/api/state')).body;
    expect(state.cannonRuns).toHaveLength(1);
    expect(state.targets).toHaveLength(2);
    expect(state.cannonAssignments).toHaveLength(15);

    const replay = await request(app).post('/api/cannon/setup').set(ORG).send({ confirm: true, targets: [{ name: 'Other', points: 1 }] });
    expect(replay.status).toBe(409);
    expect((await request(app).get('/api/state')).body).toMatchObject({ cannonRuns: state.cannonRuns, targets: state.targets });
  });

  it('keeps setup organizer-only and requires confirmation, teams, and targets', async () => {
    expect((await request(app).post('/api/cannon/setup').send({ confirm: true, targets: [{ name: 'Can', points: 1 }] })).status).toBe(401);
    expect((await request(app).post('/api/cannon/setup').set(ORG).send({ confirm: false, targets: [{ name: 'Can', points: 1 }] })).status).toBe(400);
    expect((await request(app).post('/api/cannon/setup').set(ORG).send({ confirm: true, targets: [] })).status).toBe(400);
    expect((await request(app).post('/api/cannon/setup').set(ORG).send({ confirm: true, targets: [{ name: 'Can', points: 1 }] })).status).toBe(409);
  });
});
