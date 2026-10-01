import { ThreadType, type API, type Message } from "zca-js";
import { config } from "./config.js";
import {
  getKv, getTask, groupName, insertTask, markReminded, messagesAfterRowid, messagesBeforeRowid,
  openTasks, setKv, tasksToRemind, updateTask, type StoredMessage, type Task,
} from "./db.js";
import { completeJson } from "./llm.js";
import { dayKey, formatDue, formatTime, localHour, localIso } from "./time.js";
import { sendToSelf } from "./zalo.js";

const CURSOR_KEY = "extract_cursor_rowid";
export const OWN_NAME_KEY = "own_display_name";
const BATCH_SIZE = 300;
const CONTEXT_MESSAGES = 10;
const MAX_OPEN_TASKS_IN_PROMPT = 60;

// ---------------------------------------------------------------- extraction

type Extraction = {
  new_tasks: { msg: string; kind: "mine" | "delegated"; title: string; assignee: string; due_at: string; due_text: string }[];
  updates: { task_id: number; status: "open" | "done" | "cancelled"; new_due_at: string; new_due_text: string }[];
};

const str = { type: "string" } as const;
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["new_tasks", "updates"],
  properties: {
    new_tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["msg", "kind", "title", "assignee", "due_at", "due_text"],
        properties: {
          msg: str,
          kind: { type: "string", enum: ["mine", "delegated"] },
          title: str,
          assignee: str,
          due_at: str,
          due_text: str,
        },
      },
    },
    updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "status", "new_due_at", "new_due_text"],
        properties: {
          task_id: { type: "integer" },
          status: { type: "string", enum: ["open", "done", "cancelled"] },
          new_due_at: str,
          new_due_text: str,
        },
      },
    },
  },
};

function extractionPrompt(now: number): string {
  const ownName = getKv(OWN_NAME_KEY);
  return `Bạn trích xuất công việc từ log chat nhóm Zalo cho chủ tài khoản.
Trong log, tin của chủ tài khoản ghi là "Tôi"${ownName ? `; tên Zalo của họ là "${ownName}"` : ""}. Tin có "(@bạn)" là tin nhắc trực tiếp họ.
${config.userProfile ? `Về chủ tài khoản: ${config.userProfile}\n` : ""}
Thời điểm hiện tại: ${localIso(now)}.

Trả về JSON:
- new_tasks: việc MỚI xuất hiện trong phần "TIN MỚI" (không lấy từ phần ngữ cảnh), chỉ gồm:
  - kind "mine": việc giao cho chủ tài khoản, hoặc chủ tài khoản nhận/hứa làm.
  - kind "delegated": chủ tài khoản giao cho người khác, hoặc người khác hứa làm cho chủ tài khoản.
  Bỏ qua việc giữa những người khác không liên quan đến chủ tài khoản, lời chào, câu hỏi xã giao.
  - msg: mã tin nguồn (ví dụ "m12").
  - title: mô tả ngắn, rõ việc gì (tiếng Việt, tối đa ~15 từ).
  - assignee: tên người làm ("Tôi" nếu là chủ tài khoản).
  - due_at: hạn chót dạng ISO 8601 có múi giờ, ví dụ "${localIso(now)}". Nếu chỉ có ngày thì lấy 17:00 ngày đó.
    "Mai", "thứ 6", "cuối tuần" tính theo thời điểm hiện tại. Không có hạn thì "".
  - due_text: cụm từ gốc nói về hạn (ví dụ "trước thứ 6"), không có thì "".
- updates: thay đổi với VIỆC ĐANG MỞ (theo id) mà tin mới cho thấy: đã xong ("done"), bị hủy ("cancelled"),
  hoặc đổi hạn (status "open" và new_due_at mới). Không đổi hạn thì new_due_at và new_due_text là "".

Không tạo việc trùng với việc đang mở. Không chắc thì bỏ qua. Không có gì thì trả về mảng rỗng.`;
}

function line(m: StoredMessage, label: string): string {
  const who = m.is_self ? "Tôi" : m.sender_name;
  return `${label}[${formatTime(m.ts)}] ${who}${m.mentions_me ? " (@bạn)" : ""}: ${m.text}`;
}

function formatOpenTasks(tasks: Task[]): string {
  if (!tasks.length) return "(không có)";
  return tasks
    .slice(-MAX_OPEN_TASKS_IN_PROMPT)
    .map((t) => `id ${t.id} | ${t.kind} | ${t.assignee} | ${t.title} | hạn: ${t.due_at ? localIso(t.due_at) : "không"} | nhóm: ${groupName(t.group_id)}`)
    .join("\n");
}

