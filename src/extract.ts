// One LLM pass over new messages that pulls out both tasks and reported figures,
// so phase 3 adds no extra requests (matters on Gemini's free-tier daily limits).
import { config } from "./config.js";
import {
  getKv, groupName, insertTask, knownMetrics, messagesAfterRowid, messagesBeforeRowid,
  openTasks, setKv, updateTask, upsertMetric, type StoredMessage, type Task,
} from "./db.js";
import { completeJson } from "./llm.js";
import { dayKey, localIso } from "./time.js";

const CURSOR_KEY = "extract_cursor_rowid";
export const OWN_NAME_KEY = "own_display_name";
const BATCH_SIZE = 300;
const CONTEXT_MESSAGES = 10;
const MAX_OPEN_TASKS_IN_PROMPT = 60;

type Extraction = {
  new_tasks: { msg: string; kind: "mine" | "delegated"; title: string; assignee: string; due_at: string; due_text: string }[];
  updates: { task_id: number; status: "open" | "done" | "cancelled"; new_due_at: string; new_due_text: string }[];
  metrics: { msg: string; metric: string; reporter: string; value: number; unit: string; period_date: string; additive: boolean }[];
};

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const EXTRACTION_SCHEMA = obj({
  new_tasks: {
    type: "array",
    items: obj({
      msg: str,
      kind: { type: "string", enum: ["mine", "delegated"] },
      title: str,
      assignee: str,
      due_at: str,
      due_text: str,
    }),
  },
  updates: {
    type: "array",
    items: obj({
      task_id: { type: "integer" },
      status: { type: "string", enum: ["open", "done", "cancelled"] },
      new_due_at: str,
      new_due_text: str,
    }),
  },
  metrics: {
    type: "array",
    items: obj({
      msg: str,
      metric: str,
      reporter: str,
      value: { type: "number" },
      unit: str,
      period_date: str,
      additive: { type: "boolean" },
    }),
  },
});

function extractionPrompt(now: number): string {
  const ownName = getKv(OWN_NAME_KEY);
  return `Bạn trích xuất công việc và số liệu báo cáo từ log chat nhóm Zalo cho chủ tài khoản.
Trong log, tin của chủ tài khoản ghi là "Tôi"${ownName ? `; tên Zalo của họ là "${ownName}"` : ""}. Tin có "(@bạn)" là tin nhắc trực tiếp họ.
${config.userProfile ? `Về chủ tài khoản: ${config.userProfile}\n` : ""}
Thời điểm hiện tại: ${localIso(now)}. Mỗi tin có dạng "mã [ngày giờ] Người gửi: nội dung".

Trả về JSON gồm 3 phần. Chỉ lấy từ phần "TIN MỚI", phần ngữ cảnh chỉ để hiểu.

1. new_tasks: việc MỚI, chỉ gồm:
  - kind "mine": việc giao cho chủ tài khoản, hoặc chủ tài khoản nhận/hứa làm.
  - kind "delegated": chủ tài khoản giao cho người khác, hoặc người khác hứa làm cho chủ tài khoản.
  Bỏ qua việc giữa những người khác không liên quan đến chủ tài khoản, lời chào, câu hỏi xã giao.
  - msg: mã tin nguồn (ví dụ "m12").
  - title: mô tả ngắn, rõ việc gì (tiếng Việt, tối đa ~15 từ).
  - assignee: tên người làm ("Tôi" nếu là chủ tài khoản).
  - due_at: hạn chót dạng ISO 8601 có múi giờ, ví dụ "${localIso(now)}". Nếu chỉ có ngày thì lấy 17:00 ngày đó.
    "Mai", "thứ 6", "cuối tuần" tính theo ngày của tin nhắn. Không có hạn thì "".
  - due_text: cụm từ gốc nói về hạn (ví dụ "trước thứ 6"), không có thì "".

2. updates: thay đổi với VIỆC ĐANG MỞ (theo id): đã xong ("done"), bị hủy ("cancelled"),
  hoặc đổi hạn (status "open" và new_due_at mới). Không đổi hạn thì new_due_at và new_due_text là "".
  Không tạo việc trùng với việc đang mở.

3. metrics: số liệu kinh doanh/vận hành được BÁO CÁO trong tin (doanh số, số đơn, khách mới, tồn kho, tỷ lệ...).
  Không lấy số điện thoại, giá hỏi thử, số trong câu hỏi, kế hoạch/chỉ tiêu (trừ khi ghi rõ là chỉ tiêu, khi đó metric ghi "chỉ tiêu ...").
  - msg: mã tin nguồn.
  - metric: tên chỉ số tiếng Việt, chữ thường, ngắn gọn (ví dụ "doanh số", "khách hàng mới", "số đơn").
    BẮT BUỘC dùng lại đúng tên trong "CHỈ SỐ ĐÃ DÙNG" của nhóm đó nếu cùng ý nghĩa.
  - reporter: người/bộ phận mà con số thuộc về (thường là người gửi; nếu họ báo hộ người khác thì là người đó).
    Nếu tin nêu tổng của cả nhóm thì reporter là "Tổng".
  - value: số thuần. Tiền quy về triệu đồng (120tr → 120; 1,2 tỷ → 1200; 500k → 0.5). Dấu phẩy là phần thập phân.
  - unit: đơn vị sau khi quy đổi ("triệu đồng", "khách", "đơn", "%"...).
  - period_date: ngày mà số liệu thuộc về, dạng YYYY-MM-DD. "Hôm nay" là ngày của tin; "hôm qua" là ngày trước đó.
  - additive: true nếu cộng dồn được (tiền, số lượng); false với tỷ lệ, %, số dư, tồn kho, giá.
  Nếu tin là đính chính số đã báo ("em nhầm, DS là 130tr"), trả về số mới với cùng metric/reporter/period_date.
${config.metricHints ? `  Quy ước riêng của chủ tài khoản: ${config.metricHints}\n` : ""}
Không chắc thì bỏ qua. Không có gì thì trả về mảng rỗng.`;
}

