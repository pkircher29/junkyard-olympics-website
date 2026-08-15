import { describe, expect, it, vi } from "vitest";
import { createSessionVerifier } from "../src/session-verifier.js";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("strict Paul session verifier", () => {
  it("requires HTTPS and returns the authoritative bounded identity", async () => {
    expect(() => createSessionVerifier("http://music.example/api/session")).toThrow(/HTTPS/);
    const fetch = vi.fn(async () => response({ user: { id: "user-host-paul", name: "Paul Host", role: "host" } }));
    const verify = createSessionVerifier("https://music.example/api/session", { fetch });
    await expect(verify("opaque-bearer")).resolves.toEqual({ subject: "user-host-paul", displayName: "Paul Host", role: "host" });
    expect(fetch).toHaveBeenCalledWith("https://music.example/api/session", expect.objectContaining({
      headers: { Authorization: "Bearer opaque-bearer" },
    }));
  });

  it.each([
    ["non-200", response({ error: "no" }, 401)],
    ["malformed JSON", new Response("not-json")],
    ["missing user", response({})],
    ["extra top-level field", response({ user: { id: "u1", name: "Paul Host", role: "host" }, token: "leak" })],
    ["extra user field", response({ user: { id: "u1", name: "Paul Host", role: "host", token: "leak" } })],
    ["invalid role", response({ user: { id: "u1", name: "Paul Host", role: "admin" } })],
    ["unbounded name", response({ user: { id: "u1", name: "P".repeat(25), role: "host" } })],
  ])("fails closed for %s", async (_label, candidate) => {
    const verify = createSessionVerifier("https://music.example/api/session", { fetch: vi.fn(async () => candidate) });
    await expect(verify("opaque-bearer")).resolves.toBeNull();
  });
});
