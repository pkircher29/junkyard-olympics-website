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

const expectedEvents = [
  ['cannon', 'Junkyard Cannon', 'OPENING'],
  ['ladder-ball', 'Ladder Ball', 'OFFICIAL'],
  ['field-pong', 'Field Pong', 'OFFICIAL'],
  ['cornhole', 'Cornhole', 'OFFICIAL'],
  ['kanjam', 'KanJam', 'OFFICIAL'],
  ['lawn-darts', 'Lawn Darts', 'OFFICIAL'],
  ['bocce-ball', 'Bocce Ball', 'OFFICIAL'],
  ['volley-strike', 'Volley Strike', 'OFFICIAL'],
  ['washers', 'Washers', 'OFFICIAL'],
  ['horseshoes', 'Horseshoes', 'CASUAL'],
  ['badminton', 'Badminton', 'CASUAL'],
];
const expectedStations = [
  ['station-1', 'The Crusher', 'ladder-ball'],
  ['station-2', 'Scrap Heap Two', 'field-pong'],
  ['station-3', 'Sack Attack', 'cornhole'],
  ['station-4', 'Can Crusher Court', 'kanjam'],
  ['station-5', 'Flight Risk', 'lawn-darts'],
  ['station-6', 'The Gravel Pit', 'bocce-ball'],
  ['station-7', 'Strike Yard', 'volley-strike'],
  ['station-8', 'Washer Wreck', 'washers'],
];

describe('confirmed event and station catalog', () => {
  it('migrates to the exact eleven-activity and eight-station catalog', async () => {
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    const state = (await request(app).get('/api/state')).body;
    expect(state.events.map((event: any) => [event.id, event.name, event.playMode])).toEqual(expectedEvents);
    expect(state.stations.map((station: any) => [station.id, station.name, station.eventId])).toEqual(expectedStations);
  });

  it('accepts casual interests but blocks tournament operations for them', async () => {
    const signup = await request(app).post('/api/participants').send({ displayName: 'Casual Casey', eventIds: ['horseshoes', 'badminton'] });
    expect(signup.status).toBe(201);
    expect((await request(app).post('/api/events/horseshoes/teams/form').set(ORG).send({})).status).toBe(409);
    expect((await request(app).post('/api/events/badminton/bracket').set(ORG).send({})).status).toBe(409);
  });

  it('calls only the event assigned to each physical station', async () => {
    for (let index = 1; index <= 8; index++) {
      db.prepare("INSERT INTO participants(id,display_name,token_hash) VALUES(?,?,?)").run(`p${index}`, `Player ${index}`, `hash${index}`);
    }
    for (const [eventId, prefix, offset] of [['ladder-ball', 'ladder', 0], ['field-pong', 'pong', 4]] as const) {
      db.prepare('INSERT INTO teams(id,event_id,name) VALUES(?,?,?),(?,?,?)').run(`${prefix}-a`, eventId, `${prefix} A`, `${prefix}-b`, eventId, `${prefix} B`);
      db.prepare('INSERT INTO team_members(team_id,participant_id) VALUES(?,?),(?,?),(?,?),(?,?)').run(`${prefix}-a`, `p${offset + 1}`, `${prefix}-a`, `p${offset + 2}`, `${prefix}-b`, `p${offset + 3}`, `${prefix}-b`, `p${offset + 4}`);
      db.prepare("INSERT INTO matches(id,event_id,team_a_id,team_b_id,status) VALUES(?,?,?,?, 'PENDING')").run(`${prefix}-match`, eventId, `${prefix}-a`, `${prefix}-b`);
    }
    const ladder = await request(app).post('/api/stations/station-1/call-next').set(ORG).send({});
    expect(ladder.status).toBe(200);
    expect(ladder.body.match.eventId).toBe('ladder-ball');
    const pong = await request(app).post('/api/stations/station-2/call-next').set(ORG).send({});
    expect(pong.status).toBe(200);
    expect(pong.body.match.eventId).toBe('field-pong');
  });
});
