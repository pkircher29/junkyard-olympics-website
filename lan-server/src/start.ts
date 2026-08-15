import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createApp } from "./app.js";
import { backupDatabase, createDatabase } from "./db.js";
import { createSessionVerifier } from "./session-verifier.js";

const dataDir = process.env.DATA_DIR ?? path.resolve("data");
await mkdir(dataDir, { recursive: true });
const databasePath =
  process.env.DATABASE_PATH ?? path.join(dataDir, "junkyard.sqlite");
const organizerTokens = (process.env.ORGANIZER_TOKENS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
if (!organizerTokens.length)
  throw new Error(
    "ORGANIZER_TOKENS must contain comma-separated high-entropy credentials",
  );

const db = createDatabase(databasePath);
if (databasePath !== ":memory:") {
  const backupDir = path.join(dataDir, "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await backupDatabase(db, path.join(backupDir, `startup-${stamp}.sqlite`));
}
const sessionVerifyUrl = (process.env.PAUL_SESSION_VERIFY_URL ?? process.env.PHOTO_AUTH_VERIFY_URL)?.trim();
const sessionVerifier = sessionVerifyUrl ? createSessionVerifier(sessionVerifyUrl) : undefined;
const photoIdentityVerifier = sessionVerifier
  ? async (token: string) => {
      const verified = await sessionVerifier(token);
      return verified ? { subject: verified.subject, displayName: verified.displayName } : null;
    }
  : undefined;
const app = createApp({
  db,
  organizerTokens,
  dataDir,
  photoIdentityVerifier,
  organizerIdentityVerifier: sessionVerifier,
});
const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`Junkyard Olympics listening on http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
}
