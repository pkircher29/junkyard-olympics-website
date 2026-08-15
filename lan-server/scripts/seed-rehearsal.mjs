import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createDatabase } from "../dist/src/db.js";

const dataDir = process.env.REHEARSAL_DATA_DIR;
if (!dataDir) throw new Error("REHEARSAL_DATA_DIR is required");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = createDatabase(path.join(dataDir, "event.sqlite"));
const existing = db.prepare("SELECT count(*) count FROM participants").get().count;
if (existing) {
  console.log(`REHEARSAL_SEED_SKIPPED participants=${existing}`);
  db.close();
  process.exit(0);
}
const now = new Date().toISOString();
const names = Array.from({ length: 8 }, (_, index) => `Rehearsal Adult ${String(index + 1).padStart(2, "0")}`);
const teamNames = ["Rehearsal Riveters", "Rehearsal Wreckers", "Rehearsal Welders", "Rehearsal Raccoons"];
const rows = names.map(name => ({ id: randomUUID(), name, tokenHash: createHash("sha256").update(randomUUID()).digest("hex") }));
db.transaction(() => {
  for (const row of rows) {
    db.prepare("INSERT INTO participants(id,display_name,token_hash,active,created_at) VALUES(?,?,?,1,?)").run(row.id, row.name, row.tokenHash, now);
    db.prepare("INSERT INTO event_entries(event_id,participant_id,joined_at) VALUES('cannon',?,?)").run(row.id, now);
  }
  for (let index = 0; index < teamNames.length; index += 1) {
    const teamId = randomUUID();
    db.prepare("INSERT INTO teams(id,event_id,name) VALUES(?,'cannon',?)").run(teamId, teamNames[index]);
    for (const member of rows.slice(index * 2, index * 2 + 2)) {
      db.prepare("INSERT INTO team_members(team_id,participant_id,active,substitute) VALUES(?,?,1,0)").run(teamId, member.id);
    }
  }
})();
console.log(`REHEARSAL_SEEDED participants=${rows.length} teams=${teamNames.length} event=cannon`);
db.close();
