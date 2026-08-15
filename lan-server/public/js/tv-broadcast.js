import {
  createAnnouncementController,
  createAudioPreferences,
  formatCallCountdown,
  initialBroadcastData,
  isDemoMode,
  mapApiBroadcastData,
  normalizeBroadcastRoster,
  normalizePublicMusicQueue,
  enabledPanelNames,
  panelSetChanged,
  steppedPanelIndex,
} from "./tv-core.js";
import { createCarouselPhotoController } from "./tv-photo-core.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const demoMode = isDemoMode(location.search);
const preferences = createAudioPreferences(localStorage);
const photoController = createCarouselPhotoController();
let broadcast = null;
let currentPhotoWall = { enabled: false, photos: [] };
let latestFeatured = null;
let soundUnlocked = false;
let pollTimer;
let rotateTimer;
let photoRotateTimer;
let reconnectDelay = 5_000;
let panelIndex = 0;
let panelSeconds = 16;
let panelSignature = "";
let enabledPanels = [];
let wifiAvailable = false;

function demoBroadcast(source) {
  const featured = source.activeMatch ? {
    id: source.activeMatch.id,
    status: "CALLED",
    calledAt: new Date().toISOString(),
    event: source.activeMatch.event,
    station: source.activeMatch.station,
    teamA: source.activeMatch.team,
    teamB: source.activeMatch.opponent,
    teamAPlayers: source.activeMatch.players.split(" + "),
    teamBPlayers: source.activeMatch.opponents.split(" + "),
  } : null;
  return {
    featuredMatch: featured,
    queue: source.queue.map((item, index) => ({ id: `demo-q-${index}`, event: item.event, teamA: item.teams.split(" vs ")[0], teamB: item.teams.split(" vs ")[1], status: item.state })),
    cannonLanes: source.cannon.lanes.map(lane => ({ laneId: lane.name, team: lane.team, players: lane.players.split(" + "), scoredShots: lane.shot, practiceShots: 10, total: lane.total, lastTargets: lane.last.includes("MISS") ? [] : lane.last.split(" = ")[0].split(" + "), lastPoints: Number(lane.last.split(" = ")[1] ?? 0) })),
    targets: source.cannon.targets,
    standings: source.standings.map(row => ({ displayName: row.name, total: row.total, eligible: row.eligible, countedFieldPoints: row.counted, droppedFieldPoints: row.dropped })),
    podium: source.standings.filter(row => row.eligible).slice(0, 3).map(row => ({ displayName: row.name, total: row.total })),
    stations: source.matches.map((match, index) => ({ id: `demo-s-${index}`, name: match.station, available: match.status !== "PLAYING", match: { ...match, teamA: match.a, teamB: match.b, event: match.event, status: match.status } })),
    roster: normalizeBroadcastRoster(source.participants),
    music: normalizePublicMusicQueue(null),
    flairStandings: source.flair.map(row => ({ displayName: row.name, total: row.points, note: row.note })),
    flairFeed: source.flair.map((row, index) => ({ id: `demo-f-${index}`, recipientDisplayName: row.name, category: row.note })),
    results: [],
  };
}

async function playSting(kind = "call") {
  const settings = preferences.read();
  if (settings.muted || settings.volume === 0) return true;
  const audio = new Audio(kind === "result" ? "/assets/result-sting.wav" : "/assets/junkyard-gong.wav");
  audio.volume = settings.volume;
  audio.playbackRate = kind === "result" ? 1 : 0.92;
  try {
    await audio.play();
    soundUnlocked = true;
    $("#enable-audio").hidden = true;
    return true;
  } catch {
    soundUnlocked = false;
    $("#enable-audio").hidden = false;
    if (broadcast) render(broadcast);
    return false;
  }
}

