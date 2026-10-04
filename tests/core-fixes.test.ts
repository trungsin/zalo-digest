import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts resolves the data directory at import time, so point it at a scratch dir before loading modules.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-core-fixes-"));
process.env.USER_DIR = dir;
delete process.env.DATA_DIR;
delete process.env.PORTAL_SCOPED;

const dbMod = await import("../src/db.js");
const { reportWindow } = await import("../src/report.js");
const { taskListReply, taskSection } = await import("../src/tasks.js");
const { applyTaskUpdates, formatOpenTasks } = await import("../src/extract.js");
const { geminiText } = await import("../src/llm.js");
const { FinishReason } = await import("@google/genai");

const { captureReportRowidBaseline, db, getTask, insertMessage, insertTask, openTasks, updateTask } = dbMod;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

function message(id: string, ts: number) {
  insertMessage({
    msg_id: id, group_id: "g1", sender_id: "u1", sender_name: "An", msg_type: "text",
    text: `tin ${id}`, mentions_me: 0, is_self: 0, ts, raw: "{}",
  });
}

function task(title: string, dueAt: number | null, kind: "mine" | "delegated" = "mine"): number {
  insertTask({ group_id: "g1", source_msg_id: `src-${title}`, kind, title, assignee: "", due_at: dueAt, due_text: "" });
  const row = db.prepare("SELECT id FROM tasks WHERE title = ?").get(title) as { id: number };
  return row.id;
}

before(() => {
  dbMod.upsertGroup("g1", "Nhóm 1");
});

beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM tasks; DELETE FROM kv;");
});

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a late message sent before the last report still lands in the next report", () => {
  const t0 = Date.parse("2026-10-01T08:00:00+07:00");
  message("a", t0 - HOUR);
  const first = reportWindow(t0);
  assert.deepEqual(first.messages.map((m) => m.msg_id), ["a"]);
  first.markReported();

  // Sent before the first report closed, but recorded only afterwards (reconnect backfill).
  message("late", t0 - 30 * 60e3);
  message("fresh", t0 + HOUR);
  const second = reportWindow(t0 + DAY);
  assert.deepEqual(second.messages.map((m) => m.msg_id).sort(), ["fresh", "late"]);
  second.markReported();

  assert.deepEqual(reportWindow(t0 + 2 * DAY).messages, []);
});

test("a report that is not marked delivered keeps its messages for the retry", () => {
  const t0 = Date.parse("2026-10-01T08:00:00+07:00");
  message("a", t0 - HOUR);
  reportWindow(t0); // build failed or send failed: markReported never runs
  assert.deepEqual(reportWindow(t0 + HOUR).messages.map((m) => m.msg_id), ["a"]);
});

test("existing data with only the timestamp watermark keeps working and then switches to rowids", () => {
  const t0 = Date.parse("2026-10-01T08:00:00+07:00");
  message("old", t0 - 2 * HOUR); // already covered by a report made before the rowid cursor existed
  message("new", t0 + HOUR);
  dbMod.setKv("last_report_to_ts", String(t0));
  captureReportRowidBaseline();

  const window = reportWindow(t0 + DAY);
  assert.equal(window.fromTs, t0);
  assert.deepEqual(window.messages.map((m) => m.msg_id), ["new"]);
  window.markReported();
  assert.equal(dbMod.getKv("last_report_to_ts"), String(t0 + DAY));

  message("late", t0 + HOUR / 2);
  assert.deepEqual(reportWindow(t0 + 2 * DAY).messages.map((m) => m.msg_id), ["late"]);
});