function line(m: StoredMessage, label: string): string {
  const who = m.is_self ? "Tôi" : m.sender_name;
  return `${label}[${dayKey(m.ts)} ${localIso(m.ts).slice(11, 16)}] ${who}${m.mentions_me ? " (@bạn)" : ""}: ${m.text}`;
}

/** Open tasks for the prompt. `tasks` is sorted by deadline ascending, so the head holds the most urgent ones. */
export function formatOpenTasks(tasks: Task[]): string {
  if (!tasks.length) return "(không có)";
  return tasks
    .slice(0, MAX_OPEN_TASKS_IN_PROMPT)
    .map((t) => `id ${t.id} | ${t.kind} | ${t.assignee} | ${t.title} | hạn: ${t.due_at ? localIso(t.due_at) : "không"} | nhóm: ${groupName(t.group_id)}`)
    .join("\n");
}

function parseDue(iso: string): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Apply LLM task updates. `snapshot` is the task list read before the LLM call; each write is
 * conditional on the task still having its snapshot status, so a change the user made while the
 * model was running (e.g. "xong 3") is never overwritten.
 */
export function applyTaskUpdates(updates: Extraction["updates"], snapshot: Task[]): void {
  const statusById = new Map(snapshot.map((t) => [t.id, t.status]));
  for (const u of updates) {
    const expected = statusById.get(u.task_id);
    if (expected === undefined) continue;
    const due = parseDue(u.new_due_at);
    updateTask(
      u.task_id,
      {
        status: u.status,
        ...(due !== null && { due_at: due, due_text: u.new_due_text?.trim() ?? "" }),
      },
      expected,
    );
  }
}

async function extractBatch(batch: (StoredMessage & { rowid: number })[], now: number): Promise<void> {
  const byGroup = new Map<string, typeof batch>();
  for (const m of batch) byGroup.set(m.group_id, [...(byGroup.get(m.group_id) ?? []), m]);

  const metricsByGroup = new Map<string, string[]>();
  for (const k of knownMetrics()) {
    metricsByGroup.set(k.group_id, [...(metricsByGroup.get(k.group_id) ?? []), `${k.metric} (${k.unit})`]);
  }

  // Short ids ("m12") keep the prompt small and let us map results back to their message.
  const ids = new Map<string, StoredMessage>();
  const sections = [...byGroup.entries()].map(([groupId, msgs]) => {
    const context = messagesBeforeRowid(groupId, msgs[0].rowid, CONTEXT_MESSAGES);
    const fresh = msgs.map((m) => {
      const id = `m${ids.size + 1}`;
      ids.set(id, m);
      return line(m, `${id} `);
    });
    const known = metricsByGroup.get(groupId);
    return [
      `### Nhóm: ${groupName(groupId)}`,
      ...(known ? [`CHỈ SỐ ĐÃ DÙNG: ${known.join(", ")}`] : []),
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

  applyTaskUpdates(result.updates ?? [], open);

  for (const m of result.metrics ?? []) {
    const source = ids.get(m.msg);
    const metric = m.metric?.trim().toLowerCase();
    if (!source || !metric || typeof m.value !== "number" || !Number.isFinite(m.value)) continue;
    upsertMetric({
      group_id: source.group_id,
      period_date: /^\d{4}-\d{2}-\d{2}$/.test(m.period_date) ? m.period_date : dayKey(source.ts),
      metric,
      reporter: m.reporter?.trim() || source.sender_name,
      value: m.value,
      unit: m.unit?.trim() ?? "",
      additive: m.additive === false ? 0 : 1,
      source_msg_id: source.msg_id,
    });
  }
}

let running: Promise<void> = Promise.resolve();

/** Process all messages not yet seen by the extractor. Serialized so cron runs never overlap. */
export function extractNew(now = Date.now()): Promise<void> {
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
