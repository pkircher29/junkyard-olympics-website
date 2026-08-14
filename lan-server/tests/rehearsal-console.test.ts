import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("event-safe rehearsal consoles", () => {
  it("organizer console uses real state and supported authenticated operations", async () => {
    const html = await readFile("public/organizer.html", "utf8");
    const js = await readFile("public/js/organizer-console.js", "utf8");
    expect(html).toContain('id="station-select"');
    expect(html).toContain('id="disputes"');
    expect(html).not.toContain('data-action="toast"');
    expect(js).toContain("api.getState()");
    expect(js).toContain("/call-next");
    expect(js).toContain("/api/admin/backups");
    expect(js).toContain("/api/disputes/");
    expect(js).toContain("lockMutations");
  });

  it("Cannon console derives valid choices from real configuration and never demo-saves", async () => {
    const html = await readFile("public/cannon.html", "utf8");
    const js = await readFile("public/js/cannon-console.js", "utf8");
    expect(html).toContain('id="cannon-form"');
    expect(html).not.toContain('data-action="toast"');
    expect(js).toContain("state.cannonRuns");
    expect(js).toContain("state.cannonAssignments");
    expect(js).toContain("state.targets");
    expect(js).toContain("/shots");
    expect(js).toContain("api.demo");
    expect(js).toContain("lockMutations");
  });
});