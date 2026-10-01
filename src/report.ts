import { config } from "./config.js";
import { getKv, groupName, messagesBetween, setKv, type StoredMessage } from "./db.js";
import { complete } from "./llm.js";
import { extractTasks, taskSection } from "./tasks.js";
import { formatDate, formatTime } from "./time.js";

const LAST_REPORT_KEY = "last_report_to_ts";
const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `Bạn là trợ lý tóm tắt các nhóm chat Zalo công việc cho chủ tài khoản ("bạn").
Đầu vào là log tin nhắn của từng nhóm, mỗi dòng dạng "[HH:mm] Người gửi: nội dung".
Dòng có đánh dấu (@bạn) là tin nhắc trực tiếp đến chủ tài khoản. Dòng của "Tôi" là tin chủ tài khoản tự gửi.

Viết báo cáo buổi sáng bằng tiếng Việt, dạng văn bản thuần (KHÔNG dùng markdown như **, #, bảng) vì sẽ gửi qua Zalo.
Cấu trúc:
1. "CẦN BẠN CHÚ Ý": câu hỏi đang chờ bạn trả lời, tin @bạn cần phản hồi. Bỏ mục này nếu không có.
   (Danh sách việc và deadline được hệ thống liệt kê riêng ở cuối báo cáo, đừng lặp lại thành danh sách việc.)
2. Với mỗi nhóm có nội dung đáng kể, một khối:
   == Tên nhóm ==
   - Điểm chính / quyết định đã chốt
   - Số liệu được báo cáo (nếu có): liệt kê theo người/chỉ số, giữ nguyên đơn vị
3. Các nhóm chỉ có trò chuyện xã giao: gom lại một dòng "Không có gì quan trọng: ...".

Chỉ nêu điều có trong log, không suy đoán. Nếu một thông tin mơ hồ (ví dụ hạn "thứ 6" không rõ tuần nào), ghi đúng như trong log.`;

const STYLE_PROMPTS = {
  short: "Độ dài: ngắn gọn, mỗi nhóm tối đa 5 gạch đầu dòng, chỉ giữ điều thật sự quan trọng.",
  detailed: "Độ dài: chi tiết, nêu đủ các điểm thảo luận chính, ai nói gì nếu liên quan đến quyết định.",
};

function systemPrompt(): string {
  const parts = [SYSTEM_PROMPT, STYLE_PROMPTS[config.reportStyle]];
  if (config.userProfile) {
    parts.push(
      `Thông tin về chủ tài khoản, dùng để chọn điều gì quan trọng với họ và đặt lên đầu:\n${config.userProfile}`,
    );
  }
  return parts.join("\n\n");
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

/**
 * Build the report for messages since the last report (or the past 24h on first run).
 * Call `markReported` only after the report is delivered, so a failed send is retried next time.
 */
export async function buildReport(now = Date.now()): Promise<{ text: string; markReported: () => void }> {
  const fromTs = Number(getKv(LAST_REPORT_KEY) ?? now - DAY_MS);
  const messages = messagesBetween(fromTs, now);
  const markReported = () => setKv(LAST_REPORT_KEY, String(now));

  try {
    await extractTasks(now);
  } catch (err) {
    console.error("[report] task extraction failed, continuing without fresh tasks:", err);
  }
  const tasks = taskSection(now);

  const header = `BÁO CÁO ZALO - ${formatDate(now)}\n(${formatTime(fromTs)} ${formatDate(fromTs)} → ${formatTime(now)})`;
  if (!messages.length) {
    const body = "Không có tin nhắn mới trong các nhóm đang theo dõi.";
    return { text: [header, body, tasks].filter(Boolean).join("\n\n"), markReported };
  }

  const summary = await complete(systemPrompt(), buildTranscript(messages));
  return { text: [header, summary, tasks].filter(Boolean).join("\n\n"), markReported };
}
