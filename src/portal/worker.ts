// One isolated process and SQLite database per portal account.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { login, sendToSelf } from "../zalo.js";
import { refreshGroupNames, startRecorder } from "../recorder.js";
import { startMcpHttp } from "../mcp.js";

const notify = (data: unknown) => process.send?.(data);
try {
  const api = await login();
  const ids = Object.keys((await api.getAllGroups()).gridVerMap);
  const groups: { id: string; name: string; members: number }[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const info = await api.getGroupInfo(ids.slice(i, i + 50));
    for (const [id, g] of Object.entries(info.gridInfoMap)) groups.push({ id, name: g.name, members: g.totalMember });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  let recording = false;
  async function select(selected: string[]) {
    if (!selected.length || selected.some(id => !ids.includes(id))) throw new Error("Invalid groups");
    config.trackedGroupIds.clear();
    selected.forEach(id => config.trackedGroupIds.add(id));
    await refreshGroupNames(api);
    fs.writeFileSync(path.join(process.env.USER_DIR!, ".env"),
      `TRACKED_GROUP_IDS=${selected.join(",")}\nMCP_TOKEN=${config.mcpToken}\n`, { mode: 0o600 });
    if (!recording) {
      startRecorder(api, () => process.exit(1));
      recording = true;
    }
    notify({ type: "selected", selected });
  }
  let selecting = false;
  process.on("message", async (m: { type?: string; selected?: string[] }) => {
    if (m.type === "select" && Array.isArray(m.selected)) {
      if (selecting) return;
      selecting = true;
      try { await select(m.selected); } catch { notify({ type: "error" }); }
      finally { selecting = false; }
    }
  });
  const server = startMcpHttp(0, config.mcpToken, text => sendToSelf(api, text));
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") notify({ type: "ready", groups, selected: [...config.trackedGroupIds], port: address.port });
  });
  const selected = [...config.trackedGroupIds].filter(id => ids.includes(id));
  config.trackedGroupIds.clear();
  selected.forEach(id => config.trackedGroupIds.add(id));
  if (selected.length) await select(selected);
} catch {
  notify({ type: "error" });
  process.exit(1);
}
