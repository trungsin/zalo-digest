import { db, insertMessage, upsertGroup } from "../src/db.js";
import { startMcpHttp } from "../src/mcp.js";
for (const id of ["selected", "hidden"]) {
  upsertGroup(id, id);
  insertMessage({ msg_id: id, group_id: id, sender_id: "sender", sender_name: "sender", msg_type: "chat.text", text: id, mentions_me: 0, is_self: 0, ts: Date.now(), raw: "{}" });
}
db.prepare("INSERT INTO tasks(group_id,source_msg_id,kind,title,created_at,updated_at) VALUES ('hidden','hidden','mine','secret task',?,?)").run(Date.now(), Date.now());
const server = startMcpHttp(0, "test-mcp-token-long-enough-123456789");
server.on("listening", () => { const addr = server.address(); if (addr && typeof addr !== "string") process.send?.({ port: addr.port }); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
