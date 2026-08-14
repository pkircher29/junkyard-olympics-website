import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, createDatabase, restoreDatabase } from "../src/db.js";

describe("persistence operations", () => {
  const dirs: string[] = [];
  afterEach(async () =>
    Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    ),
  );

  it("backs up and restores committed state to a disposable database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junkyard-db-"));
    dirs.push(dir);
    const live = join(dir, "live.sqlite"),
      backup = join(dir, "backup.sqlite"),
      restored = join(dir, "restored.sqlite");
    const db = createDatabase(live);
    db.prepare(
      "INSERT INTO participants(id,display_name,token_hash) VALUES('p1','Survivor','hash')",
    ).run();
    await backupDatabase(db, backup);
    db.close();
    await restoreDatabase(backup, restored);
    const copy = createDatabase(restored);
    expect(
      copy
        .prepare("SELECT display_name name FROM participants WHERE id='p1'")
        .get(),
    ).toEqual({ name: "Survivor" });
    copy.close();
    expect((await readFile(backup)).length).toBeGreaterThan(0);
  });

  it("leaves a valid destination untouched when restore source is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junkyard-db-"));
    dirs.push(dir);
    const live = join(dir, "live.sqlite"), corrupt = join(dir, "corrupt.sqlite");
    const db = createDatabase(live);
    db.prepare("INSERT INTO participants(id,display_name,token_hash) VALUES('safe','Safe','safehash')").run();
    db.close();
    const before = await readFile(live);
    await writeFile(corrupt, "not sqlite");
    await expect(restoreDatabase(corrupt, live)).rejects.toThrow();
    expect(await readFile(live)).toEqual(before);
  });
});
