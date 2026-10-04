import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

test("portal authentication, session isolation, CSRF, and MCP access", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-portal-test-"));
  const origin = "http://localhost:13080";
  const child = spawn(process.execPath, ["--import", "tsx", "src/portal/server.ts"], { env: {
    ...process.env, PORTAL_PORT: "13080", PORTAL_ORIGIN: origin, PORTAL_DATA_DIR: dir,
    PORTAL_INVITE_CODE: "test-invitation-123456", NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
  }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Portal exited"); }), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("Startup timeout")), 10000); t.unref(); })]);
    const call = (route: string, data?: unknown, cookie?: string, source = origin) => fetch(origin + route, {
      method: data === undefined ? "GET" : "POST",
      headers: { Origin: source, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.equal((await call("/")).status, 200);
    assert.equal((await call("/api/status")).status, 401);
    assert.equal((await call("/api/qr")).status, 401);
    assert.equal((await call("/api/connect", {})).status, 401);
    assert.equal((await call("/api/register", {}, undefined, "https://evil.test")).status, 403);
    const credentials = { username: "alice", password: "correct-password-123", invite: "test-invitation-123456", consent: true };
    assert.equal((await call("/api/register", { ...credentials, invite: "wrong" })).status, 403);
    assert.equal((await call("/api/register", { ...credentials, consent: false })).status, 400);
    const r = await call("/api/register", credentials); assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    assert.match(r.headers.get("set-cookie")!, /HttpOnly/);
    assert.equal((await (await call("/api/status", undefined, cookie)).json()).username, "alice");
    const rb = await call("/api/register", { ...credentials, username: "bob" });
    const bob = rb.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await (await call("/api/status", undefined, bob)).json()).username, "bob");
    assert.equal((await call("/api/groups", { selected: ["foreign-group"] }, cookie)).status, 400);
    assert.equal((await call("/api/qr", undefined, bob)).status, 404);
    assert.equal((await call("/mcp/" + "0".repeat(64))).status, 401);
    const db = new DatabaseSync(path.join(dir, "portal.db"));
    const a = db.prepare("SELECT * FROM accounts WHERE username='alice'").get() as { token: string; password: string };
    assert.notEqual(a.password, credentials.password);
    assert.equal((await call("/mcp/" + a.token)).status, 503);
    db.close();
    assert.equal((await call("/api/login", { ...credentials, password: "wrong-password" })).status, 401);
    assert.equal((await call("/api/logout", {}, cookie)).status, 200);
    assert.equal((await call("/api/status", undefined, cookie)).status, 401);
    assert.equal((await call("/api/status", undefined, bob)).status, 200);
    assert.equal((await call("/api/login", credentials)).status, 200);
  } finally { child.kill("SIGTERM"); await once(child, "exit"); fs.rmSync(dir, { recursive: true, force: true }); }
});
