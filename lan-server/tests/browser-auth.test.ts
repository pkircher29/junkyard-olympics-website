import { beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  protected values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

class ThrowingStorage extends MemoryStorage {
  constructor(private operation: "all" | "set" = "all") { super(); }
  override getItem(key: string) {
    if (this.operation === "all") throw new DOMException("denied", "SecurityError");
    return super.getItem(key);
  }
  override setItem(_key: string, _value: string) { throw new DOMException("denied", "SecurityError"); }
  override removeItem(key: string) {
    if (this.operation === "all") throw new DOMException("denied", "SecurityError");
    super.removeItem(key);
  }
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

async function loadAuth({ hash = "", search = "", session = new MemoryStorage(), local = new MemoryStorage() }: {
  hash?: string; search?: string; session?: StorageLike; local?: StorageLike;
} = {}) {
  vi.resetModules();
  const replaceState = vi.fn();
  vi.stubGlobal("location", { hash, search, pathname: "/organizer.html", origin: "https://yard.test" });
  vi.stubGlobal("history", { replaceState });
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  // @ts-expect-error browser module intentionally has no TypeScript declarations
  const auth = await import("../public/js/auth.js");
  return { auth, session, local, replaceState };
}

async function loadApi(fetchImpl = vi.fn()) {
  vi.resetModules();
  vi.stubGlobal("location", { hash: "", search: "", pathname: "/", origin: "https://yard.test" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("fetch", fetchImpl);
  // @ts-expect-error browser module intentionally has no TypeScript declarations
  const module = await import("../public/js/api.js");
  // @ts-expect-error browser module intentionally has no TypeScript declarations
  const auth = await import("../public/js/auth.js");
  return { ...module, auth, session, local, fetchImpl };
}

beforeEach(() => vi.unstubAllGlobals());

describe("browser credential bridge", () => {
  it("consumes a valid organizer fragment once and immediately sanitizes the URL", async () => {
    const token = "organizer-browser-token-123456789";
    const { auth, session, replaceState } = await loadAuth({ hash: `#token=${token}` });
    expect(auth.getOrganizerToken()).toBe(token);
    expect(session.getItem("junkyard-olympics:organizer-token")).toBe(token);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/organizer.html");
  });

  it.each([
    "?token=query-secret&heat=2",
    "?access_token=query-secret&heat=2",
    "?AUTH=query-secret&heat=2",
  ])("scrubs credential query names without accepting them: %s", async search => {
    const { auth, replaceState } = await loadAuth({ search });
    expect(auth.getOrganizerToken()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/organizer.html?heat=2");
  });

  it("scrubs hostile fragments and credential queries before a denied storage write", async () => {
    const { auth, replaceState } = await loadAuth({
      hash: "#token=organizer-browser-token-123456789",
      search: "?round=3&token=leak",
      session: new ThrowingStorage(),
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/organizer.html?round=3");
    expect(auth.getOrganizerToken()).toBeNull();
    expect(auth.getCredentialStorageState().organizer).toBe("unavailable");
  });

  it("guards every storage operation and fails closed when storage is unavailable", async () => {
    const { auth } = await loadAuth({ session: new ThrowingStorage(), local: new ThrowingStorage() });
    expect(auth.getOrganizerToken()).toBeNull();
    expect(auth.getParticipantToken()).toBeNull();
    expect(auth.canPersistParticipantToken()).toBe(false);
    expect(auth.clearParticipantToken()).toBe(false);
    expect(auth.getCredentialStorageState()).toEqual({ organizer: "unavailable", participant: "unavailable", participantFallback: false });
  });

  it("guards SecurityError while obtaining browser storage objects", async () => {
    vi.resetModules();
    vi.stubGlobal("location", { hash: "#token=organizer-browser-token-123456789", search: "?token=leak&heat=2", pathname: "/organizer.html" });
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const auth = await import("../public/js/auth.js");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/organizer.html?heat=2");
    expect(auth.getOrganizerToken()).toBeNull();
    expect(auth.getParticipantToken()).toBeNull();
    expect(auth.canPersistParticipantToken()).toBe(false);
    expect(auth.clearParticipantToken()).toBe(false);
    expect(auth.getCredentialStorageState()).toEqual({ organizer: "unavailable", participant: "unavailable", participantFallback: false });
  });

  it("stores signup identity and clears it on device reset", async () => {
    const { auth, local } = await loadAuth();
    expect(auth.canPersistParticipantToken()).toBe(true);
    expect(auth.storeParticipantToken("participant-browser-token-123456789")).toEqual({ persisted: true, recoveryRequired: false });
    expect(auth.getParticipantToken()).toBe("participant-browser-token-123456789");
    expect(auth.clearParticipantToken()).toBe(true);
    expect(local.getItem("junkyard-olympics:participant-token")).toBeNull();
  });
});

describe("authenticated request boundary", () => {
  it.each([
    "https://evil.invalid/steal",
    "//evil.invalid/steal",
    "api/me",
    "/participant.html",
    "/api",
    "/api/../organizer.html",
  ])("rejects hostile or non-API request target before fetch: %s", async path => {
    const { api, session, fetchImpl } = await loadApi();
    session.setItem("junkyard-olympics:organizer-token", "organizer-browser-token-123456789");
    await expect(api.organizerRequest(path)).rejects.toThrow("relative /api/ path");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["Authorization", "authorization", "AUTHORIZATION"])("rejects caller-controlled %s before fetch", async header => {
    const { api, session, fetchImpl } = await loadApi();
    session.setItem("junkyard-olympics:organizer-token", "organizer-browser-token-123456789");
    await expect(api.organizerRequest("/api/probe", { headers: { [header]: "Bearer attacker" } })).rejects.toThrow("Authorization");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("browser network interception sees only the generated actor bearer on a same-origin API path", async () => {
    const intercepted: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      intercepted.push([input, init]);
      return new Response(null, { status: 204 });
    });
    const { api, session } = await loadApi(fetchImpl);
    session.setItem("junkyard-olympics:organizer-token", "organizer-browser-token-123456789");
    await api.organizerRequest("/api/probe?heat=2", { headers: { "X-Trace": "ok" } });
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]?.[0]).toBe("/api/probe?heat=2");
    expect(intercepted[0]?.[1]?.headers).toEqual({
      Accept: "application/json",
      "x-trace": "ok",
      Authorization: "Bearer organizer-browser-token-123456789",
    });
  });

  it("preflights durable participant storage before signup POST", async () => {
    const { api, fetchImpl } = await loadApi();
    vi.stubGlobal("localStorage", new ThrowingStorage());
    await expect(api.signup("Rivet Rosie", ["cannon"])).rejects.toMatchObject({ code: "PARTICIPANT_STORAGE_UNAVAILABLE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("locks signup in visible recovery state when the final credential write unexpectedly fails", async () => {
    const token = "participant-browser-token-123456789";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ participant: { id: "p1" }, token }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const { api, auth, local } = await loadApi(fetchImpl);
    const originalSet = local.setItem.bind(local);
    let writes = 0;
    local.setItem = (key: string, value: string) => {
      writes += 1;
      if (writes > 1) throw new DOMException("full", "QuotaExceededError");
      originalSet(key, value);
    };
    const signup = await api.signup("Rivet Rosie", ["cannon"]);
    expect(signup).toMatchObject({
      recoveryRequired: true,
      recoveryMessage: expect.stringMatching(/keep this page open/i),
      participant: { id: "p1" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(auth.getParticipantToken()).toBe(token);
    expect(auth.getCredentialStorageState()).toEqual({ organizer: "available", participant: "unavailable", participantFallback: true });
  });
});