test("after an upgrade, a late message ingested before the first new-style report is not lost", () => {
  const t0 = Date.parse("2026-10-01T08:00:00+07:00");
  // Old database: reported up to t0 by timestamp only, no rowid cursor.
  message("reported", t0 - 2 * HOUR);
  dbMod.setKv("last_report_to_ts", String(t0));
  captureReportRowidBaseline(); // the upgraded process opens the DB
  captureReportRowidBaseline(); // reopening must not move the baseline
  assert.equal(dbMod.getKv("report_rowid_baseline"), String(dbMod.maxMessageRowid()));

  // Ingested after the upgrade but sent before the old watermark (reconnect backfill).
  message("late", t0 - HOUR);
  message("fresh", t0 + HOUR);

  const first = reportWindow(t0 + DAY);
  assert.deepEqual(first.messages.map((m) => m.msg_id).sort(), ["fresh", "late"]);
  first.markReported();

  captureReportRowidBaseline(); // a rowid cursor exists now; nothing to capture
  message("next", t0 + DAY + HOUR);
  assert.deepEqual(reportWindow(t0 + 2 * DAY).messages.map((m) => m.msg_id), ["next"]);
});

test("the list command shows tasks whose deadline is more than a week away", () => {
  const now = Date.parse("2026-10-01T08:00:00+07:00");
  task("Nộp báo cáo quý", now + 20 * DAY);

  assert.equal(taskSection(now), "", "the morning report still keeps to the coming week");
  const reply = taskListReply(now);
  assert.doesNotMatch(reply, /Không có việc nào đang mở/);
  assert.match(reply, /Sau 7 ngày:/);
  assert.match(reply, /Nộp báo cáo quý/);
});

test("the list command reports no tasks only when nothing is open", () => {
  const now = Date.parse("2026-10-01T08:00:00+07:00");
  assert.equal(taskListReply(now), "Không có việc nào đang mở.");
});

test("the extraction prompt keeps the most urgent open tasks when there are too many", () => {
  const now = Date.parse("2026-10-01T08:00:00+07:00");
  task("Quá hạn lâu nhất", now - 5 * DAY);
  for (let i = 1; i <= 70; i++) task(`Việc ${i}`, now + i * DAY);
  task("Không có hạn", null);

  const prompt = formatOpenTasks(openTasks());
  assert.equal(prompt.split("\n").length, 60);
  assert.match(prompt, /Quá hạn lâu nhất/);
  assert.match(prompt, /\| Việc 1 \|/);
  assert.doesNotMatch(prompt, /\| Việc 70 \|/);
  assert.doesNotMatch(prompt, /Không có hạn/);
});

test("an LLM update does not overwrite a status the user changed during the call", () => {
  const now = Date.now();
  const closedByUser = task("Gửi hợp đồng", now + DAY);
  const untouched = task("Gọi khách", now + DAY);
  const snapshot = openTasks(); // read before the LLM call

  updateTask(closedByUser, { status: "done" }); // user types "xong" while the model is running
  const newDue = new Date(now + 3 * DAY).toISOString();
  applyTaskUpdates(
    [
      { task_id: closedByUser, status: "open", new_due_at: newDue, new_due_text: "thứ 6" },
      { task_id: untouched, status: "done", new_due_at: "", new_due_text: "" },
    ],
    snapshot,
  );

  assert.equal(getTask(closedByUser)?.status, "done");
  assert.equal(getTask(closedByUser)?.due_at, now + DAY);
  assert.equal(getTask(untouched)?.status, "done");
});

test("a conditional task update only writes while the status matches", () => {
  const id = task("Duyệt chi", null);
  assert.equal(updateTask(id, { status: "done" }, "cancelled"), false);
  assert.equal(getTask(id)?.status, "open");
  assert.equal(updateTask(id, { status: "done" }, "open"), true);
  assert.equal(getTask(id)?.status, "done");
  assert.equal(updateTask(id, { status: "cancelled" }), true, "unconditional updates are unchanged");
  assert.equal(getTask(id)?.status, "cancelled");
});

test("a Gemini reply cut off by the token limit is rejected", () => {
  assert.throws(
    () => geminiText({ text: "BÁO CÁO ZALO - nửa chừng", candidates: [{ finishReason: FinishReason.MAX_TOKENS }] }),
    /truncated.*MAX_TOKENS/,
  );
  assert.equal(geminiText({ text: "Báo cáo đầy đủ", candidates: [{ finishReason: FinishReason.STOP }] }), "Báo cáo đầy đủ");
  assert.throws(() => geminiText({ text: "", candidates: [{ finishReason: FinishReason.SAFETY }] }), /Empty Gemini response/);
});
