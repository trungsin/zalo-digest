import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { getKv, groupName, messagesBetween, setKv, type StoredMessage } from "./db.js";

const client = new Anthropic();
const LAST_REPORT_KEY = "last_report_to_ts";
const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `Bạn là trợ lý tóm tắt các nhóm chat Zalo công việc cho chủ tài khoản ("bạn").
Đầu vào là log tin nhắn của từng nhóm, mỗi dòng dạng "[HH:mm] Người gửi: nội dung".
Dòng có đánh dấu (@bạn) là tin nhắc trực tiếp đến chủ tài khoản. Dòng của "Tôi" là tin chủ tài khoản tự gửi.

Viết báo cáo buổi sáng bằng tiếng Việt, dạng văn bản thuần (KHÔNG dùng markdown như **, #, bảng) vì sẽ gửi qua Zalo.
Cấu trúc:
1. "CẦN BẠN CHÚ Ý": việc được giao cho bạn, câu hỏi đang chờ bạn trả lời, tin @bạn. Bỏ mục này nếu không có.
2. Với mỗi nhóm có nội dung đáng kể, một khối:
   == Tên nhóm ==
   - Điểm chính / quyết định đã chốt
   - Việc cần làm: ai làm gì, hạn khi nào (ghi rõ nếu không có hạn)
   - Số liệu được báo cáo (nếu có): liệt kê theo người/chỉ số, giữ nguyên đơn vị
3. Các nhóm chỉ có trò chuyện xã giao: gom lại một dòng "Không có gì quan trọng: ...".

Ngắn gọn, chỉ nêu điều có trong log, không suy đoán. Nếu một thông tin mơ hồ (ví dụ hạn "thứ 6" không rõ tuần nào), ghi đúng như trong log.`;

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ts);
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: config.timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(ts);
}

function buildTranscript(messages: StoredMessage[]): string {
  const byGroup = new Map<string, StoredMessage[]>();
  for (const m of messages) {
    const list = byGroup.get(m.group_id) ?? [];
    list.push(m);
    byGroup.set(m.group_id, list);
  }

  return [...byGroup.entries()]
    .map(([groupId, msgs]) => {
      const lines = msgs.map((m) => {
        const who = m.is_self ? "Tôi" : m.sender_name;
        const tag = m.mentions_me ? " (@bạn)" : "";
        return `[${formatTime(m.ts)}] ${who}${tag}: ${m.text}`;
      });
      return `### Nhóm: ${groupName(groupId)} (${msgs.length} tin)\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

async function summarize(transcript: string): Promise<string> {
  const response = await client.beta.messages.create({
    model: config.summaryModel,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: transcript }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Model refused to summarize: ${JSON.stringify(response.stop_details)}`);
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  if (!text) throw new Error(`Empty summary (stop_reason: ${response.stop_reason})`);
  return text;
}

/**
 * Build the report for messages since the last report (or the past 24h on first run).
 * Call `markReported` only after the report is delivered, so a failed send is retried next time.
 */
export async function buildReport(now = Date.now()): Promise<{ text: string; markReported: () => void }> {
  const fromTs = Number(getKv(LAST_REPORT_KEY) ?? now - DAY_MS);
  const messages = messagesBetween(fromTs, now);
  const markReported = () => setKv(LAST_REPORT_KEY, String(now));

  const header = `BÁO CÁO ZALO - ${formatDate(now)}\n(${formatTime(fromTs)} ${formatDate(fromTs)} → ${formatTime(now)})`;
  if (!messages.length) {
    return { text: `${header}\n\nKhông có tin nhắn mới trong các nhóm đang theo dõi.`, markReported };
  }

  const summary = await summarize(buildTranscript(messages));
  return { text: `${header}\n\n${summary}`, markReported };
}
