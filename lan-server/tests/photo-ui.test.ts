import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readRepo = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Junkyard Constellation participant-facing name", () => {
  it("uses the approved name and private-to-approved subtitle in Paul's hosted participant site", async () => {
    const [index, views, app] = await Promise.all([
      readRepo("site/index.html"),
      readRepo("site/js/views.js"),
      readRepo("site/js/app.js"),
    ]);
    const participantCopy = `${index}\n${views}\n${app}`;
    expect(index).toContain('data-nav="photos">📸 Junkyard Constellation</a>');
    expect(views).toContain("<h2>📸 Junkyard Constellation</h2>");
    expect(views).toContain("The party’s private-to-approved memory wall.");
    expect(views).toContain("PRIVATE UNTIL APPROVED");
    expect(views).toMatch(/id="vault-consent"[^>]*type="checkbox"/);
    expect(views).not.toMatch(/id="vault-consent"[^>]*checked/);
    expect(participantCopy).not.toMatch(/Photo Vault|Junkyard Hall of Fame/);
  });

  it("uses the approved name in LAN participant and moderation copy without weakening privacy or consent", async () => {
    const [participant, upload, organizer, consoleSource] = await Promise.all([
      read("public/participant.html"),
      read("public/js/photo-upload.js"),
      read("public/organizer.html"),
      read("public/js/organizer-console.js"),
    ]);
    const lanCopy = `${participant}\n${upload}\n${organizer}\n${consoleSource}`;
    expect(participant).toContain("Junkyard Constellation");
    expect(participant).toContain("The party’s private-to-approved memory wall.");
    expect(participant).toContain("Send privately for review");
    expect(participant).toMatch(/id="photo-consent"[^>]*type="checkbox"/);
    expect(participant).not.toMatch(/id="photo-consent"[^>]*checked/);
    expect(organizer).toContain("Junkyard Constellation moderation");
    expect(organizer).toContain("Constellation live");
    expect(upload).toContain("private unless approved");
    expect(lanCopy).not.toMatch(/Photo Vault|Junkyard Hall of Fame/);
  });
});

