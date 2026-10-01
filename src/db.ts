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

  -- kind: 'mine' = assigned to the account owner; 'delegated' = owner is waiting on someone else.
  CREATE TABLE IF NOT EXISTS tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id      TEXT NOT NULL,
    source_msg_id TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('mine', 'delegated')),
    title         TEXT NOT NULL,
    assignee      TEXT NOT NULL DEFAULT '',
    due_at        INTEGER,
    due_text      TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    reminded_at   INTEGER,
    UNIQUE (source_msg_id, title)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_at);

  -- One figure per (group, day, metric, reporter); a later correction overwrites it.
  CREATE TABLE IF NOT EXISTS metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id      TEXT NOT NULL,
    period_date   TEXT NOT NULL,
    metric        TEXT NOT NULL,
    reporter      TEXT NOT NULL,
    value         REAL NOT NULL,
    unit          TEXT NOT NULL DEFAULT '',
    additive      INTEGER NOT NULL DEFAULT 1,
    source_msg_id TEXT NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (group_id, period_date, metric, reporter)
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_updated ON metrics (updated_at);

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

export type StoredMessageWithRowid = StoredMessage & { rowid: number };

/** Messages in insertion order after a rowid cursor (robust to late-arriving old messages). */
export function messagesAfterRowid(rowid: number, limit: number): StoredMessageWithRowid[] {
  return db
    .prepare("SELECT rowid, * FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .all(rowid, limit) as StoredMessageWithRowid[];
}

/** The last `limit` messages of a group before a rowid, oldest first — context for extraction. */
export function messagesBeforeRowid(groupId: string, rowid: number, limit: number): StoredMessage[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE group_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
    .all(groupId, rowid, limit) as StoredMessage[];
  return rows.reverse();
}

export type Task = {
  id: number;
  group_id: string;
  source_msg_id: string;
  kind: "mine" | "delegated";
  title: string;
  assignee: string;
  due_at: number | null;
  due_text: string;
  status: "open" | "done" | "cancelled";
  created_at: number;
  updated_at: number;
  reminded_at: number | null;
};

export function insertTask(t: Pick<Task, "group_id" | "source_msg_id" | "kind" | "title" | "assignee" | "due_at" | "due_text">): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO tasks (group_id, source_msg_id, kind, title, assignee, due_at, due_text, created_at, updated_at)
    VALUES (:group_id, :source_msg_id, :kind, :title, :assignee, :due_at, :due_text, :now, :now)
  `).run({ ...t, now });
}

export function updateTask(id: number, fields: Partial<Pick<Task, "status" | "due_at" | "due_text">>): boolean {
  const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  if (!current) return false;
  const next = { ...current, ...fields };
  // A new deadline deserves a new reminder.
  const remindedAt = next.due_at !== current.due_at ? null : current.reminded_at;
  db.prepare(
    "UPDATE tasks SET status = ?, due_at = ?, due_text = ?, reminded_at = ?, updated_at = ? WHERE id = ?",
  ).run(next.status, next.due_at, next.due_text, remindedAt, Date.now(), id);
  return true;
}

export function openTasks(): Task[] {
  return db
    .prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY due_at IS NULL, due_at, id")
    .all() as Task[];
}

export function getTask(id: number): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

/** Open tasks with a deadline before `ts` that haven't been reminded yet. */
export function tasksToRemind(ts: number): Task[] {
  return db
    .prepare("SELECT * FROM tasks WHERE status = 'open' AND reminded_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at")
    .all(ts) as Task[];
}

export function markReminded(ids: number[], ts: number): void {
  const stmt = db.prepare("UPDATE tasks SET reminded_at = ? WHERE id = ?");
  for (const id of ids) stmt.run(ts, id);
}

export type Metric = {
  id: number;
  group_id: string;
  period_date: string; // YYYY-MM-DD in the report timezone
  metric: string;
  reporter: string;
  value: number;
  unit: string;
  additive: number;
  source_msg_id: string;
  updated_at: number;
};

export function upsertMetric(m: Omit<Metric, "id" | "updated_at">): void {
  db.prepare(`
    INSERT INTO metrics (group_id, period_date, metric, reporter, value, unit, additive, source_msg_id, updated_at)
    VALUES (:group_id, :period_date, :metric, :reporter, :value, :unit, :additive, :source_msg_id, :now)
    ON CONFLICT (group_id, period_date, metric, reporter) DO UPDATE SET
      value = excluded.value, unit = excluded.unit, additive = excluded.additive,
      source_msg_id = excluded.source_msg_id, updated_at = excluded.updated_at
  `).run({ ...m, now: Date.now() });
}

/** Distinct metric names per group, so the extractor reuses existing names. */
export function knownMetrics(): { group_id: string; metric: string; unit: string }[] {
  return db
    .prepare("SELECT group_id, metric, MAX(unit) AS unit FROM metrics GROUP BY group_id, metric ORDER BY group_id, metric")
    .all() as { group_id: string; metric: string; unit: string }[];
}

export function metricsUpdatedSince(ts: number): Metric[] {
  return db.prepare("SELECT * FROM metrics WHERE updated_at >= ? ORDER BY group_id, metric, period_date").all(ts) as Metric[];
}

/** All rows of one group+metric between two dates (inclusive, YYYY-MM-DD). */
export function metricRows(groupId: string, metric: string, fromDate: string, toDate: string): Metric[] {
  return db
    .prepare("SELECT * FROM metrics WHERE group_id = ? AND metric = ? AND period_date BETWEEN ? AND ? ORDER BY period_date, reporter")
    .all(groupId, metric, fromDate, toDate) as Metric[];
}

export function metricsBetweenDates(fromDate: string, toDate: string): Metric[] {
  return db
    .prepare("SELECT * FROM metrics WHERE period_date BETWEEN ? AND ? ORDER BY group_id, metric, period_date")
    .all(fromDate, toDate) as Metric[];
}

export function previousPeriodDate(groupId: string, metric: string, beforeDate: string): string | undefined {
  const row = db
    .prepare("SELECT MAX(period_date) AS d FROM metrics WHERE group_id = ? AND metric = ? AND period_date < ?")
    .get(groupId, metric, beforeDate) as { d: string | null };
  return row.d ?? undefined;
}

export function allMetrics(): (Metric & { source_text: string | null })[] {
  return db
    .prepare(`SELECT m.*, msg.text AS source_text FROM metrics m
              LEFT JOIN messages msg ON msg.msg_id = m.source_msg_id
              ORDER BY m.group_id, m.period_date, m.metric, m.reporter`)
    .all() as (Metric & { source_text: string | null })[];
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
