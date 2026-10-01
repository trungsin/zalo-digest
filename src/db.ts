import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS groups (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    msg_id      TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    msg_type    TEXT NOT NULL,
    text        TEXT NOT NULL,
    mentions_me INTEGER NOT NULL DEFAULT 0,
    is_self     INTEGER NOT NULL DEFAULT 0,
    ts          INTEGER NOT NULL,
    raw         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages (group_id, ts);

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export type StoredMessage = {
  msg_id: string;
  group_id: string;
  sender_id: string;
  sender_name: string;
  msg_type: string;
  text: string;
  mentions_me: number;
  is_self: number;
  ts: number;
  raw: string;
};

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (msg_id, group_id, sender_id, sender_name, msg_type, text, mentions_me, is_self, ts, raw)
  VALUES
    (:msg_id, :group_id, :sender_id, :sender_name, :msg_type, :text, :mentions_me, :is_self, :ts, :raw)
`);

export function insertMessage(m: StoredMessage): void {
  insertStmt.run(m);
}

export function upsertGroup(id: string, name: string): void {
  db.prepare(
    "INSERT INTO groups (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
  ).run(id, name);
}

export function groupName(id: string): string {
  const row = db.prepare("SELECT name FROM groups WHERE id = ?").get(id) as { name: string } | undefined;
  return row?.name ?? id;
}

export function messagesBetween(fromTs: number, toTs: number): StoredMessage[] {
  return db
    .prepare("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY group_id, ts")
    .all(fromTs, toTs) as StoredMessage[];
}

export function getKv(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
