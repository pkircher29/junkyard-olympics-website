import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("truthful TV broadcast boundary", () => {
  it("ships an empty live shell with no sample competitors, teams, stations, or scores", async () => {
    const html = await read("public/tv.html");
    for (const fake of [
      "Rivet Rosie",
      "Dumpster Dan",
      "Rusted Legends",
      "Trash Pandas",
      "Tetanus Tina",
      "The Crusher",
      "185",
      "160",
    ]) expect(html).not.toContain(fake);
    expect(html).toContain('id="broadcast-idle"');
    expect(html).toContain('src="/js/tv-broadcast.js"');
    expect(html).toContain('id="connection-badge"');
    expect(html).not.toContain("data-connection");
    expect(html).not.toMatch(/organizer|authorization|bearer/i);
  });

  it("uses sample data only when the exact demo=1 query flag is present", async () => {
    const { isDemoMode, initialBroadcastData } = await import("../public/js/tv-core.js");
    expect(isDemoMode("?demo=1")).toBe(true);
    expect(isDemoMode("?demo=true")).toBe(false);
    expect(isDemoMode("?mode=demo")).toBe(false);
    expect(initialBroadcastData("?demo=1").participants.length).toBeGreaterThan(0);
    expect(initialBroadcastData("")).toEqual(null);
  });

  it("maps only authoritative API relations and prioritizes a called match", async () => {
    const { mapApiBroadcastData } = await import("../public/js/tv-core.js");
    const state = {
      participants: [
        { id: "p1", displayName: "Alex" }, { id: "p2", displayName: "Blair" },
        { id: "p3", displayName: "Casey" }, { id: "p4", displayName: "Devon" },
      ],
      events: [{ id: "cornhole", name: "Cornhole" }, { id: "cannon", name: "Junkyard Cannon" }],
      teams: [
        { id: "a", eventId: "cornhole", name: "Axles" }, { id: "b", eventId: "cornhole", name: "Bearings" },
        { id: "c", eventId: "cannon", name: "Clankers" },
      ],
      teamMembers: [
        { teamId: "a", participantId: "p1", active: 1 }, { teamId: "a", participantId: "p2", active: 1 },
        { teamId: "b", participantId: "p3", active: 1 }, { teamId: "b", participantId: "p4", active: 1 },
      ],
      stations: [{ id: "s1", name: "North Bay", available: 1 }, { id: "s2", name: "South Bay", available: 0 }],
      matches: [
        { id: "active", eventId: "cornhole", status: "ACTIVE", stationId: "s2", teamAId: "a", teamBId: "b", calledAt: "2026-08-15T18:00:00.000Z", startedAt: "2026-08-15T18:01:00.000Z" },
        { id: "called", eventId: "cornhole", status: "CALLED", stationId: "s1", teamAId: "a", teamBId: "b", calledAt: "2026-08-15T18:02:00.000Z" },
        { id: "next", eventId: "cornhole", status: "PENDING", stationId: null, teamAId: "a", teamBId: "b" },
      ],
      cannonRuns: [{ id: "r1", eventId: "cannon", createdAt: "2026-08-15T17:00:00.000Z" }],
      cannonAssignments: [{ runId: "r1", teamId: "c", laneId: "lane-1" }],
      cannonShots: [{ runId: "r1", teamId: "c", laneId: "lane-1", kind: "scored", sequence: 1, points: 25, targetNames: ["Hubcap"] }],
      targets: [{ id: "t1", name: "Hubcap", points: 25, jackpot: 0 }],
      flairFeed: [{ id: "f1", recipientDisplayName: "Alex", category: "BEST_COSTUME", createdAt: "2026-08-15T18:02:30.000Z" }],
    };
    const championship = { standings: [{ participantId: "p1", displayName: "Alex", total: 29, eligible: true, countedFieldPoints: [10, 7, 5], droppedFieldPoints: [3] }], podium: [{ participantId: "p1", displayName: "Alex", total: 29, eligible: true }] };
    const flair = { standings: [{ participantId: "p1", displayName: "Alex", total: 4, categories: { "Best Costume": 1 } }] };
    const mapped = mapApiBroadcastData(state, championship, flair);
    expect(mapped.featuredMatch).toMatchObject({ id: "called", station: "North Bay", event: "Cornhole", teamA: "Axles", teamB: "Bearings", calledAt: "2026-08-15T18:02:00.000Z" });
    expect(mapped.featuredMatch.teamAPlayers).toEqual(["Alex", "Blair"]);
    expect(mapped.queue.map((match: any) => match.id)).toEqual(["next"]);
    expect(mapped.cannonLanes[0]).toMatchObject({ laneId: "lane-1", team: "Clankers", scoredShots: 1, total: 25, lastTargets: ["Hubcap"] });
    expect(mapped.standings).toEqual(championship.standings);
    expect(mapped.podium).toEqual(championship.podium);
    expect(mapped.stations).toHaveLength(2);
    expect(mapped.flairStandings).toEqual(flair.standings);
    expect(mapped.flairFeed[0].recipientDisplayName).toBe("Alex");
    expect(mapped.roster).toEqual(state.participants);
    const { normalizeBroadcastRoster } = await import("../public/js/tv-core.js");
    expect(normalizeBroadcastRoster(["Demo Dana", { id: "p1", displayName: "Alex" }])).toEqual([
      { displayName: "Demo Dana", active: 1, eventCount: 0 },
      { id: "p1", displayName: "Alex" },
    ]);
  });

  it("normalizes Paul's public music queue without inventing unavailable or empty tracks", async () => {
    const { normalizePublicMusicQueue } = await import("../public/js/tv-core.js");
    expect(normalizePublicMusicQueue({
      now_playing: { track: { name: "Sabotage", artists: [{ name: "Beastie Boys" }] }, user_name: "Paul" },
      up_next: [{ pos: 1, user_name: "Alex", track: { name: "Song 2", artists: [{ name: "Blur" }] } }],
    })).toEqual({
      status: "ready",
      nowPlaying: { title: "Sabotage", artist: "Beastie Boys", requestedBy: "Paul" },
      queue: [{ position: 1, title: "Song 2", artist: "Blur", requestedBy: "Alex" }],
    });
    expect(normalizePublicMusicQueue({ now_playing: null, up_next: [] })).toEqual({ status: "empty", nowPlaying: null, queue: [] });
    expect(normalizePublicMusicQueue(null)).toEqual({ status: "unavailable", nowPlaying: null, queue: [] });
    expect(normalizePublicMusicQueue({})).toEqual({ status: "unavailable", nowPlaying: null, queue: [] });
  });

  it("keeps join and music in rotation, conditionally adds Wi-Fi, and rotates approved Constellation photos normally", async () => {
    const { enabledPanelNames } = await import("../public/js/tv-core.js");
    const base = { featuredMatch: null, queue: [], music: { status: "empty", nowPlaying: null, queue: [] }, cannonLanes: [], standings: [], stations: [], roster: [], flairStandings: [], flairFeed: [] };
    expect(enabledPanelNames(base, { hasOfficialData: false, hasPhoto: true, wifiAvailable: false })).toEqual(["music", "constellation", "join"]);
    expect(enabledPanelNames(base, { hasOfficialData: false, hasPhoto: false, wifiAvailable: true })).toEqual(["idle", "music", "join", "wifi"]);
  });

  it("accepts only same-origin photo-wall paths and blocks photos during urgent broadcast states", async () => {
    const { chooseCarouselPhoto, createCarouselPhotoController } = await import("../public/js/tv-photo-core.js");
    const safe = { id: "p1", version: "v1", imageUrl: "/api/photo-wall/photos/p1/image?version=v1" };
    expect(chooseCarouselPhoto({ enabled: true, photos: [safe] })).toEqual(safe);
    for (const imageUrl of [
      String.raw`/\\evil.example/leak.png`,
      "//evil.example/leak.png",
      "https://evil.example/leak.png",
      "/api/photo-wall/photos/p1/../secret?version=v1",
      "/api/photo-wall/photos/p1/image",
      "/api/photo-wall/photos/p1/image?version=v1&next=//evil.example",
      "/api/photo-wall/photos/%2e%2e/image?version=v1",
      "data:image/png;base64,AAAA",
    ]) expect(chooseCarouselPhoto({ enabled: true, photos: [{ ...safe, imageUrl }] })).toBe(null);

    // Founder decision: approved photos join normal standings/queue rotation. They
    // yield only to urgent states that need the entire audience's attention.
    expect(chooseCarouselPhoto({ enabled: true, photos: [safe], official: true, queueRequired: true })).toEqual(safe);
    for (const blocker of ["offline", "soundPrompt", "called", "active", "result"]) {
      expect(chooseCarouselPhoto({ enabled: true, photos: [safe], [blocker]: true })).toBe(null);
    }
    const controller = createCarouselPhotoController();
    expect(controller.update({ enabled: true, photos: [safe], official: true, queueRequired: true })).toEqual(safe);
    expect(controller.update({ enabled: true, photos: [safe], called: true })).toBe(null);
  });

  it("wires the public queue and optional Wi-Fi asset without requesting a missing QR image", async () => {
    const [html, source, css] = await Promise.all([read("public/tv.html"), read("public/js/tv-broadcast.js"), read("public/tv.css")]);
    expect(source).toContain('https://music.junkyardolympics.com/api/public/queue');
    expect(source).toMatch(/fetch\("\/assets\/wifi-join-qr\.png"[^)]*method:\s*"HEAD"/s);
    expect(html).toContain('data-panel="join"');
    expect(html).toContain('data-panel="wifi"');
    expect(html).toMatch(/id="wifi-join-qr"(?![^>]*\ssrc=)/);
    expect(css).toMatch(/\.dedicated-qr-active\s+\.signup-card\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.roster-grid\s*\{/);
    expect(css).toMatch(/\.music-panel\s*\{/);
    expect(css).toMatch(/\.qr-panel\s*\{/);
  });

  it("formats the five-minute call response countdown without going negative", async () => {
    const { callDeadline, formatCallCountdown } = await import("../public/js/tv-core.js");
    const calledAt = "2026-08-15T18:00:00.000Z";
    expect(callDeadline(calledAt)).toBe("2026-08-15T18:05:00.000Z");
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-15T18:00:00.000Z"))).toBe("05:00");
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-15T18:04:01.000Z"))).toBe("00:59");
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-15T18:04:31.000Z"))).toBe("Call window ending");
    expect(formatCallCountdown(calledAt, Date.parse("2026-08-15T18:06:00.000Z"))).toBe("Organizer is requeuing this match");
  });

  it("filters future BYE placeholders out of the TV queue", async () => {
    const { mapApiBroadcastData } = await import("../public/js/tv-core.js");
    const state = {
      participants: [], events: [{ id: "cornhole", name: "Cornhole" }], stations: [], teamMembers: [],
      teams: [{ id: "a", name: "Axles" }, { id: "b", name: "Bearings" }, { id: "bye:1", name: "BYE" }, { id: "bye:2", name: "BYE" }],
      matches: [
        { id: "playable", eventId: "cornhole", status: "PENDING", teamAId: "a", teamBId: "b" },
        { id: "future", eventId: "cornhole", status: "PENDING", teamAId: "bye:1", teamBId: "bye:2" },
      ],
    };
    expect(mapApiBroadcastData(state, {}, {}).queue.map((match: any) => match.id)).toEqual(["playable"]);
  });

  it("does not reset panel rotation when refreshed panel membership is unchanged", async () => {
    const { panelSetChanged } = await import("../public/js/tv-core.js");
    expect(panelSetChanged("call|queue|standings|yard|flair", ["call", "queue", "standings", "yard", "flair"])).toBe(false);
    expect(panelSetChanged("call|queue", ["call", "queue", "yard"])).toBe(true);
  });

  it("wraps manual remote panel navigation while leaving timed rotation available", async () => {
    const { steppedPanelIndex } = await import("../public/js/tv-core.js");
    expect(steppedPanelIndex(0, 1, 5)).toBe(1);
    expect(steppedPanelIndex(4, 1, 5)).toBe(0);
    expect(steppedPanelIndex(0, -1, 5)).toBe(4);
    expect(steppedPanelIndex(3, 1, 0)).toBe(0);
    const [source, html] = await Promise.all([read("public/js/tv-broadcast.js"), read("public/tv.html")]);
    expect(source).toContain("window.JunkyardTV");
    expect(source.match(/panelSeconds = 16;/g)).toHaveLength(2);
    expect(html).toContain('id="next-in">16</b>s');
    expect(html).toContain("Network: Junkyard Olympics · Scan to join");
    expect(source).toContain("nextPanel");
    expect(source).toContain("previousPanel");
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).toContain('event.key === "Enter"');
  });

  it("deduplicates call, deadline reminder, and result announcements across refresh", async () => {
    const { createAnnouncementController } = await import("../public/js/tv-core.js");
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const speak = vi.fn();
    const sting = vi.fn(async () => true);
    let now = Date.parse("2026-08-15T18:00:00.000Z");
    const match = { id: "m1", status: "CALLED", calledAt: "2026-08-15T18:00:00.000Z", event: "Cornhole", station: "North Bay", teamA: "Axles", teamB: "Bearings" };
    const first = createAnnouncementController({ storage, speak, sting, now: () => now });
    await first.observe({ featuredMatch: match, results: [] });
    await first.observe({ featuredMatch: match, results: [] });
    expect(sting).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);

    const refreshed = createAnnouncementController({ storage, speak, sting, now: () => now });
    await refreshed.observe({ featuredMatch: match, results: [] });
    expect(speak).toHaveBeenCalledTimes(1);
    now = Date.parse("2026-08-15T18:04:15.000Z");
    await refreshed.observe({ featuredMatch: match, results: [] });
    await refreshed.observe({ featuredMatch: match, results: [] });
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak.mock.calls[1]?.[0]).toMatch(/one minute/i);

    const result = { id: "m1", completedAt: "2026-08-15T18:06:00.000Z", event: "Cornhole", winner: "Axles" };
    await refreshed.observe({ featuredMatch: null, results: [result] });
    await refreshed.observe({ featuredMatch: null, results: [result] });
    expect(sting).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenCalledTimes(3);
  });

  it("persists mute, volume, and quiet settings and clamps volume", async () => {
    const { createAudioPreferences } = await import("../public/js/tv-core.js");
    const values = new Map<string, string>([["jo-tv-volume", "1.8"], ["jo-tv-muted", "1"], ["jo-tv-quiet", "0"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const prefs = createAudioPreferences(storage);
    expect(prefs.read()).toEqual({ volume: 1, muted: true, quiet: false });
    prefs.setVolume(-2); prefs.setMuted(false); prefs.setQuiet(true);
    expect(prefs.read()).toEqual({ volume: 0, muted: false, quiet: true });
    expect(values.get("jo-tv-volume")).toBe("0");
  });
});
