import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../dist/src/app.js";
import { createDatabase } from "../dist/src/db.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const dataDir = required("REHEARSAL_DATA_DIR");
const hostPassword = required("REHEARSAL_HOST_PASSWORD");
const guestPassword = required("REHEARSAL_GUEST_PASSWORD");
const hostToken = required("REHEARSAL_HOST_TOKEN");
const organizerTokens = [required("ORGANIZER_TOKEN_CHRIS"), required("ORGANIZER_TOKEN_PAUL")];
const hqPort = Number(process.env.REHEARSAL_HQ_PORT || 8792);
const authPort = Number(process.env.REHEARSAL_AUTH_PORT || 8793);
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const db = createDatabase(path.join(dataDir, "event.sqlite"));

const hq = createApp({
  db,
  organizerTokens,
  dataDir,
  organizerIdentityVerifier: async token => {
    const a = Buffer.from(token), b = Buffer.from(hostToken);
    return a.length === b.length && timingSafeEqual(a, b)
      ? { subject: "rehearsal-host-paul", displayName: "Paul Rehearsal Host", role: "host" }
      : null;
  },
  photoIdentityVerifier: async token => token === hostToken
    ? { subject: "rehearsal-host-paul", displayName: "Paul Rehearsal Host" }
    : null,
});

const sessions = new Map([[hostToken, { id: "rehearsal-host-paul", name: "Paul Rehearsal Host", role: "host" }]]);
const auth = express();
auth.disable("x-powered-by");
const allowedOrigins = new Set([`http://127.0.0.1:${hqPort}`, `http://localhost:${hqPort}`, `http://192.168.1.101:${hqPort}`]);
auth.use((req, res, next) => {
  const origin = req.header("origin") || "";
  if (allowedOrigins.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (req.method === "OPTIONS") return origin && res.get("Access-Control-Allow-Origin") ? res.status(204).end() : res.status(403).end();
  next();
});
auth.use(express.json({ limit: "4kb" }));
auth.post("/api/join", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 24);
  const password = String(req.body?.password || "");
  if (name.length < 2) return res.status(400).json({ error: "name too short" });
  const isHost = password === hostPassword && ["paul", "chris", "paul rehearsal host"].includes(name.toLowerCase());
  const isGuest = password === guestPassword;
  if (!isHost && !isGuest) return res.status(403).json({ error: "wrong rehearsal password" });
  const user = isHost
    ? { id: "rehearsal-host-paul", name: "Paul Rehearsal Host", role: "host" }
    : { id: `rehearsal-${randomUUID()}`, name, role: "guest" };
  const token = isHost ? hostToken : randomUUID();
  sessions.set(token, user);
  res.json({ token, user });
});
auth.get("/api/session", (req, res) => {
  const token = req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const user = token ? sessions.get(token) : null;
  if (!user) return res.status(401).json({ error: "not logged in" });
  res.json({ user });
});

const hqServer = hq.listen(hqPort, "0.0.0.0", () => console.log(`REHEARSAL_HQ_READY http://192.168.1.101:${hqPort}/paul/`));
const authServer = auth.listen(authPort, "0.0.0.0", () => console.log(`REHEARSAL_AUTH_READY http://192.168.1.101:${authPort}`));
const close = () => { authServer.close(); hqServer.close(() => { db.close(); process.exit(0); }); };
process.on("SIGINT", close);
process.on("SIGTERM", close);
