import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createPortal } from "../src/portal/server.js";

test("three live MCP accounts isolate all tools, tokens, Cloud sends and reconnects", { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-multi-test-"));
  const portal = createPortal({ root, origin: "http://localhost", invitation: "multi-account-test-invite", workerPath: "tests/portal-worker.fixture.ts" });
  portal.server.listen(0, "127.0.0.1");
  await once(portal.server, "listening");
  const address = portal.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const db = new DatabaseSync(path.join(root, "portal.db"));
  type Account = { id: string; username: string; token: string; cookie: string };
  const request = (route: string, data?: unknown, cookie?: string) => fetch(base + route, {
    method: data === undefined ? "GET" : "POST", headers: { origin: "http://localhost", "content-type": "application/json", ...(cookie && { cookie }) },
    ...(data !== undefined && { body: JSON.stringify(data) }), signal: AbortSignal.timeout(3000),
  });
  async function register(username: string): Promise<Account> {
    const response = await request("/api/register", { username, password: "strong-password-1234", invite: "multi-account-test-invite", consent: true });
    assert.equal(response.status, 200);
    const account = db.prepare("SELECT id,username,token FROM accounts WHERE username=?").get(username) as Omit<Account, "cookie">;
    return { ...account, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  }
  async function status(a: Account) { return (await request("/api/status", undefined, a.cookie)).json(); }
  async function waitStatus(a: Account, target: string) {
    for (let i = 0; i < 100; i++) {
      const value = await status(a);
      if (value.status === target) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Account ${a.username} did not reach ${target}`);
  }
  async function tool(a: Account, name: string, args = {}, bearer?: string) {
    const response = await fetch(base + "/mcp/" + a.token, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer && { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  const value = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);
  try {
    const accounts = await Promise.all([register("alice"), register("bob"), register("carol")]);
    assert.equal(new Set(accounts.map(a => a.token)).size, 3);
    for (const a of accounts) {
      const dir = path.join(root, "users", a.id); fs.mkdirSync(dir, { recursive: true });
      // Config overrides must not redirect storage, disable scoping, or choose another account's token.
      fs.writeFileSync(path.join(dir, ".env"), `TRACKED_GROUP_IDS=common\nDATA_DIR=${root}/shared\nMCP_TOKEN=${accounts[0]!.token}\nPORTAL_MCP_TOKEN=${accounts[0]!.token}\nPORTAL_SCOPED=0\nUSER_DIR=${root}/shared\nUSER_NAME=wrong-owner\n`);
      assert.equal((await request("/api/connect", {}, a.cookie)).status, 200);
    }
    const states = await Promise.all(accounts.map(a => waitStatus(a, "ready")));
    assert.deepEqual(states.map(s => s.zaloUid), ["1111", "2222", "3333"]);
    assert.ok(!fs.existsSync(path.join(root, "shared")));
    for (const [i, a] of accounts.entries()) {
      const identity = value(await tool(a, "zalo_get_account", {}, accounts[(i + 1) % 3]!.token));
      assert.deepEqual(identity, { username: a.username, zalo_uid: states[i].zaloUid });
      assert.deepEqual(value(await tool(a, "zalo_list_groups")).groups.map((g: { id: string }) => g.id), ["common"]);
      const messages = value(await tool(a, "zalo_get_messages"));
      assert.deepEqual(messages.account, identity);
      assert.deepEqual(messages.messages.map((m: { text: string }) => m.text), [`${a.username}:common`]);
      assert.equal((await tool(a, "zalo_get_messages", { group: "hidden" })).isError, true);
      assert.deepEqual(value(await tool(a, "zalo_list_tasks")).tasks.map((t: { title: string }) => t.title), [`${a.username}:common`]);
      assert.equal((await tool(a, "zalo_update_task", { task_id: 2, status: "done" })).isError, true);
      assert.equal(value(await tool(a, "zalo_update_task", { task_id: 1, status: "done" })).status, "done");
      for (const other of accounts.slice(i + 1)) {
        const otherDb = new DatabaseSync(path.join(root, "users", other.id, "data/zalo.db"), { readOnly: true });
        assert.equal((otherDb.prepare("SELECT status FROM tasks WHERE id=1").get() as { status: string }).status, "open");
        otherDb.close();
      }
      const metrics = value(await tool(a, "zalo_get_metrics"));
      assert.deepEqual(metrics.rows.map((m: { reporter: string }) => m.reporter), [a.username]);
    }
    // Concurrent sends and extra account/recipient arguments cannot override the bound session.
    await Promise.all(accounts.map(async (a, i) => {
      const result = value(await tool(a, "zalo_send_to_self", { text: `save-${a.username}`, account: accounts[(i + 1) % 3]!.id, recipient: "999999" }));
      assert.equal(result.account.zalo_uid, states[i].zaloUid);
      const sent = fs.readFileSync(path.join(root, "users", a.id, "data/sent.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(sent, [{ text: `save-${a.username}`, recipient: `${states[i].zaloUid}99` }]);
    }));
    assert.equal((await request("/mcp/" + "0".repeat(64))).status, 401);
    assert.equal((await request("/api/groups", { selected: ["foreign"] }, accounts[0]!.cookie)).status, 400);
    assert.equal((await request("/api/groups", { selected: ["hidden"] }, accounts[0]!.cookie)).status, 200);
    await waitStatus(accounts[0]!, "ready");
    assert.deepEqual(value(await tool(accounts[0]!, "zalo_list_groups")).groups.map((g: { id: string }) => g.id), ["hidden"]);
    assert.deepEqual(value(await tool(accounts[1]!, "zalo_list_groups")).groups.map((g: { id: string }) => g.id), ["common"]);
    const duplicate = await register("duplicate");
    await request("/api/connect", {}, duplicate.cookie);
    assert.match((await waitStatus(duplicate, "error")).error, /tài khoản web khác/);
    assert.equal((await request("/mcp/" + duplicate.token)).status, 503);
    // Kill one account and reconnect with a different Zalo UID: old token must remain unavailable.
    const a = accounts[0]!;
    const dir = path.join(root, "users", a.id);
    const pid = Number(fs.readFileSync(path.join(dir, "worker-pid"), "utf8"));
    process.kill(pid, "SIGTERM");
    await waitStatus(a, "error");
    fs.writeFileSync(path.join(dir, "fixture-uid"), "4444");
    await Promise.all([request("/api/connect", {}, a.cookie), request("/api/connect", {}, a.cookie)]);
    assert.match((await waitStatus(a, "error")).error, /đã gắn với Zalo khác/);
    assert.equal((await request("/mcp/" + a.token)).status, 503);
    assert.deepEqual(value(await tool(accounts[1]!, "zalo_get_account")), { username: "bob", zalo_uid: "2222" });
    // Returning to the original identity restores only that account, despite late old-worker messages.
    fs.writeFileSync(path.join(dir, "fixture-uid"), "1111");
    await request("/api/connect", {}, a.cookie);
    await waitStatus(a, "ready");
    assert.deepEqual(value(await tool(a, "zalo_get_account")), { username: "alice", zalo_uid: "1111" });
    const bound = db.prepare("SELECT zalo_uid FROM accounts WHERE id=?").get(a.id) as { zalo_uid: string };
    assert.equal(bound.zalo_uid, "1111");
    const bobDb = new DatabaseSync(path.join(root, "users", accounts[1]!.id, "data/zalo.db"), { readOnly: true });
    assert.equal((bobDb.prepare("SELECT status FROM tasks WHERE id=2").get() as { status: string }).status, "open");
    bobDb.close();
  } finally {
    await portal.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