function parseDue(iso: string): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

async function extractBatch(batch: (StoredMessage & { rowid: number })[], now: number): Promise<void> {
  const byGroup = new Map<string, typeof batch>();
  for (const m of batch) byGroup.set(m.group_id, [...(byGroup.get(m.group_id) ?? []), m]);

  // Short ids ("m12") keep the prompt small and let us map a task back to its message.
  const ids = new Map<string, StoredMessage>();
  const sections = [...byGroup.entries()].map(([groupId, msgs]) => {
    const context = messagesBeforeRowid(groupId, msgs[0].rowid, CONTEXT_MESSAGES);
    const fresh = msgs.map((m) => {
      const id = `m${ids.size + 1}`;
      ids.set(id, m);
      return line(m, `${id} `);
    });
    return [
      `### Nhóm: ${groupName(groupId)}`,
      ...(context.length ? ["Ngữ cảnh (đã xử lý trước đó):", ...context.map((m) => line(m, "  "))] : []),
      "TIN MỚI:",
      ...fresh,
    ].join("\n");
  });

  const open = openTasks();
  const user = `VIỆC ĐANG MỞ:\n${formatOpenTasks(open)}\n\n${sections.join("\n\n")}`;
  const result = await completeJson<Extraction>(extractionPrompt(now), user, EXTRACTION_SCHEMA);

  for (const t of result.new_tasks ?? []) {
    const source = ids.get(t.msg);
    if (!source || !t.title?.trim()) continue;
    insertTask({
      group_id: source.group_id,
      source_msg_id: source.msg_id,
      kind: t.kind === "delegated" ? "delegated" : "mine",
      title: t.title.trim(),
      assignee: t.assignee?.trim() ?? "",
      due_at: parseDue(t.due_at),
      due_text: t.due_text?.trim() ?? "",
    });
  }

  const openIds = new Set(open.map((t) => t.id));
  for (const u of result.updates ?? []) {
    if (!openIds.has(u.task_id)) continue;
    const due = parseDue(u.new_due_at);
    updateTask(u.task_id, {
      status: u.status,
      ...(due !== null && { due_at: due, due_text: u.new_due_text?.trim() ?? "" }),
    });
  }
}

let running: Promise<void> = Promise.resolve();

/** Process all messages not yet seen by the extractor. Serialized so cron runs never overlap. */
export function extractTasks(now = Date.now()): Promise<void> {
  running = running.catch(() => {}).then(async () => {
    for (;;) {
      const cursor = Number(getKv(CURSOR_KEY) ?? 0);
      const batch = messagesAfterRowid(cursor, BATCH_SIZE);
      if (!batch.length) return;
      await extractBatch(batch, now);
      setKv(CURSOR_KEY, String(batch[batch.length - 1].rowid));
      if (batch.length < BATCH_SIZE) return;
    }
  });
  return running;
}

// ---------------------------------------------------------------- formatting

function taskLine(t: Task, now: number): string {
  const who = t.kind === "delegated" ? ` [${t.assignee || "?"}]` : "";
  const due = t.due_at
    ? ` · hạn ${formatDue(t.due_at)}${t.due_at < now ? " (QUÁ HẠN)" : ""}`
    : t.due_text ? ` · "${t.due_text}"` : "";
  return `#${t.id}${who} ${t.title}${due} · ${groupName(t.group_id)}`;
}

/** Deterministic task section for the morning report. */
export function taskSection(now = Date.now()): string {
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
  ];
  const parts = [];
  if (lines.length) parts.push(["VIỆC CỦA BẠN", ...lines].join("\n"));
  if (delegated.length) parts.push(["VIỆC BẠN ĐANG CHỜ NGƯỜI KHÁC", ...delegated.map((t) => `  ${taskLine(t, now)}`)].join("\n"));
  if (!parts.length) return "";
  parts.push('Nhắn "xong 3" / "huy 3" vào Cloud của tôi để cập nhật, "viec" để xem danh sách.');
  return parts.join("\n\n");
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

/** Handle commands the owner types into their own Cloud thread. Returns true if handled. */
export async function handleCommand(api: API, message: Message): Promise<boolean> {
  if (message.type !== ThreadType.User || !message.isSelf) return false;
  if (message.data.idTo !== api.getOwnId()) return false;
  if (typeof message.data.content !== "string") return false;
  const text = message.data.content.trim();

  if (LIST_COMMAND.test(text)) {
    await sendToSelf(api, taskSection() || "Không có việc nào đang mở.");
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
