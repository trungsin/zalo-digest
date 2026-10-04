import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createPortal, type PortalOptions } from "../src/portal/server.js";

class TestWorker extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  sent: unknown[] = [];
  send(message: unknown) { this.sent.push(message); return true; }
  kill(signal = "SIGTERM") {
    if (this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function setup(t: TestContext, options: PortalOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-hardening-test-"));
  const workers: TestWorker[] = [];
  const workerPaths: string[] = [];
  t.mock.method(childProcess, "fork", (file: string) => {
    const child = new TestWorker(); workers.push(child); workerPaths.push(file); return child;
  });
  syncBuiltinESMExports();
  const existsSync = fs.existsSync;
  t.mock.method(fs, "existsSync", (file: fs.PathLike) => String(file).endsWith(".env") || existsSync(file));
  const mkdirSync = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (dir: fs.PathLike, options: fs.MakeDirectoryOptions) => {
    if (!String(dir).startsWith(path.join(root, "users") + path.sep)) return mkdirSync(dir, options);
  });
  const origin = "http://localhost";
  const invitation = "hardening-test-invitation";
  const portal = createPortal({ root, origin, invitation, selectionTimeoutMs: 30, ...options });
  t.after(async () => {
    await portal.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function request(route: string, data?: unknown, headers: http.IncomingHttpHeaders = {}, remoteAddress = "127.0.0.1") {
    // Exercise the real HTTP handler and response without listening on a network port.
    const socket = new net.Socket();
    Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
    let output = "";
    socket._write = (chunk, _encoding, callback) => { output += chunk.toString(); callback(); };
    socket._writev = (chunks, callback) => { for (const { chunk } of chunks) output += chunk.toString(); callback(); };
    const req = new http.IncomingMessage(socket);
    req.method = data === undefined ? "GET" : "POST";
    req.url = route; req.headers = { origin, ...headers };
    if (data !== undefined) req.push(JSON.stringify(data));
    req.push(null); req.complete = true;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    const done = new Promise<void>(resolve => { res.once("finish", resolve); socket.once("close", resolve); });
    portal.server.emit("request", req, res);
    await done;
    socket.destroy();
    const body = output.slice(output.indexOf("\r\n\r\n") + 4);
    return { status: res.statusCode, body, json: () => JSON.parse(body), headers: res.getHeaders(), destroyed: res.destroyed };
  }
  async function connect() {
    const response = await request("/api/register", { username: "alice", password: "strong-password-1234", invite: invitation, consent: true });
    assert.equal(response.status, 200);
    const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    assert.equal((await request("/api/connect", {}, { cookie })).status, 200);
    const worker = workers.at(-1)!;
    worker.emit("message", { type: "identity", uid: "1111" });
    worker.emit("message", { type: "ready", port: 3101, groups: [{ id: "group" }], selected: ["group"] });
    return { worker, cookie };
  }
  return { root, request, connect, workers, workerPaths };
}

for (const remoteAddress of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
  test(`loopback ${remoteAddress} uses the first trimmed Cloudflare IP for the shared auth quota`, async t => {
    const { request } = setup(t);
    const first = { "cf-connecting-ip": " 203.0.113.1 , 203.0.113.9" };
    for (let i = 0; i < 20; i++) assert.equal((await request(i % 2 ? "/api/register" : "/api/login", {}, first, remoteAddress)).status, 400);
    assert.equal((await request("/api/login", {}, { "cf-connecting-ip": ["203.0.113.1", "203.0.113.2"] }, remoteAddress)).status, 429);
    assert.equal((await request("/api/register", {}, { "cf-connecting-ip": "203.0.113.2" }, remoteAddress)).status, 400);
    assert.equal((await request("/api/login", {}, { "cf-connecting-ip": "2001:db8::1" }, remoteAddress)).status, 400);
  });
}

test("invalid or missing Cloudflare IPs fall back to the loopback socket quota", async t => {
  const { request } = setup(t);
  for (let i = 0; i < 20; i++) assert.equal((await request("/api/login", {})).status, 400);
  for (const ip of ["", "unknown", "999.1.1.1", "203.0.113.1:443", "bad, 203.0.113.2"]) {
    assert.equal((await request("/api/register", {}, { "cf-connecting-ip": ip })).status, 429);
  }
});

test("non-loopback peers cannot bypass the auth quota with Cloudflare headers", async t => {
  const { request } = setup(t);
  for (let i = 0; i < 20; i++) assert.equal((await request("/api/login", {}, { "cf-connecting-ip": `203.0.113.${i + 1}` }, "192.0.2.1")).status, 400);
  assert.equal((await request("/api/register", {}, { "cf-connecting-ip": "2001:db8::1" }, "192.0.2.1")).status, 429);
  assert.equal((await request("/api/login", {}, {}, "192.0.2.2")).status, 400);
});

test("the default global auth quota caps all client keys at 200 attempts per minute", async t => {
  t.mock.method(Date, "now", () => 100_000);
  const { request } = setup(t);
  for (let i = 1; i <= 200; i++) {
    const response = i % 2
      ? await request("/api/login", {}, { "cf-connecting-ip": `203.0.113.${i}` })
      : await request("/api/register", {}, {}, `192.0.2.${i}`);
    assert.equal(response.status, 400);
  }
  assert.equal((await request("/api/register", {}, { "cf-connecting-ip": "2001:db8::1" })).status, 429);
  assert.equal((await request("/api/login", {}, {}, "198.51.100.1")).status, 429);
});

test("one client over its own quota cannot exhaust the global auth quota for others", async t => {
  t.mock.method(Date, "now", () => 100_000);
  const { request } = setup(t, { authGlobalLimit: 25 });
  for (let i = 0; i < 20; i++) assert.equal((await request("/api/login", {}, {}, "192.0.2.1")).status, 400);
  for (let i = 0; i < 50; i++) assert.equal((await request("/api/login", {}, {}, "192.0.2.1")).status, 429);
  assert.equal((await request("/api/login", {}, {}, "192.0.2.2")).status, 400);
});

test("the configured global auth quota resets after one minute", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const { request } = setup(t, { authGlobalLimit: 3 });
  for (let i = 1; i <= 3; i++) assert.equal((await request("/api/login", {}, {}, `192.0.2.${i}`)).status, 400);
  now += 59_999;
  assert.equal((await request("/api/register", {}, {}, "192.0.2.4")).status, 429);
  now++;
  assert.equal((await request("/api/register", {}, {}, "192.0.2.4")).status, 400);
});

for (const viaProxy of [false, true]) {
  test(`IPv6 addresses in one /64 share the auth quota ${viaProxy ? "behind loopback" : "on direct connections"}`, async t => {
    const { request } = setup(t);
    const attempt = (ip: string) => viaProxy
      ? request("/api/login", {}, { "cf-connecting-ip": ip })
      : request("/api/register", {}, {}, ip);
    for (let i = 1; i <= 20; i++) assert.equal((await attempt(`2001:db8:abcd:1234::${i.toString(16)}`)).status, 400);
    assert.equal((await attempt("2001:0DB8:ABCD:1234:0000:0000:0000:00FF")).status, 429);
    assert.equal((await attempt("2001:db8:abcd:1234::192.0.2.1")).status, 429);
    assert.equal((await attempt("2001:db8:abcd:1235::1")).status, 400);
    for (let i = 1; i <= 20; i++) assert.equal((await attempt(`2001:db8::${i.toString(16)}`)).status, 400);
    assert.equal((await attempt("2001:db8:0:0:1::1")).status, 429, "compression inside the /64 prefix cannot create another key");
    assert.equal((await attempt("2001:db8:0:1::1")).status, 400);
  });
}

test("IPv4-mapped addresses share their IPv4 quota and keep separate IPv4 clients independent", async t => {
  const { request } = setup(t);
  const forms = ["192.0.2.1", "::ffff:192.0.2.1", "::ffff:c000:201"];
  for (let i = 0; i < 20; i++) assert.equal((await request("/api/login", {}, {}, forms[i % forms.length]!)).status, 400);
  for (const ip of forms) assert.equal((await request("/api/register", {}, {}, ip)).status, 429);
  assert.equal((await request("/api/login", {}, {}, "::ffff:192.0.2.2")).status, 400);
});

test("the auth key map refuses new keys at capacity while preserving existing quotas", async t => {
  const { request } = setup(t, { authMaxKeys: 2 });
  for (const ip of ["192.0.2.1", "192.0.2.2"]) assert.equal((await request("/api/login", {}, {}, ip)).status, 400);
  assert.equal((await request("/api/register", {}, {}, "192.0.2.3")).status, 429);
  for (let i = 1; i < 20; i++) assert.equal((await request("/api/login", {}, {}, "192.0.2.1")).status, 400);
  assert.equal((await request("/api/login", {}, {}, "192.0.2.1")).status, 429);
});

test("auth key cleanup runs at most once per minute and reclaims expired capacity", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const { request } = setup(t, { authMaxKeys: 2 });
  assert.equal((await request("/api/login", {}, {}, "192.0.2.1")).status, 400);
  now += 30_000;
  assert.equal((await request("/api/login", {}, {}, "192.0.2.2")).status, 400);
  now += 30_000;
  assert.equal((await request("/api/login", {}, {}, "192.0.2.3")).status, 400);
  now += 30_000;
  assert.equal((await request("/api/login", {}, {}, "192.0.2.4")).status, 429, "expired keys wait for the next periodic sweep");
  assert.equal((await request("/api/login", {}, {}, "192.0.2.3")).status, 400);
  now += 30_000;
  assert.equal((await request("/api/login", {}, {}, "192.0.2.4")).status, 400);
});

test("static assets resolve from the module when the working directory differs", async t => {
  const { request, root } = setup(t);
  t.mock.method(process, "cwd", () => root);
  const files: string[] = [];
  t.mock.method(fs, "createReadStream", (file: string) => {
    files.push(file); const stream = new PassThrough(); stream.end("asset"); return stream;
  });
  for (const [route, file] of [["/", "index.html"], ["/app.js", "app.js"], ["/style.css", "style.css"]]) {
    const response = await request(route!);
    assert.equal(response.status, 200); assert.equal(response.body, "asset");
    assert.equal(files.at(-1), fileURLToPath(new URL(`../public/portal/${file}`, import.meta.url)));
  }
});

test("the default worker path resolves from the server module independently of cwd", async t => {
  const { connect, root, workerPaths } = setup(t);
  t.mock.method(process, "cwd", () => root);
  await connect();
  assert.equal(workerPaths[0], fileURLToPath(new URL("../src/portal/worker.ts", import.meta.url)));
});

for (const [code, status] of [["ENOENT", 404], ["EACCES", 500]] as const) {
  test(`static stream ${code} returns ${status} without an unhandled error`, async t => {
    const { request } = setup(t);
    const stream = new PassThrough();
    t.mock.method(fs, "createReadStream", () => stream);
    const response = request("/app.js");
    assert.ok(stream.listenerCount("error") > 0, "static stream must handle asynchronous errors");
    stream.destroy(Object.assign(new Error("Static stream failed"), { code }));
    const result = await response;
    assert.equal(result.status, status);
    assert.equal(result.headers["content-type"], "application/json");
    assert.ok(result.json().error);
    assert.equal((await request("/api/status")).status, 401, "portal still handles requests after the stream error");
  });
}

test("a static stream error after sending headers destroys the response", async t => {
  const { request } = setup(t);
  const stream = new PassThrough();
  t.mock.method(fs, "createReadStream", () => stream);
  const response = request("/style.css");
  assert.ok(stream.listenerCount("error") > 0, "static stream must handle asynchronous errors");
  stream.write("partial asset");
  stream.destroy(Object.assign(new Error("Read failed"), { code: "EIO" }));
  assert.equal((await response).destroyed, true);
  assert.equal((await request("/api/status")).status, 401);
});

test("a stalled group selection fails the worker, revokes MCP and allows reconnect", async t => {
  const { request, connect, workers } = setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { worker, cookie } = await connect();
  const status = async () => (await request("/api/status", undefined, { cookie })).json();
  const mcpUrl = (await status()).mcpUrl;
  assert.equal((await request("/api/groups", { selected: ["group"] }, { cookie })).status, 200);
  assert.equal((await status()).status, "selecting");
  assert.equal((await request("/api/groups", { selected: ["group"] }, { cookie })).status, 409);
  t.mock.timers.tick(31);
  const failed = await status();
  assert.equal(failed.status, "error"); assert.ok(failed.error); assert.equal(failed.mcpUrl, null);
  assert.equal(worker.signalCode, "SIGTERM");
  assert.equal((await request(new URL(mcpUrl).pathname)).status, 503);
  worker.emit("message", { type: "selected", selected: ["group"] });
  assert.equal((await status()).status, "error", "late acknowledgements cannot revive a failed worker");
  assert.equal((await request("/api/connect", {}, { cookie })).status, 200);
  assert.equal(workers.length, 2); assert.equal((await status()).status, "qr");
});

test("the default group selection timeout allows 90 seconds for Zalo requests", async t => {
  const { request, connect } = setup(t, { selectionTimeoutMs: undefined });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { worker, cookie } = await connect();
  assert.equal((await request("/api/groups", { selected: ["group"] }, { cookie })).status, 200);
  t.mock.timers.tick(30_001);
  assert.equal((await request("/api/status", undefined, { cookie })).json().status, "selecting");
  t.mock.timers.tick(59_998);
  assert.equal((await request("/api/status", undefined, { cookie })).json().status, "selecting");
  t.mock.timers.tick(1);
  assert.equal((await request("/api/status", undefined, { cookie })).json().status, "error");
  assert.equal(worker.signalCode, "SIGTERM");
});

test("a group selection acknowledgement cancels its timeout before the next selection", async t => {
  const { request, connect } = setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { worker, cookie } = await connect();
  await request("/api/groups", { selected: ["group"] }, { cookie });
  t.mock.timers.tick(20);
  worker.emit("message", { type: "selected", selected: ["group"] });
  assert.equal((await request("/api/status", undefined, { cookie })).json().status, "ready");
  await request("/api/groups", { selected: ["group"] }, { cookie });
  t.mock.timers.tick(11);
  assert.equal((await request("/api/status", undefined, { cookie })).json().status, "selecting");
  worker.emit("message", { type: "selected", selected: ["group"] });
  t.mock.timers.tick(60);
  assert.equal((await request("/api/status", undefined, { cookie })).json().status, "ready");
  assert.equal(worker.signalCode, null);
});
