import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
import { createConfiguredApp } from "../src/app-factory.js";
import { rm } from "node:fs/promises";
let db: any, app: any;
const org = { Authorization: "Bearer organizer-a-very-strong-secret" };
beforeEach(() => { db = createDatabase(":memory:"); app = createApp({ db, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] }); });
afterEach(() => db.close());
async function signup(name: string) { const r = await request(app).post("/api/participants").send({ displayName: name }); expect(r.status).toBe(201); return r.body; }
async function seed(n: number) { return Promise.all(Array.from({length:n},(_,i)=>signup(`Root Player ${i}`))); }
describe("acceptance root contracts", () => {
  it("provides an injectable persistent app factory without starting a process", async () => {
    const root = `/tmp/junkyard-factory-${process.pid}-${Date.now()}`;
    const first = await createConfiguredApp({ databasePath: `${root}.sqlite`, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] });
    const participant = await request(first).post("/api/participants").send({ displayName: "Restart survivor" });
    const second = await createConfiguredApp({ databasePath: `${root}.sqlite`, organizerTokens: ["organizer-a-very-strong-secret", "organizer-b-very-strong-secret"] });
    expect((await request(second).get("/api/me").set("Authorization", `Bearer ${participant.body.token}`)).body.participant.id).toBe(participant.body.participant.id);
    await rm(`${root}.sqlite`, { force: true });
  });
  it("supports isolated participant resource PATCH and 256-character safe names", async () => {
    const [owner, other] = await seed(2);
    expect((await request(app).patch(`/api/participants/${owner.participant.id}`).set("Authorization", `Bearer ${other.token}`).send({displayName:"stolen"})).status).toBe(403);
    expect((await request(app).patch(`/api/participants/${owner.participant.id}`).set("Authorization", `Bearer ${owner.token}`).send({displayName:"updated"})).body.participant.displayName).toBe("updated");
    expect((await request(app).post("/api/participants").send({displayName:`<script>globalThis.PWNED=1</script><img src=x onerror=alert(1)>`})).status).toBe(201);
    expect((await request(app).post("/api/participants").send({displayName:"x".repeat(257)})).status).toBe(400);
  });
  it("forms bracket from explicit current team IDs rather than accumulated event teams", async () => {
    const ps = await seed(16);
    await request(app).post("/api/events/ladder-ball/teams/form").set(org).send({participantIds:ps.map(p=>p.participant.id)});
    const selected=(await request(app).post("/api/events/ladder-ball/teams/form").set(org).send({participantIds:ps.slice(0,8).map(p=>p.participant.id)})).body.teams;
    const bracket=(await request(app).post("/api/events/ladder-ball/bracket").set(org).send({teamIds:selected.map((t:any)=>t.id)})).body.bracket;
    expect(bracket.mainMatches.filter((m:any)=>m.round===1)).toHaveLength(2);
  });
  it("supports Flair labels, aliases, idempotency and burst limits", async () => {
    const [a,b]=await seed(2); const auth={Authorization:`Bearer ${a.token}`};
    const prop={recipientId:b.participant.id,category:"Best Costume",idempotencyKey:"prop-root"};
    expect((await request(app).post("/api/flair/props").set(auth).send(prop)).status).toBe(201);
    expect((await request(app).post("/api/flair/props").set(auth).send(prop)).status).toBe(200);
    expect((await request(app).put("/api/flair/showboat-vote").set(auth).send({recipientId:b.participant.id,idempotencyKey:"vote-root"})).status).toBe(201);
    expect((await request(app).get("/api/standings/flair")).body.standings[0]).toMatchObject({propPoints:1,votePoints:3,total:4});
  });
  it("exposes acceptance placement and championship response aliases", async () => {
    const [p]=await seed(1);
    expect((await request(app).post("/api/admin/acceptance/placements").set(org).send({participantId:p.participant.id,cannon:7,field:[10,7,5,3,1]})).status).toBe(201);
    const row=(await request(app).get("/api/standings/championship")).body.standings[0];
    expect(row).toMatchObject({total:29,countedFieldPoints:[10,7,5],droppedFieldPoints:[3,1],eligible:true});
  });
  it("filters requested cooldown participants and exposes substitution participant aliases", async () => {
    const ps=await seed(5); const teams=(await request(app).post("/api/events/ladder-ball/teams/form").set(org).send({participantIds:ps.slice(0,4).map(p=>p.participant.id)})).body.teams;
    const bracket=(await request(app).post("/api/events/ladder-ball/bracket").set(org).send({teamIds:teams.map((t:any)=>t.id)})).body.bracket;
    const match=bracket.mainMatches[0], completedAt="2026-08-15T19:00:00.000Z";
    await request(app).post(`/api/matches/${match.id}/complete`).set(org).send({winnerTeamId:match.teamIds[0],completedAt});
    expect((await request(app).post("/api/schedule/call-next").set(org).send({stationId:"station-1",now:"2026-08-15T19:04:59.000Z",participantIds:match.participantIds})).body.match).toBeNull();
    const leaver=ps.find(p=>match.participantIds.includes(p.participant.id))!;
    await request(app).post("/api/participants/me/departure").set("Authorization",`Bearer ${leaver.token}`);
    const sub=(await request(app).post(`/api/matches/${match.id}/substitutions/auto`).set(org)).body.substitution;
    expect(sub).toMatchObject({leavingParticipantId:leaver.participant.id,reversible:true,public:true});
    expect(sub.inParticipantId).toBeTruthy();
  });
  it("provides authenticated operational aliases and CSV formula protection", async () => {
    await signup("=2+2");
    expect((await request(app).post("/api/admin/backups")).status).toBe(401);
    const backup=await request(app).post("/api/admin/backups").set(org).send({}); expect(backup.status).toBe(201);
    expect((await request(app).get("/api/admin/export.json").set(org)).status).toBe(200);
    const csv=await request(app).get("/api/admin/export.csv").set(org); expect(csv.text).toContain("'=2+2");
    expect((await request(app).get("/api/admin/audit").set(org)).body.entries).toBeInstanceOf(Array);
  });
  it("public HTML carries frozen marker contracts", async () => {
    const tv=(await request(app).get("/tv")).text.toLowerCase(); for(const m of ["signup","standings","match","cannon","flair"]) expect(tv).toContain(m);
    const station=(await request(app).get("/station/station-1")).text.toLowerCase(); for(const m of ["station check-in","printed station qr","competitor pass","station-match","station-check-in","station-page.js"]) expect(station).toContain(m); for(const fixture of ["rusted legends","trash pandas","04:12"]) expect(station).not.toContain(fixture);
    const print=(await request(app).get("/print")).text; const printLower=print.toLowerCase(); expect(print).toContain('href="/public-print-packet.pdf"'); expect(printLower).toContain("verified public emergency materials"); for(const stale of ["participant roster","station queues","last backup:","phase: cannon complete"]) expect(printLower).not.toContain(stale);
  });
});
