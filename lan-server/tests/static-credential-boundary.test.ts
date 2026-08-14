import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";

let db: any;
let app: any;
const organizerTokens = ["server-only-organizer-secret-a", "server-only-organizer-secret-b"];

beforeEach(() => {
  db = createDatabase(":memory:");
  app = createApp({ db, organizerTokens });
});
afterEach(() => db.close());

describe("static credential boundary", () => {
  it("never embeds configured organizer credentials in browser assets", async () => {
    for (const asset of ["/organizer.html", "/cannon.html", "/print.html", "/js/auth.js", "/js/api.js"]) {
      const response = await request(app).get(asset);
      expect(response.status).toBe(200);
      for (const secret of organizerTokens) expect(response.text).not.toContain(secret);
    }
  });

  it("routes every organizer print action to the verified public PDF", async () => {
    const organizer = await request(app).get("/organizer.html");
    expect(organizer.text).toContain('href="/public-print-packet.pdf"');
    expect(organizer.text).not.toContain('href="/print.html"');

    const legacy = await request(app).get("/print.html");
    expect(legacy.status).toBe(200);
    expect(legacy.text).toContain('href="/public-print-packet.pdf"');
    for (const staleFixture of ["CURRENT STATE PACKET", "Last backup: 1:58 PM", "PHASE: CANNON COMPLETE"]) {
      expect(legacy.text).not.toContain(staleFixture);
    }

    const packet = await request(app).get("/public-print-packet.pdf");
    expect(packet.status).toBe(200);
    expect(packet.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(Buffer.isBuffer(packet.body)).toBe(true);
    expect(packet.body.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("contains no bearer credentials or token query links in static assets", async () => {
    for (const asset of ["/", "/participant.html", "/organizer.html", "/cannon.html", "/print.html", "/js/auth.js", "/js/api.js"]) {
      const text = (await request(app).get(asset)).text;
      expect(text).not.toMatch(/[?&]token=/i);
      expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{24,}/);
    }
  });
});
