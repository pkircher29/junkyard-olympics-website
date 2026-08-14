import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createApp } from "./app.js";
import { createDatabase } from "./db.js";

export interface ConfiguredAppOptions {
  acceptance?: boolean;
  databasePath?: string;
  organizerTokens?: string[];
}

export async function createConfiguredApp(options: ConfiguredAppOptions = {}) {
  const dataDir = process.env.DATA_DIR ?? path.resolve("data");
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.join(dataDir, "junkyard.sqlite");
  if (databasePath !== ":memory:") await mkdir(path.dirname(databasePath), { recursive: true });
  const organizerTokens = options.organizerTokens ?? (process.env.ORGANIZER_TOKENS ?? (options.acceptance ? "acceptance-chris,acceptance-paul" : ""))
    .split(",").map(token => token.trim()).filter(Boolean);
  if (organizerTokens.length < 2) throw new Error("ORGANIZER_TOKENS must contain two comma-separated high-entropy credentials");
  const db = createDatabase(databasePath);
  return createApp({ db, organizerTokens });
}

export const createAppFactory = createConfiguredApp;
export default createConfiguredApp;
