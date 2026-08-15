import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "../../site");
const read = (relative: string) => readFile(path.join(site, relative), "utf8");
const readJson = async (relative: string) => JSON.parse(await read(relative));

describe("organizer-only Cannon website dashboard", () => {
  it("keeps Cannon controls out of participant navigation and removes the legacy popup", async () => {
    const [index, views] = await Promise.all([read("index.html"), read("js/views.js")]);
    expect(index).not.toContain('href="#/cannon"');
    expect(views).not.toContain('/cannon.html');
    expect(views).toContain("if (!Auth.isHost)");
  });

  it("renders a fail-closed loading shell and no arbitrary HQ URL control", async () => {
    const [views, app] = await Promise.all([read("js/views.js"), read("js/app.js")]);
    expect(views).toContain('id="cannon-admin"');
    expect(views).toContain('data-cannon-state="loading"');
    expect(views).toContain("CHECKING EVENT HQ");
    expect(views).toContain('id="cannon-target-editor"');
    expect(views).toMatch(/data-action="cannon-setup-save"[^>]*disabled/);
    expect(views).toMatch(/data-action="cannon-safety-stop"[^>]*disabled/);
    expect(views).not.toContain('id="hq-url"');
    expect(app).not.toContain("case 'hq-save'");
  });

  it("wires each organizer action to the authenticated v2 API and rechecks host role", async () => {
    const app = await read("js/app.js");
    for (const action of ["cannon-setup-save", "cannon-arm", "cannon-start", "cannon-hit", "cannon-carnage", "cannon-safety-stop"])
      expect(app).toContain(`case '${action}'`);
    expect(app).toContain("if (!Auth.isHost) throw new Error('Hosts only.')");
    expect(app).toContain("/api/cannon/setup");
    expect(app).toContain("/shots");
    expect(app).toContain("/safety-stop");
    expect(app).toContain("loadCannonAdmin");
  });

  it("routes hosted Event HQ credentials through the secure same-origin tunnel only", async () => {
    const app = await read("js/app.js");
    expect(app).toContain("EVENT_HQ_PREFIX");
    expect(app).toContain("'/hq-api'");
    expect(app).toContain("eventHqRequest");
    expect(app).not.toMatch(/X-Junkyard-User-Name/i);
  });

  it("ships the approved compact bell-curve scoring table as data", async () => {
    const scoring = await readJson("data/cannon-scoring-v2.json");
    expect(scoring).toMatchObject({ version: 2, durationSeconds: 300, teamSize: 2, carnageBonus: 1000 });
    const byId = Object.fromEntries(scoring.targets.map((target: any) => [target.id, target]));
    expect(byId.T01).toMatchObject({ label: "Tiny Golden Washer", points: 10000, enabled: true, jackpot: true });
    expect(byId.T02.points).toBe(1000);
    expect(byId.T03.points).toBe(500);
    expect(byId.T17.points).toBe(10);
    expect(byId.T13.enabled).toBe(false);
    expect(byId.T19.enabled).toBe(false);
    expect(Math.max(...scoring.targets.filter((target: any) => target.enabled).map((target: any) => target.points))).toBe(10000);
    expect(new Set(scoring.targets.map((target: any) => target.points))).toEqual(new Set([10, 50, 100, 250, 500, 1000, 10000]));
  });
});
