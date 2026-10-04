import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("MCP sends only to its own connected account and validates text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-send-test-"));
  process.env.USER_DIR = dir;
  const { createMcpServer } = await import("../src/mcp.js");
  const { db } = await import("../src/db.js");
  const sent: string[] = [];
  let fail = false;
  const server = createMcpServer(async text => {
    if (fail) throw new Error("private connection detail");
    sent.push(text);
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tool = (await client.listTools()).tools.find(t => t.name === "zalo_send_to_self")!;
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties!), ["text"]);
    const call = (text: string) => client.callTool({ name: tool.name, arguments: { text } });
    const result = await call("  Tin thử tiếng Việt\nDòng hai  ");
    assert.notEqual(result.isError, true);
    assert.deepEqual(sent, ["Tin thử tiếng Việt\nDòng hai"]);
    assert.equal((await call("   ")).isError, true);
    assert.equal((await call("a".repeat(10001))).isError, true);
    assert.equal(sent.length, 1);
    fail = true;
    const failed = await call("Không tự gửi lại");
    assert.equal(failed.isError, true);
    assert.ok(!JSON.stringify(failed).includes("private connection detail"));
    assert.equal(sent.length, 1);
    const readOnly = createMcpServer();
    const reader = new Client({ name: "reader", version: "1" });
    const [c, d] = InMemoryTransport.createLinkedPair();
    try {
      await readOnly.connect(c);
      await reader.connect(d);
      assert.ok(!(await reader.listTools()).tools.some(t => t.name === tool.name));
    } finally { await reader.close(); await readOnly.close(); }
  } finally {
    await client.close();
    await server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
