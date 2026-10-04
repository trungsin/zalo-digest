import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("a stale status response cannot display a previous account after switching or logging out", async () => {
  const elements = new Map<string, Record<string, unknown>>();
  const pending: ((value: unknown) => void)[] = [];
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: "", children: [], replaceChildren() {}, removeAttribute() {} });
    return elements.get(id)!;
  };
  const context = vm.createContext({
    document: { getElementById: element }, navigator: {}, setInterval() {},
    fetch: () => new Promise(resolve => pending.push(resolve)),
  });
  vm.runInContext(fs.readFileSync("public/portal/app.js", "utf8"), context);
  const response = (username: string) => ({ ok: true, status: 200, json: async () => ({ username, zaloUid: username, status: "ready", groups: [], selected: [], mcpUrl: `https://example.test/mcp/${username}` }) });
  assert.equal(pending.length, 1);
  vm.runInContext("showAuth(); refresh();", context);
  assert.equal(pending.length, 2, "new account refresh must not wait for the old request");
  pending[1]!(response("bob"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("mcpurl").value, "https://example.test/mcp/bob");
  pending[0]!(response("alice"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("mcpurl").value, "https://example.test/mcp/bob");
  vm.runInContext("refresh(); showAuth();", context);
  pending[2]!(response("bob"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("mcpurl").value, "");
  assert.equal(element("workspace").hidden, true);
});
