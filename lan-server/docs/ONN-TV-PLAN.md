# ONN Android TV Field Display Plan

## Goal

Use Chris’s spare ONN Android TV device to show the dedicated Junkyard Olympics field broadcast without moving the Constellation Shield.

## Fixed Rehearsal Endpoint

`http://192.168.1.101:8790/tv.html`

The ONN and RecRoomRig must both be reachable through the outdoor `Junkyard Olympics` Wi-Fi/LAN path.

## App Boundary

- New isolated Android application and package; never overwrite Constellation.
- Working name: **Junkyard Olympics TV**.
- Package: `com.junkyardolympics.tv`.
- Android TV/Leanback launcher entry and 320×180 banner.
- Intentional cleartext HTTP only for the local LAN URL.
- JavaScript, DOM storage, autoplay, and media playback enabled.
- Full screen; screen stays awake.
- Back button does not accidentally exit during the event.
- Visible offline/reconnecting overlay when the page cannot load.
- Automatic retry without operator intervention.
- No organizer credential in the APK or URL.

## Broadcast Screen

The existing `/tv.html` route is display-only and will show:

1. Current called match and station.
2. Five-minute response countdown.
3. Upcoming match queue.
4. Live championship standings.
5. Junkyard Showboat/Flair feed.
6. Local digital gong and browser-spoken British match calls.
7. Quiet/mute/volume/replay controls available to the field operator, not participant phones.

No physical bell is required.

## Build and Verification

1. Clone the proven Constellation WebView wrapper structure into this repository without its identity, package, art, preferences, or URL.
2. Add Junkyard launcher icon and safe-margin TV banner.
3. Build against the installed Android SDK/JDK discovered from the existing Constellation project.
4. Verify package, version, Leanback launcher, banner, cleartext policy, and exact URL with `aapt`.
5. Compute SHA-256.
6. Connect the ONN over ADB only after Chris identifies its address and approves its RSA prompt.
7. Install, launch, visually verify full-screen TV mode, and test reconnect.
8. Test audio through the actual TV/sound system.

## Event Fallback

If the ONN or field display fails, open `/tv.html` in any browser-capable device connected to the event Wi-Fi and HDMI/cast it to the TV. Scoring and organizer operations continue independently.

## Acceptance Gate

Not event-ready until the actual ONN device has been connected to the event Wi-Fi, installed, launched, visually checked outdoors, and heard through the actual speakers.
