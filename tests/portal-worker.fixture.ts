// Fake only the Zalo network; exercise real process config, database, MCP and Cloud routing.
import fs from "node:fs";
import path from "node:path";
import { type API } from "zca-js";
import { config } from "../src/config.js";
import { db, insertMessage, insertTask, upsertGroup } from "../src/db.js";
import { startMcpHttp } from "../src/mcp.js";
import { sendToSelf } from "../src/zalo.js";
import { confirmPortalIdentity } from "../src/portal/identity.js";

const identities: Record<string, string> = { alice: "1111", bob: "2222", carol: "3333", duplicate: "1111" };
const uidFile = path.join(config.userDir, "fixture-uid");
const uid = fs.existsSync(uidFile) ? fs.readFileSync(uidFile, "utf8").trim() : identities[config.userName]!;
await confirmPortalIdentity(uid);
fs.writeFileSync(path.join(config.userDir, "worker-pid"), String(process.pid));
for (const id of ["common", "hidden"]) {
  upsertGroup(id, id);
  insertMessage({ msg_id: id, group_id: id, sender_id: uid, sender_name: config.userName, text: `${config.userName}:${id}`, msg_type: "chat.text", ts: Date.now(), raw: "{}", mentions_me: 0, is_self: 0 });
  insertTask({ group_id: id, source_msg_id: id, kind: "mine", title: `${config.userName}:${id}`, assignee: config.userName, due_at: null, due_text: "" });
  db.prepare("INSERT OR IGNORE INTO metrics(group_id,period_date,metric,reporter,value,unit,source_msg_id,updated_at) VALUES (?,date('now'),'sales',?,?,'items',?,?)").run(id, config.userName, Number(uid), id, Date.now());
}
const api = {
  getOwnId: () => uid,
  getContext: () => ({ loginInfo: { send2me_id: `${uid}99` } }),
  sendMessage: async (text: string, recipient: string) => {
    fs.appendFileSync(path.join(config.dataDir, "sent.jsonl"), JSON.stringify({ text, recipient }) + "\n");
    return { message: { msgId: 1 }, attachment: [] };
  },
} as unknown as API;
const groups = ["common", "hidden"].map(id => ({ id, name: id, members: 3 }));
const server = startMcpHttp(0, config.mcpToken, text => sendToSelf(api, text), { username: config.userName, zalo_uid: uid });
server.on("listening", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ type: "ready", port: address.port, groups, selected: [...config.trackedGroupIds] });
});
process.on("message", (message: { type?: string; selected?: string[] }) => {
  if (message.type === "select" && message.selected) {
    config.trackedGroupIds.clear();
    message.selected.forEach(id => config.trackedGroupIds.add(id));
    process.send?.({ type: "selected", selected: message.selected });
  }
});
process.on("SIGTERM", () => {
  process.send?.({ type: "error" });
  // A late stale event must not revive a failed worker or corrupt its replacement.
  setTimeout(() => process.send?.({ type: "ready", port: 1, groups, selected: ["hidden"] }), 25);
  setTimeout(() => server.close(() => process.exit(0)), 75);
});
