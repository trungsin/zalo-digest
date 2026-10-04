import { ThreadType, type API, type Message } from "zca-js";
import { config } from "./config.js";
import { getKv, getTask, groupName, markReminded, openTasks, setKv, tasksToRemind, updateTask, type Task } from "./db.js";
import { dayKey, formatDue, localHour } from "./time.js";
import { monthToDateSection } from "./metrics.js";
import { selfThreadId, sendToSelf } from "./zalo.js";

// ---------------------------------------------------------------- formatting

function taskLine(t: Task, now: number): string {
  const who = t.kind === "delegated" ? ` [${t.assignee || "?"}]` : "";
  const due = t.due_at
    ? ` · hạn ${formatDue(t.due_at)}${t.due_at < now ? " (QUÁ HẠN)" : ""}`
    : t.due_text ? ` · "${t.due_text}"` : "";
  return `#${t.id}${who} ${t.title}${due} · ${groupName(t.group_id)}`;
}

/**
 * Deterministic task section. The morning report keeps "mine" to the coming week; the list command
 * passes `includeLater` so tasks due after that are listed too instead of looking like nothing is open.
 */
export function taskSection(now = Date.now(), { includeLater = false } = {}): string {
  const open = openTasks();
  if (!open.length) return "";

  const today = dayKey(now);
  const weekAhead = now + 7 * 24 * 3600e3;
  const mine = open.filter((t) => t.kind === "mine");
  const delegated = open.filter((t) => t.kind === "delegated");

  const block = (title: string, tasks: Task[]) =>
    tasks.length ? [`${title}:`, ...tasks.map((t) => `  ${taskLine(t, now)}`)] : [];

  const lines = [
    ...block("Quá hạn", mine.filter((t) => t.due_at !== null && t.due_at < now)),
    ...block("Hôm nay", mine.filter((t) => t.due_at !== null && t.due_at >= now && dayKey(t.due_at) === today)),
    ...block("7 ngày tới", mine.filter((t) => t.due_at !== null && dayKey(t.due_at) !== today && t.due_at >= now && t.due_at <= weekAhead)),
    ...block("Chưa có hạn", mine.filter((t) => t.due_at === null).slice(-10)),
    ...(includeLater ? block("Sau 7 ngày", mine.filter((t) => t.due_at !== null && t.due_at > weekAhead)) : []),
  ];
  const parts = [];
  if (lines.length) parts.push(["VIỆC CỦA BẠN", ...lines].join("\n"));
  if (delegated.length) parts.push(["VIỆC BẠN ĐANG CHỜ NGƯỜI KHÁC", ...delegated.map((t) => `  ${taskLine(t, now)}`)].join("\n"));
  if (!parts.length) return "";
  parts.push('Nhắn "xong 3" / "huy 3" vào Cloud của tôi để cập nhật, "viec" để xem danh sách, "solieu" để xem số liệu tháng.');
  return parts.join("\n\n");
}

/** Reply to the "viec" command: every open task, including those due more than a week out. */
export function taskListReply(now = Date.now()): string {
  return taskSection(now, { includeLater: true }) || "Không có việc nào đang mở.";
}

// ---------------------------------------------------------------- reminders

function inQuietHours(ts: number): boolean {
  const [start, end] = config.quietHours;
  const h = localHour(ts);
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** Send one batched reminder for tasks due soon, respecting quiet hours and the daily cap. */
export async function sendReminders(api: API, now = Date.now()): Promise<void> {
  if (inQuietHours(now)) return;

  const countKey = `reminders_sent_${dayKey(now)}`;
  const sentToday = Number(getKv(countKey) ?? 0);
  if (sentToday >= config.maxRemindersPerDay) return;

  const due = tasksToRemind(now + config.remindBeforeMin * 60e3);
  if (!due.length) return;

  const text = ["⏰ NHẮC VIỆC", ...due.map((t) => taskLine(t, now)), "", 'Nhắn "xong <số>" khi hoàn thành.'].join("\n");
  await sendToSelf(api, text);
  markReminded(due.map((t) => t.id), now);
  setKv(countKey, String(sentToday + 1));
}

// ---------------------------------------------------------------- commands in "Cloud của tôi"

const STATUS_COMMAND = /^(xong|done|huỷ|hủy|huy)\s+#?(\d+(?:[\s,#]+\d+)*)$/i;
const LIST_COMMAND = /^(việc|viec|tasks?)$/i;
const METRICS_COMMAND = /^(số ?liệu|so ?lieu)$/i;

/** Handle commands the owner types into their own Cloud thread. Returns true if handled. */
export async function handleCommand(api: API, message: Message): Promise<boolean> {
  if (message.type !== ThreadType.User || !message.isSelf) return false;
  if (message.data.idTo !== selfThreadId(api)) return false;
  if (typeof message.data.content !== "string") return false;
  const text = message.data.content.trim();

  if (METRICS_COMMAND.test(text)) {
    await sendToSelf(api, monthToDateSection());
    return true;
  }

  if (LIST_COMMAND.test(text)) {
    await sendToSelf(api, taskListReply());
    return true;
  }

  const match = text.match(STATUS_COMMAND);
  if (!match) return false;

  const status = /^(xong|done)$/i.test(match[1]) ? "done" : "cancelled";
  const results = match[2].split(/[\s,#]+/).filter(Boolean).map(Number).map((id) => {
    const task = getTask(id);
    if (!task) return `#${id}: không tìm thấy`;
    updateTask(id, { status });
    return `#${id} ${task.title}`;
  });
  await sendToSelf(api, `${status === "done" ? "✅ Đã xong" : "🗑 Đã hủy"}:\n${results.join("\n")}`);
  return true;
}