describe("participant photo wall static contract", () => {
  it("places the upload card after official calls, up-next, and results", async () => {
    const html = await read("public/participant.html");
    const ids = ["do-this-now", "up-next", "your-results", "photo-upload"];
    const positions = ids.map(id => html.indexOf(`id="${id}"`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('capture="environment"');
    expect(html).toContain('id="photo-preview"');
    expect(html).toContain('id="photo-progress"');
    expect(html).toContain('id="photo-status"');
  });

  it("uses the exact bundled consent text and leaves it unchecked", async () => {
    const html = await read("public/participant.html");
    expect(html).toContain("I confirm that everyone identifiable in this photo agreed that it may appear publicly on the Junkyard Olympics screen and may be permanently archived in Constellation. I understand an organizer can remove it and I can request deletion.");
    expect(html).toMatch(/id="photo-consent"[^>]*type="checkbox"/);
    expect(html).not.toMatch(/id="photo-consent"[^>]*checked/);
  });

  it("declares the exact 390x844 mobile sizing contract", async () => {
    const css = await read("public/styles.css");
    expect(css).toMatch(/@media\s*\(max-width:\s*390px\)/);
    expect(css).toMatch(/\.photo-upload-card\s*\{[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/\.photo-upload-card\s+(?:input|textarea)[^{]*\{[^}]*font-size:\s*20px/s);
    expect(css).toMatch(/\.photo-primary-action\s*\{[^}]*min-height:\s*56px/s);
    expect(css).toMatch(/\.photo-consent-copy\s*\{[^}]*font-size:\s*17px/s);
  });
});

describe("participant photo behavior", () => {
  it("models preview, progress, processing, pending, published, rejected, removed, removal-requested, and error states", async () => {
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const { createPhotoUploadState, reducePhotoUpload } = await import("../public/js/photo-upload.js");
    const start = createPhotoUploadState();
    expect(start).toMatchObject({ phase: "empty", progress: 0, canUpload: false });
    const ready = reducePhotoUpload(start, { type: "SELECT", previewUrl: "blob:photo" });
    expect(ready).toMatchObject({ phase: "ready", previewUrl: "blob:photo", canUpload: false });
    const consented = reducePhotoUpload(ready, { type: "CONSENT", accepted: true });
    expect(consented.canUpload).toBe(true);
    expect(reducePhotoUpload(consented, { type: "UPLOAD_PROGRESS", progress: 41 })).toMatchObject({ phase: "uploading", progress: 41 });
    for (const state of ["PROCESSING", "PENDING_REVIEW", "PUBLISHED", "REJECTED", "REMOVED", "REMOVAL_REQUESTED"]) {
      expect(reducePhotoUpload(consented, { type: "SERVER_STATE", photo: { id: "p1", state } }).phase).toBe(state.toLowerCase());
    }
    expect(reducePhotoUpload(consented, { type: "ERROR", message: "Offline" })).toMatchObject({ phase: "error", message: "Offline" });
  });

  it("never enables upload without a selected image and affirmative consent", async () => {
    // @ts-expect-error browser module intentionally has no TypeScript declarations
    const { createPhotoUploadState, reducePhotoUpload } = await import("../public/js/photo-upload.js");
    const start = createPhotoUploadState();
    expect(reducePhotoUpload(start, { type: "CONSENT", accepted: true }).canUpload).toBe(false);
    const ready = reducePhotoUpload(start, { type: "SELECT", previewUrl: "blob:x" });
    expect(ready.canUpload).toBe(false);
  });

  it("restores the participant's latest owned status after a refresh", async () => {
    const source = await read("public/js/photo-upload.js");
    expect(source).toContain("async function restoreLatestPhoto");
    expect(source).toContain("void restoreLatestPhoto()");
  });
});

describe("safe photo API contract", () => {
  it("documents same-origin endpoints and routes participant and organizer bearer only through the existing request helper", async () => {
    const source = await read("public/js/api.js");
    expect(source).toContain("PHOTO_API_CONTRACT");
    expect(source).toMatch(/uploadPhoto:[\s\S]*request\('\/api\/photos'/);
    expect(source).toMatch(/getMyPhotos:[\s\S]*request\('\/api\/photos\/mine'/);
    expect(source).toMatch(/requestPhotoRemoval:[\s\S]*request\(`\/api\/photos\/\$\{encodeURIComponent\(photoId\)\}\/removal-request`/);
    expect(source).toMatch(/getPhotoModeration:[\s\S]*request\('\/api\/organizer\/photos'/);
    expect(source).toMatch(/getPhotoWall:[\s\S]*request\('\/api\/photo-wall'/);
    expect(source).not.toMatch(/[?&](?:token|access_token|auth)=/i);
    expect(source).not.toMatch(/console\.(?:log|info|warn|error)/);
  });
});

describe("organizer photo moderation contract", () => {
  it("ships a locked authenticated section with kill switch and truthful empty lists", async () => {
    const html = await read("public/organizer.html");
    expect(html).toContain('id="photo-moderation"');
    expect(html).toContain('id="photo-wall-enabled"');
    expect(html).toContain('id="photos-pending"');
    expect(html).toContain('id="photos-published"');
    expect(html).toContain('id="photos-removed"');
    expect(html).toMatch(/id="photo-moderation"[^>]*data-mutation/);
    expect(html).not.toMatch(/Rivet Rosie|Sample photo|Demo photo/);
  });

  it("declares every moderation control and confirmation for destructive actions", async () => {
    const source = await read("public/js/organizer-console.js");
    for (const action of ["publish", "reject", "remove", "restore", "delete", "ban-uploader"]) expect(source).toContain(action);
    expect(source).toMatch(/confirm\([^)]*(?:delete|remove|reject|ban)/i);
    expect(source).toMatch(/api\.setPhotoWallEnabled/);
    expect(source).toMatch(/api\.moderatePhoto/);
  });
});

describe("approved photo TV carousel contract", () => {
  it("allows photos during normal rotation but yields to urgent states", async () => {
    const { chooseCarouselPhoto } = await import("../public/js/tv-photo-core.js");
    const photo = { id: "p1", version: "v1", imageUrl: "/api/photo-wall/photos/p1/image?version=v1", title: "Heap hero", caption: "A glorious pile." };
    expect(chooseCarouselPhoto({ photos: [photo] })).toEqual(photo);
    for (const blocker of ["offline", "soundPrompt", "called", "active", "result"]) {
      expect(chooseCarouselPhoto({ photos: [photo], [blocker]: true })).toBe(null);
    }
    expect(chooseCarouselPhoto({ photos: [photo], official: true, queueRequired: true })).toEqual(photo);
    expect(chooseCarouselPhoto({ photos: [photo], enabled: false })).toBe(null);
    expect(chooseCarouselPhoto({ photos: [], enabled: true })).toBe(null);
  });

  it("rotates every 16 seconds, immediately preempts, and evicts removed versions", async () => {
    const { createCarouselPhotoController } = await import("../public/js/tv-photo-core.js");
    const photos = [
      { id: "p1", version: "v1", imageUrl: "/api/photo-wall/photos/p1/image?version=v1" },
      { id: "p2", version: "v1", imageUrl: "/api/photo-wall/photos/p2/image?version=v1" },
    ];
    let now = 0;
    const controller = createCarouselPhotoController({ now: () => now });
    expect(controller.update({ photos })).toMatchObject({ id: "p1" });
    now = 15_999;
    expect(controller.update({ photos })).toMatchObject({ id: "p1" });
    now = 16_000;
    expect(controller.update({ photos })).toMatchObject({ id: "p2" });
    expect(controller.update({ photos, called: true })).toBe(null);
    expect(controller.update({ photos: [{ id: "p2", version: "v2", imageUrl: "/api/photo-wall/photos/p2/image?version=v2" }] })).toMatchObject({ id: "p2", version: "v2" });
    expect(controller.cachedKeys()).toEqual(["p2:v2"]);
  });

  it("integrates a silent photo panel with reduced motion and overscan-safe CSS", async () => {
    const [html, js, css] = await Promise.all([read("public/tv.html"), read("public/js/tv-broadcast.js"), read("public/tv.css")]);
    expect(html).toContain('data-panel="constellation"');
    expect(html).not.toMatch(/<audio[^>]*photo/i);
    expect(js).toContain("createCarouselPhotoController");
    expect(js).toContain('fetch("/api/photo-wall"');
    expect(js).toMatch(/panelSeconds\s*=\s*16/);
    expect(css).toMatch(/\.photo-panel\s*\{[^}]*padding:\s*5vh\s+5vw/s);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.photo-panel/);
  });
});
