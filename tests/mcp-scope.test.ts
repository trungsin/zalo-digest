import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";

test("portal MCP cannot read previously selected groups", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-scope-test-"));
  fs.writeFileSync(path.join(dir, ".env"), "TRACKED_GROUP_IDS=selected\n");
  const child = fork("tests/mcp-fixture.ts", [], { execArgv: ["--import", "tsx"], env: { ...process.env, USER_DIR: dir, PORTAL_SCOPED: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Fixture exited"); }), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("Startup timeout")), 10000); t.unref(); })]);
    async function tool(name: string, args = {}) {
      const r = await fetch(`http://localhost:${message.port}/mcp`, { method: "POST", headers: {
        authorization: "Bearer test-mcp-token-long-enough-123456789", "content-type": "application/json", accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      assert.equal(r.status, 200); return (await r.json()).result;
    }
    const groups = JSON.parse((await tool("zalo_list_groups")).content[0].text).groups;
    assert.deepEqual(groups.map((g: { id: string }) => g.id), ["selected"]);
    const messages = JSON.parse((await tool("zalo_get_messages")).content[0].text).messages;
    assert.deepEqual(messages.map((m: { text: string }) => m.text), ["selected"]);
    assert.equal((await tool("zalo_get_messages", { group: "hidden" })).isError, true);
    assert.equal(JSON.parse((await tool("zalo_list_tasks")).content[0].text).count, 0);
    assert.equal((await tool("zalo_update_task", { task_id: 1, status: "done" })).isError, true);
  } finally { child.kill(); await once(child, "exit"); fs.rmSync(dir, { recursive: true, force: true }); }
});