function speak(text) {
  const settings = preferences.read();
  if (settings.muted || settings.volume === 0 || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find(voice => /^en-GB/i.test(voice.lang)) ?? voices.find(voice => /^en/i.test(voice.lang)) ?? null;
  utterance.lang = "en-GB";
  utterance.rate = 0.9;
  utterance.pitch = 0.82;
  utterance.volume = settings.volume;
  window.setTimeout(() => speechSynthesis.speak(utterance), 420);
}

const announcements = createAnnouncementController({ storage: localStorage, speak, sting: playSting, preferences });

function setConnection(status) {
  document.documentElement.dataset.networkState = status;
  const badge = $("#connection-badge");
  badge.innerHTML = `<span class="signal"></span>${demoMode ? "DEMO" : status === "live" ? "LOCAL LIVE" : "RECONNECTING"}`;
  $("#connection-overlay").hidden = status === "live" || demoMode;
  if (status !== "live" && !demoMode) {
    photoController.update({ ...currentPhotoWall, offline: true });
    window.clearTimeout(photoRotateTimer);
    photoRotateTimer = null;
    $("#photo-wall-image").removeAttribute("src");
    document.body.classList.remove("dedicated-qr-active");
    $$(".tv-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === "idle"));
  }
}

async function fetchOfficialBroadcast() {
  const photoRequest = fetch("/api/photo-wall", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(response => response.ok ? response.json() : null)
    .catch(() => null);
  const musicRequest = fetch("https://music.junkyardolympics.com/api/public/queue", { mode: "cors", credentials: "omit", headers: { Accept: "application/json" } })
    .then(response => response.ok ? response.json() : null)
    .then(normalizePublicMusicQueue)
    .catch(() => normalizePublicMusicQueue(null));
  const [responses, photoWall, music] = await Promise.all([Promise.all([
    fetch("/api/state", { credentials: "same-origin", headers: { Accept: "application/json" } }),
    fetch("/api/standings/championship", { credentials: "same-origin", headers: { Accept: "application/json" } }),
    fetch("/api/standings/flair", { credentials: "same-origin", headers: { Accept: "application/json" } }),
  ]), photoRequest, musicRequest]);
  if (responses.some(response => !response.ok)) throw new Error("Official broadcast data unavailable");
  const [state, championship, flair] = await Promise.all(responses.map(response => response.json()));
  return { ...mapApiBroadcastData(state, championship, flair), photoWall: photoWall ?? { enabled: false, photos: [] }, music };
}

async function refresh() {
  if (demoMode) return;
  window.clearTimeout(pollTimer);
  try {
    broadcast = await fetchOfficialBroadcast();
    reconnectDelay = 5_000;
    setConnection("live");
    render(broadcast);
    await announcements.observe(broadcast);
    pollTimer = window.setTimeout(refresh, 5_000);
  } catch {
    setConnection("reconnecting");
    pollTimer = window.setTimeout(refresh, reconnectDelay);
    reconnectDelay = Math.min(30_000, reconnectDelay * 1.5);
  }
}

function matchMarkup(match) {
  return `<div><b>${esc(match.teamA)}</b><span>${esc(match.teamAPlayers?.join(" + ") || "Roster pending")}</span></div><em>VS</em><div><b>${esc(match.teamB)}</b><span>${esc(match.teamBPlayers?.join(" + ") || "Roster pending")}</span></div>`;
}

function renderCall(match) {
  latestFeatured = match;
  if (!match) return;
  $("#call-kicker").textContent = match.status === "CALLED" ? "Report now · Official call" : "Match in progress";
  $("#call-station").textContent = match.station;
  $("#call-event").textContent = `${match.event}${match.round ? ` · Round ${match.round}` : ""}`;
  $("#call-match").innerHTML = matchMarkup(match);
  $("#call-countdown").textContent = match.status === "CALLED" ? formatCallCountdown(match.calledAt) : "ACTIVE";
}

function render(data) {
  renderCall(data.featuredMatch);
  const hasOfficialData = Boolean(data.featuredMatch || data.queue.length || data.cannonLanes.length || data.standings.length || data.flairStandings.length || data.roster.length);
  currentPhotoWall = data.photoWall ?? { enabled: false, photos: [] };
  const resultActive = data.results.some(result => Date.now() - Date.parse(result.completedAt) < 12_000);
  const photo = photoController.update({ ...currentPhotoWall, called: data.featuredMatch?.status === "CALLED", active: data.featuredMatch?.status === "ACTIVE", result: resultActive, soundPrompt: !$("#enable-audio").hidden });
  if (photo) {
    $("#photo-wall-image").src = photo.imageUrl;
    $("#photo-wall-title").textContent = photo.title ?? "Junkyard Constellation";
    $("#photo-wall-caption").textContent = photo.caption ?? "Approved event photo.";
    $("#photo-wall-names").textContent = photo.names ?? "";
    if (!photoRotateTimer) photoRotateTimer = window.setTimeout(() => {
      photoRotateTimer = null;
      if (broadcast) render(broadcast);
    }, 12_000);
  } else {
    window.clearTimeout(photoRotateTimer);
    photoRotateTimer = null;
    $("#photo-wall-image").removeAttribute("src");
  }
  $("#idle-status").textContent = hasOfficialData ? "Official scores and calls are coming up." : "Waiting for the first official call.";
  $("#ticker").textContent = demoMode ? "DEMO BROADCAST · Sample names and scores" : data.featuredMatch ? `${data.featuredMatch.status}: ${data.featuredMatch.event} at ${data.featuredMatch.station}` : "Opening field broadcast · Waiting for official calls";

  $("#queue").innerHTML = data.queue.length ? data.queue.slice(0, 6).map((match, index) => `<div class="tv-row"><strong>${index + 1}</strong><b>${esc(match.event)}</b><span>${esc(match.teamA)} vs ${esc(match.teamB)}</span><em>${esc(match.status)}</em></div>`).join("") : emptyRow("No matches queued");
  renderMusic(data.music);
  $("#cannon-lanes").innerHTML = data.cannonLanes.length ? data.cannonLanes.map(lane => `<article><span>${esc(lane.laneId)} · PRACTICE ${lane.practiceShots}/10 · SCORED ${lane.scoredShots}/20</span><b>${esc(lane.team)}</b><small>${esc(lane.players?.join(" + ") || "Roster pending")}</small><em>${Number(lane.total).toLocaleString()}</em><p>Last: ${esc(lane.lastTargets?.length ? `${lane.lastTargets.join(" + ")} · ${lane.lastPoints}` : `${lane.lastPoints ?? 0} points`)}</p></article>`).join("") : emptyCard("No Cannon run is active");
  $("#podium").innerHTML = data.podium.length ? data.podium.map((row, index) => `<article><span>${["CHAMPION", "SECOND", "THIRD"][index]}</span><b>${esc(row.displayName)}</b><em>${Number(row.total).toLocaleString()}</em></article>`).join("") : "";
  $("#standings").innerHTML = data.standings.length ? data.standings.slice(0, 6).map((row, index) => `<div class="tv-row"><strong>${index + 1}</strong><b>${esc(row.displayName)}</b><span>Counted: ${esc(Array.isArray(row.countedFieldPoints) ? row.countedFieldPoints.join(" + ") : row.countedFieldPoints || "—")}<small>${row.eligible ? "PODIUM ELIGIBLE" : "NEEDS CANNON + 3 FIELD EVENTS"}${row.droppedFieldPoints?.length ? ` · DROPPED ${row.droppedFieldPoints.join(", ")}` : ""}</small></span><em>${Number(row.total).toLocaleString()}</em></div>`).join("") : emptyRow("No official championship scores yet");
  $("#yard").innerHTML = data.stations.length ? data.stations.map(station => `<article><span>${esc(station.name)}</span><h2>${station.match ? `${esc(station.match.teamA)} <i>vs</i> ${esc(station.match.teamB)}` : station.available ? "READY" : "UNAVAILABLE"}</h2><p>${esc(station.match?.event ?? station.event)}</p><b>${esc(station.match?.status ?? (station.available ? "OPEN" : "CLOSED"))}</b></article>`).join("") : emptyCard("No stations configured");
  const roster = $("#roster");
  roster.dataset.density = data.roster.length > 24 ? "dense" : data.roster.length > 12 ? "compact" : "standard";
  roster.innerHTML = data.roster.length ? data.roster.map((participant, index) => `<article class="${participant.active === 0 ? "inactive" : ""}"><strong>${index + 1}</strong><b>${esc(participant.displayName)}</b><span>${participant.active === 0 ? "Checked out" : `${Number(participant.eventCount ?? 0)} event${Number(participant.eventCount ?? 0) === 1 ? "" : "s"}`}</span></article>`).join("") : emptyCard("No competitors have joined yet");
  $("#flair").innerHTML = data.flairStandings.length ? data.flairStandings.slice(0, 6).map((row, index) => `<div class="tv-row"><strong>${index + 1}</strong><b>${esc(row.displayName)}</b><span>${esc(row.note ?? (Object.entries(row.categories ?? {}).map(([name, count]) => `${name} × ${count}`).join(" · ") || "Live props"))}</span><em>${Number(row.total).toLocaleString()}</em></div>`).join("") : emptyRow("No Flair props yet");
  const latest = data.flairFeed[0];
  $("#flair-latest").innerHTML = latest ? `<span>Latest official prop</span><b>${esc(String(latest.category).replaceAll("_", " "))}</b><p>${esc(latest.recipientDisplayName)}</p>` : `<span>Latest official prop</span><b>Waiting for glorious nonsense</b>`;
  configurePanels(data, hasOfficialData, photo);
}

const emptyRow = text => `<div class="tv-row empty"><b>${esc(text)}</b></div>`;
const emptyCard = text => `<article class="empty"><b>${esc(text)}</b></article>`;

function renderMusic(music = normalizePublicMusicQueue(null)) {
  if (music.status === "unavailable") {
    $("#now-playing").innerHTML = `<article class="music-state unavailable"><span>Live jukebox</span><b>Queue unavailable</b><p>The music service could not be reached. The TV will keep trying.</p></article>`;
    $("#music-queue").innerHTML = emptyRow("No live queue data available");
    return;
  }
  if (music.nowPlaying) {
    $("#now-playing").innerHTML = `<article><span>Now playing</span><b>${esc(music.nowPlaying.title)}</b><p>${esc(music.nowPlaying.artist || "Artist unavailable")}${music.nowPlaying.requestedBy ? ` · requested by ${esc(music.nowPlaying.requestedBy)}` : ""}</p></article>`;
  } else {
    $("#now-playing").innerHTML = `<article class="music-state"><span>Now playing</span><b>${music.status === "empty" ? "Nothing playing right now" : "Between tracks"}</b></article>`;
  }
  $("#music-queue").innerHTML = music.queue.length ? music.queue.slice(0, 6).map(track => `<div class="tv-row"><strong>${track.position}</strong><b>${esc(track.title)}</b><span>${esc(track.artist || "Artist unavailable")}</span><em>${track.requestedBy ? `for ${esc(track.requestedBy)}` : "queued"}</em></div>`).join("") : emptyRow("The request queue is empty");
}

function configurePanels(data, hasOfficialData, photo) {
  const enabled = enabledPanelNames(data, { hasOfficialData, hasPhoto: Boolean(photo), wifiAvailable });
  if (!panelSetChanged(panelSignature, enabled)) return;
  const currentName = enabledPanels[panelIndex];
  enabledPanels = enabled;
  panelSignature = enabled.join("|");
  const dots = $("#rotation-dots");
  dots.innerHTML = enabled.map((name, index) => `<button aria-label="Show ${esc(name)} panel" data-show="${esc(name)}" class="${index === 0 ? "active" : ""}"></button>`).join("");
  $$("#rotation-dots button").forEach(button => button.addEventListener("click", () => showPanel(enabledPanels, enabledPanels.indexOf(button.dataset.show))));
  panelIndex = Math.max(0, enabledPanels.indexOf(currentName));
  showPanel(enabledPanels, panelIndex);
  window.clearInterval(rotateTimer);
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) rotateTimer = window.setInterval(() => {
    panelSeconds -= 1;
    if (panelSeconds <= 0) showPanel(enabledPanels, (panelIndex + 1) % enabledPanels.length);
    $("#next-in").textContent = String(panelSeconds);
  }, 1_000);
}

function showPanel(enabled, index) {
  panelIndex = Math.max(0, index);
  const name = enabled[panelIndex] ?? enabled[0];
  document.body.classList.toggle("dedicated-qr-active", name === "join" || name === "wifi");
  $$(".tv-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === name));
  $$("#rotation-dots button").forEach(button => button.classList.toggle("active", button.dataset.show === name));
  panelSeconds = 16;
  $("#next-in").textContent = String(panelSeconds);
}

function stepPanel(direction) {
  if (!enabledPanels.length) return false;
  showPanel(enabledPanels, steppedPanelIndex(panelIndex, direction, enabledPanels.length));
  return true;
}

window.JunkyardTV = Object.freeze({
  nextPanel: () => stepPanel(1),
  previousPanel: () => stepPanel(-1),
});

window.addEventListener("keydown", event => {
  const direction = event.key === "ArrowRight" || event.key === "Enter" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  stepPanel(direction);
});

function updateTime() {
  $("[data-clock]").textContent = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date());
  if (latestFeatured?.status === "CALLED") {
    $("#call-countdown").textContent = formatCallCountdown(latestFeatured.calledAt);
    announcements.observe(broadcast ?? { featuredMatch: latestFeatured, results: [] });
  }
}

function syncAudioControls() {
  const settings = preferences.read();
  $("#volume").value = String(settings.volume);
  $("#mute").setAttribute("aria-pressed", String(settings.muted));
  $("#mute").textContent = settings.muted ? "Unmute" : "Mute";
  $("#quiet").setAttribute("aria-pressed", String(settings.quiet));
  $("#quiet").textContent = settings.quiet ? "Quiet on" : "Quiet";
}

function bindControls() {
  $("#volume").addEventListener("input", event => { preferences.setVolume(event.target.value); syncAudioControls(); });
  $("#mute").addEventListener("click", () => { preferences.setMuted(!preferences.read().muted); syncAudioControls(); });
  $("#quiet").addEventListener("click", () => { preferences.setQuiet(!preferences.read().quiet); syncAudioControls(); });
  $("#replay").addEventListener("click", async () => {
    if (!latestFeatured || preferences.read().muted) return;
    await playSting("call");
    speak(`${latestFeatured.event}. ${latestFeatured.teamA} versus ${latestFeatured.teamB}. Report to ${latestFeatured.station}.`);
  });
  $("#enable-audio").addEventListener("click", async () => {
    soundUnlocked = await playSting("call");
    if (soundUnlocked && latestFeatured) speak(`${latestFeatured.event}. ${latestFeatured.teamA} versus ${latestFeatured.teamB}. Report to ${latestFeatured.station}.`);
  });
  $("#full").addEventListener("click", () => document.documentElement.requestFullscreen?.());
  syncAudioControls();
}

function connectEvents() {
  if (demoMode || !("EventSource" in window)) return;
  const source = new EventSource("/api/events/stream");
  source.addEventListener("ready", refresh);
  source.addEventListener("heartbeat", refresh);
  source.onopen = () => setConnection("live");
  source.onerror = () => setConnection("reconnecting");
}

async function detectWifiPanel() {
  try {
    const response = await fetch("/assets/wifi-join-qr.png", { method: "HEAD", credentials: "same-origin", cache: "no-store" });
    wifiAvailable = response.ok;
  } catch {
    wifiAvailable = false;
  }
  if (wifiAvailable) $("#wifi-join-qr").src = "/assets/wifi-join-qr.png";
  else $("#wifi-join-qr").removeAttribute("src");
  if (broadcast) render(broadcast);
}

function init() {
  document.body.classList.toggle("demo-mode", demoMode);
  $("#tv-qr").innerHTML = `<div class="qr-wrap" aria-label="Scan to sign up"><img src="/assets/signup-qr.png" alt="Signup QR code"><b>SCAN TO JOIN</b></div>`;
  bindControls();
  void detectWifiPanel();
  updateTime();
  window.setInterval(updateTime, 1_000);
  window.addEventListener("offline", () => setConnection("reconnecting"));
  window.addEventListener("online", refresh);
  if (demoMode) {
    setConnection("live");
    broadcast = demoBroadcast(initialBroadcastData(location.search));
    render(broadcast);
  } else {
    setConnection("reconnecting");
    refresh();
    connectEvents();
  }
}

init();
