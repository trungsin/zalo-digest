import { ThreadType, type API, type GroupMessage, type Message } from "zca-js";
import { config } from "./config.js";
import { insertMessage, upsertGroup } from "./db.js";

/** Turn a Zalo message payload into readable text for the summarizer. */
function messageText(msg: GroupMessage): string {
  const { content, msgType } = msg.data;
  if (typeof content === "string") return content;

  const parts = [content.title, content.description, content.href]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const kind = msgType.replace(/^chat\./, "");
  return parts.length ? `[${kind}] ${parts.join(" | ")}` : `[${kind}]`;
}

function record(api: API, message: Message): void {
  if (message.type !== ThreadType.Group) return;
  if (!config.trackedGroupIds.has(message.threadId)) return;

  const ownId = api.getOwnId();
  const { data } = message;
  insertMessage({
    msg_id: data.msgId,
    group_id: message.threadId,
    sender_id: data.uidFrom,
    sender_name: data.dName || data.uidFrom,
    msg_type: data.msgType,
    text: messageText(message),
    mentions_me: data.mentions?.some((m) => m.uid === ownId || m.type === 1) ? 1 : 0,
    is_self: message.isSelf ? 1 : 0,
    ts: Number(data.ts),
    raw: JSON.stringify(data),
  });
}

export async function refreshGroupNames(api: API): Promise<void> {
  const ids = [...config.trackedGroupIds];
  if (!ids.length) return;
  const info = await api.getGroupInfo(ids);
  for (const [id, group] of Object.entries(info.gridInfoMap)) {
    upsertGroup(id, group.name);
  }
}

export function startRecorder(api: API, onSessionLost: (reason: string) => void): void {
  const { listener } = api;

  listener.on("message", (message) => record(api, message));
  listener.on("old_messages", (messages) => messages.forEach((m) => record(api, m)));
  listener.on("connected", () => console.log("[listener] connected"));
  listener.on("error", (err) => console.error("[listener] error:", err));
  listener.on("closed", (code, reason) => {
    console.error(`[listener] closed: ${code} ${reason}`);
    onSessionLost(`Listener closed (code ${code}): ${reason}`);
  });

  listener.start({ retryOnClose: true });
}
