import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFile(resolve(root, path), "utf8");

describe("mobile signup acceptance contract", () => {
  it("uses an artwork-led progressive two-step signup with plain-language actions", async () => {
    const html = await read("public/index.html");
    expect(html).toContain('class="signup-hero-art"');
    expect(html).toContain("/assets/junkyard-mobile-hero.webp");
    expect(html).toContain('id="signup-step-name"');
    expect(html).toContain('id="signup-step-events"');
    expect(html).toContain('id="signup-confirmation"');
    expect(html).toContain("What should we call you?");
    expect(html).toContain("Pick my events");
    expect(html).toContain("Enter the Junkyard");
    expect(html).toContain("Open my dashboard");
    expect(html.indexOf('id="signup-step-name"')).toBeLessThan(html.indexOf('id="signup-step-events"'));
    expect(html).not.toMatch(/Competitor intake|Pick your wreckage/);
  });

  it("declares mobile tap and type sizes and prevents horizontal overflow", async () => {
    const css = await read("public/styles.css");
    expect(css).toMatch(/\.mobile-page\s*\{[^}]*font-size:\s*17px/s);
    expect(css).toMatch(/\.signup-input\s*\{[^}]*font-size:\s*(?:20px|1\.25rem)/s);
    expect(css).toMatch(/\.primary-action\s*\{[^}]*min-height:\s*56px/s);
    expect(css).toMatch(/\.event-choice\s*\{[^}]*min-height:\s*72px/s);
    expect(css).toMatch(/html\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("uses local artwork only", async () => {
    const html = await read("public/index.html");
    expect(html).not.toMatch(/https?:\/\//);
    await expect(read("public/assets/junkyard-mobile-hero.webp")).resolves.not.toHaveLength(0);
  });
});

describe("participant urgency feed acceptance contract", () => {
  it("orders feed sections by urgency and removes dashboard tabs", async () => {
    const html = await read("public/participant.html");
    const ids = ["participant-progress", "do-this-now", "up-next", "your-results", "flair", "championship-standings", "device-reset"];
    const offsets = ids.map(id => html.indexOf(`id="${id}"`));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(html).not.toMatch(/class="tabs"|class="tab\b/);
  });

  it("does not ship fake participant or called-match state in live markup", async () => {
    const html = await read("public/participant.html");
    expect(html).not.toMatch(/Rivet Rosie|Rusted Legends|Trash Pandas|04:12|The Crusher/);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("No match is calling you right now");
    expect(html).toContain("Demo preview");
  });
});

describe("signup API event selection", () => {
  it("atomically joins the available events selected at signup", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ db, organizerTokens: ["test-organizer-token-chris-123456789", "test-organizer-token-paul-123456789"] });
    try {
      const response = await request(app)
        .post("/api/participants")
        .send({ displayName: "Rivet Rosie", eventIds: ["cannon", "field-pong"] })
        .expect(201);
      const me = await request(app)
        .get("/api/me")
        .set("Authorization", `Bearer ${response.body.token}`)
        .expect(200);
      expect(me.body.events.map((event: { id: string }) => event.id)).toEqual(["cannon", "field-pong"]);
    } finally {
      db.close();
    }
  });
});

describe("signup flow model", () => {
  it("requires a name before revealing events and Cannon before final entry", async () => {
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const { createSignupFlow, advanceToEvents, toggleEvent, canEnter } = await import("../public/js/signup-flow.js");
    const events = [
      { id: "cannon", name: "Junkyard Cannon", kind: "cannon", available: 1 },
      { id: "pong", name: "Field Pong", kind: "head-to-head", available: 1 },
    ];
    const start = createSignupFlow(events);
    expect(start.step).toBe("name");
    expect(() => advanceToEvents(start, " ")).toThrow(/name/i);
    const choosing = advanceToEvents(start, "  Rivet Rosie  ");
    expect(choosing).toMatchObject({ step: "events", displayName: "Rivet Rosie" });
    expect(canEnter(choosing)).toBe(false);
    expect(canEnter(toggleEvent(choosing, "pong"))).toBe(false);
    expect(canEnter(toggleEvent(choosing, "cannon"))).toBe(true);
  });
});

describe("participant feed model", () => {
  it("uses demo fixtures only in explicit demo mode and otherwise renders a truthful empty feed", async () => {
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const { buildParticipantFeed } = await import("../public/js/participant-feed.js");
    const fixture = { me: { name: "Demo Dana" }, activeMatch: { id: "m1" }, events: [{ id: "e1" }] };
    expect(buildParticipantFeed({ demoMode: false, liveData: null, demoData: fixture })).toMatchObject({ mode: "empty", activeMatch: null, events: [] });
    expect(buildParticipantFeed({ demoMode: true, liveData: null, demoData: fixture })).toMatchObject({ mode: "demo", activeMatch: { id: "m1" } });
    expect(buildParticipantFeed({ demoMode: false, liveData: { participant: { displayName: "Live Lee" }, events: [] }, demoData: fixture })).toMatchObject({ mode: "live", name: "Live Lee", activeMatch: null });
  });
});

describe("called-match countdown", () => {
  it("calculates a five-minute deadline and formats normal, ending, and expired states", async () => {
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const { callDeadline, formatCallCountdown } = await import("../public/js/call-countdown.js");
    const calledAt = "2026-08-13T20:00:00.000Z";
    expect(callDeadline(calledAt)).toBe(Date.parse("2026-08-13T20:05:00.000Z"));
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-13T20:00:48.000Z"))).toBe("4:12 to check in");
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-13T20:04:31.000Z"))).toBe("Call window ending");
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-13T20:05:00.000Z"))).toBe("Organizer is requeuing this match");
  });

  it("ticks live once per second, clears stale timers, and leaves demo countdown unchanged", async () => {
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const { createCallCountdownTicker } = await import("../public/js/call-countdown.js");
    const rendered: string[] = [];
    const callbacks: Array<() => void> = [];
    const cleared: number[] = [];
    let now = Date.parse("2026-08-13T20:00:48.000Z");
    const ticker = createCallCountdownTicker({
      render: (text: string) => rendered.push(text),
      now: () => now,
      setIntervalFn: (callback: () => void, delay: number) => {
        expect(delay).toBe(1000);
        callbacks.push(callback);
        return 17;
      },
      clearIntervalFn: (timer: number) => cleared.push(timer),
    });

    ticker.show({ calledAt: "2026-08-13T20:00:00.000Z" });
    expect(rendered).toEqual(["4:12 to check in"]);
    now += 1000;
    callbacks[0]!();
    expect(rendered.at(-1)).toBe("4:11 to check in");
    ticker.show(null);
    expect(cleared).toEqual([17]);

    ticker.show({ deadline: "04:12" }, { demo: true });
    expect(rendered.at(-1)).toBe("04:12");
    expect(callbacks).toHaveLength(1);
  });
});
