import { demo } from "./demo-data.js";

export function isDemoMode(search = "") {
  return new URLSearchParams(search).get("demo") === "1";
}

export function initialBroadcastData(search = "") {
  return isDemoMode(search) ? demo : null;
}

const upperStatus = value => String(value ?? "").toUpperCase().replaceAll("-", "_");
const byId = rows => new Map((rows ?? []).map(row => [row.id, row]));

export function callDeadline(calledAt) {
  if (!calledAt || !Number.isFinite(Date.parse(calledAt))) return null;
  return new Date(Date.parse(calledAt) + 300_000).toISOString();
}

export function formatCallCountdown(calledAt, now = Date.now()) {
  const deadline = callDeadline(calledAt);
  if (!deadline) return "05:00";
  const remaining = Date.parse(deadline) - now;
  if (remaining <= 0) return "Organizer is requeuing this match";
  const seconds = Math.ceil(remaining / 1000);
  if (seconds <= 30) return "Call window ending";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function panelSetChanged(previousSignature, enabled) {
  return previousSignature !== enabled.join("|");
}

export function steppedPanelIndex(index, direction, panelCount) {
  if (!Number.isInteger(panelCount) || panelCount <= 0) return 0;
  return ((index + direction) % panelCount + panelCount) % panelCount;
}

const musicTrackView = entry => {
  const track = entry?.track ?? entry;
  if (!track || typeof track !== "object") return null;
  const title = track.name ?? track.title;
  if (!title) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists.map(artist => typeof artist === "string" ? artist : artist?.name).filter(Boolean).join(", ")
    : track.artist ?? track.artistName ?? "";
  return {
    title: String(title),
    artist: String(artists),
    requestedBy: String(entry?.user_name ?? entry?.requested_by ?? entry?.requestedBy ?? ""),
  };
};

export function normalizePublicMusicQueue(payload) {
  if (!payload || typeof payload !== "object" || !("now_playing" in payload) || !Array.isArray(payload.up_next)) {
    return { status: "unavailable", nowPlaying: null, queue: [] };
  }
  const nowPlaying = payload.now_playing ? musicTrackView(payload.now_playing) : null;
  const queue = payload.up_next.map((entry, index) => {
    const track = musicTrackView(entry);
    return track ? { position: Number(entry?.pos) || index + 1, ...track } : null;
  }).filter(Boolean);
  return { status: nowPlaying || queue.length ? "ready" : "empty", nowPlaying, queue };
}

export function enabledPanelNames(data = {}, { hasOfficialData = false, hasPhoto = false, wifiAvailable = false } = {}) {
  const enabled = [
    ["idle", !hasOfficialData && !hasPhoto],
    ["call", Boolean(data.featuredMatch)],
    ["queue", Boolean(data.queue?.length)],
    ["music", Boolean(data.music)],
    ["cannon", Boolean(data.cannonLanes?.length)],
    ["standings", Boolean(data.standings?.length)],
    ["yard", Boolean(data.stations?.length)],
    ["roster", Boolean(data.roster?.length)],
    ["flair", Boolean(data.flairStandings?.length || data.flairFeed?.length)],
    ["constellation", Boolean(hasPhoto)],
    ["join", true],
    ["wifi", Boolean(wifiAvailable)],
  ].filter(([, show]) => show).map(([name]) => name);
  return enabled;
}

export function normalizeBroadcastRoster(participants = []) {
  return participants.map(participant => typeof participant === "string"
    ? { displayName: participant, active: 1, eventCount: 0 }
    : participant);
}

export function mapApiBroadcastData(state = {}, championship = {}, flair = {}) {
  const participants = byId(state.participants);
  const events = byId(state.events);
  const teams = byId(state.teams);
  const stationsById = byId(state.stations);
  const members = state.teamMembers ?? [];
  const playerNames = teamId => members
    .filter(member => member.teamId === teamId && member.active !== 0)
    .map(member => participants.get(member.participantId)?.displayName)
    .filter(Boolean);
  const matchView = match => ({
    ...match,
    status: upperStatus(match.status),
    event: events.get(match.eventId)?.name ?? "Field event",
    station: stationsById.get(match.stationId)?.name ?? "Station assignment pending",
    teamA: teams.get(match.teamAId)?.name ?? "Team A",
    teamB: teams.get(match.teamBId)?.name ?? "Team B",
    teamAPlayers: playerNames(match.teamAId),
    teamBPlayers: playerNames(match.teamBId),
  });
  const matches = (state.matches ?? []).map(matchView);
  const featuredMatch = matches
    .filter(match => ["CALLED", "ACTIVE"].includes(match.status))
    .sort((a, b) => (a.status === b.status ? String(a.calledAt ?? "").localeCompare(String(b.calledAt ?? "")) : a.status === "CALLED" ? -1 : 1))[0] ?? null;
  const playable = match => {
    const teamA = teams.get(match.teamAId), teamB = teams.get(match.teamBId);
    return Boolean(teamA && teamB && match.teamAId !== match.teamBId && teamA.name !== "BYE" && teamB.name !== "BYE" && !String(match.teamAId).startsWith("bye:") && !String(match.teamBId).startsWith("bye:"));
  };
  const queue = matches.filter(match => ["PENDING", "SKIPPED"].includes(match.status) && playable(match));
  const latestRun = [...(state.cannonRuns ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const cannonLanes = latestRun ? (state.cannonAssignments ?? [])
    .filter(assignment => assignment.runId === latestRun.id)
    .map(assignment => {
      const shots = (state.cannonShots ?? [])
        .filter(shot => shot.runId === latestRun.id && shot.teamId === assignment.teamId)
        .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
      const scored = shots.filter(shot => String(shot.kind).toLowerCase() === "scored");
      const practice = shots.filter(shot => String(shot.kind).toLowerCase() === "practice");
      const last = shots.at(-1);
      return {
        ...assignment,
        team: teams.get(assignment.teamId)?.name ?? "Awaiting team",
        players: playerNames(assignment.teamId),
        scoredShots: scored.length,
        practiceShots: practice.length,
        total: scored.reduce((sum, shot) => sum + Number(shot.points ?? 0), 0),
        lastPoints: Number(last?.points ?? 0),
        lastTargets: last?.targetNames ?? [],
      };
    }) : [];
  const stations = (state.stations ?? []).map(station => ({
    ...station,
    event: events.get(station.eventId)?.name ?? "Official field game",
    match: matches.find(match => match.stationId === station.id && ["CALLED", "ACTIVE"].includes(match.status)) ?? null,
  }));
  return {
    featuredMatch,
    queue,
    cannonLanes,
    targets: state.targets ?? [],
    standings: championship.standings ?? [],
    podium: championship.podium ?? [],
    stations,
    roster: normalizeBroadcastRoster(state.participants ?? []),
    flairStandings: flair.standings ?? (Array.isArray(flair) ? flair : []),
    flairFeed: state.flairFeed ?? [],
    results: matches.filter(match => match.status === "FINAL" && match.completedAt).map(match => ({
      ...match,
      winner: teams.get(match.winnerId)?.name ?? "Result confirmed",
    })),
  };
}

const clampVolume = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0.65));

export function createAudioPreferences(storage) {
  const get = (key, fallback) => {
    try { return storage?.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const set = (key, value) => {
    try { storage?.setItem(key, value); } catch { /* storage is optional */ }
  };
  return {
    read: () => ({
      volume: clampVolume(get("jo-tv-volume", "0.65")),
      muted: get("jo-tv-muted", "0") === "1",
      quiet: get("jo-tv-quiet", "0") === "1",
    }),
    setVolume(value) { set("jo-tv-volume", String(clampVolume(value))); },
    setMuted(value) { set("jo-tv-muted", value ? "1" : "0"); },
    setQuiet(value) { set("jo-tv-quiet", value ? "1" : "0"); },
  };
}

export function createAnnouncementController({ storage, speak, sting, now = () => Date.now(), preferences = null }) {
  const memory = new Set();
  const seen = key => {
    if (memory.has(key)) return true;
    try { return storage?.getItem(key) === "1"; } catch { return false; }
  };
  const mark = key => {
    memory.add(key);
    try { storage?.setItem(key, "1"); } catch { /* memory still deduplicates this page */ }
  };
  const allowed = () => {
    const settings = preferences?.read?.() ?? { muted: false, quiet: false };
    return !settings.muted && !settings.quiet;
  };
  return {
    async observe({ featuredMatch, results = [] }) {
      if (featuredMatch?.id && featuredMatch.calledAt) {
        const identity = `${featuredMatch.id}:${featuredMatch.calledAt}`;
        const callKey = `jo-tv-call:${identity}`;
        if (!seen(callKey)) {
          mark(callKey);
          if (allowed()) {
            await sting("call");
            speak(`${featuredMatch.event}. ${featuredMatch.teamA} versus ${featuredMatch.teamB}. Report to ${featuredMatch.station}.`);
          }
        }
        const remaining = Date.parse(callDeadline(featuredMatch.calledAt)) - now();
        const reminderKey = `jo-tv-reminder:${identity}`;
        if (remaining > 0 && remaining <= 60_000 && !seen(reminderKey)) {
          mark(reminderKey);
          if (allowed()) speak(`One minute remains. ${featuredMatch.teamA} and ${featuredMatch.teamB}, report to ${featuredMatch.station}.`);
        }
      }
      for (const result of results) {
        const resultKey = `jo-tv-result:${result.id}:${result.completedAt}`;
        if (!result.id || !result.completedAt || seen(resultKey)) continue;
        mark(resultKey);
        if (allowed()) {
          await sting("result");
          speak(`${result.event} result confirmed. ${result.winner}.`);
        }
      }
    },
  };
}
