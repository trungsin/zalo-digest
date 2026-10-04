import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

export type PortalOptions = { origin?: string; invitation?: string; root?: string; workerPath?: string };

export function createPortal(options: PortalOptions = {}) {
  const origin = options.origin ?? process.env.PORTAL_ORIGIN ?? "http://localhost:3080";
  const publicOrigin = new URL(origin).origin;
  const secure = publicOrigin.startsWith("https:");
  const invitation = options.invitation ?? process.env.PORTAL_INVITE_CODE;
  if (!invitation || invitation.length < 16) throw new Error("PORTAL_INVITE_CODE must contain at least 16 characters");
  const root = path.resolve(options.root ?? process.env.PORTAL_DATA_DIR ?? "portal-data");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(root, "portal.db"));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE, salt TEXT, password TEXT, token TEXT UNIQUE);
  CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, account TEXT, expires INTEGER);`);
  if (!(db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).some(c => c.name === "zalo_uid")) {
    db.exec("ALTER TABLE accounts ADD COLUMN zalo_uid TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_zalo_uid ON accounts(zalo_uid) WHERE zalo_uid IS NOT NULL");
  type Account = { id: string; username: string; salt: string; password: string; token: string; zalo_uid?: string | null };
  type Worker = { child: ChildProcess; status: string; port?: number; groups: unknown[]; selected: string[]; zaloUid?: string; error?: string; timer?: NodeJS.Timeout };
  const workers = new Map<string, Worker>();
  let closing = false;
  const equal = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const accountDir = (a: Account) => path.join(root, "users", a.id);
  const starting = new Map<string, Promise<Worker>>();
  async function start(a: Account): Promise<Worker> {
    if (closing) throw new Error("Portal is shutting down");
    const pending = starting.get(a.id);
    if (pending) return pending;
    const existing = workers.get(a.id);
    if (existing && existing.status !== "error") return existing;
    const run = (async () => {
      if (existing && existing.child.exitCode === null && existing.child.signalCode === null) {
        existing.port = undefined;
        const exited = once(existing.child, "exit");
        const timer = setTimeout(() => existing.child.kill("SIGKILL"), 3000);
        existing.child.kill();
        try { await exited; } finally { clearTimeout(timer); }
      }
      return spawnWorker(a);
    })();
    starting.set(a.id, run);
    try { return await run; } finally { starting.delete(a.id); }
  }
  function spawnWorker(a: Account): Worker {
    if (closing) throw new Error("Portal is shutting down");
    const dir = accountDir(a);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, ".env"))) fs.writeFileSync(path.join(dir, ".env"), `MCP_TOKEN=${a.token}\n`, { mode: 0o600 });
    const child = fork(path.resolve(options.workerPath ?? "src/portal/worker.ts"), [], { execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, USER_DIR: dir, PORTAL_SCOPED: "1", PORTAL_MCP_TOKEN: a.token, PORTAL_USERNAME: a.username, PORTAL_ACCOUNT_ID: a.id, PORTAL_EXPECTED_ZALO_UID: a.zalo_uid ?? "", NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
      stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const state: Worker = { child, status: "qr", groups: [], selected: [] };
    workers.set(a.id, state);
    const fail = (error = state.error ?? "Phiên kết nối bị gián đoạn. Vui lòng kết nối lại.") => {
      if (workers.get(a.id) !== state) return;
      clearTimeout(state.timer);
      state.status = "error"; state.error = error; state.port = undefined;
      state.child.kill();
    };
    state.timer = setTimeout(() => fail("Mã QR đã hết thời gian. Vui lòng kết nối lại."), 10 * 60_000);
    child.on("message", (m: { type: string; reason?: string; uid?: string; port?: number; groups?: unknown[]; selected?: string[] }) => {
      if (workers.get(a.id) !== state || state.status === "error") return;
      if (m.type === "identity") {
        const uid = m.uid;
        if (!uid || !/^[1-9]\d*$/.test(uid)) return fail("Không xác minh được tài khoản Zalo.");
        const bound = db.prepare("SELECT zalo_uid FROM accounts WHERE id=?").get(a.id) as { zalo_uid: string | null };
        if (bound.zalo_uid && bound.zalo_uid !== uid) return fail("Tài khoản web này đã gắn với Zalo khác. Hãy đăng nhập đúng Zalo đã kết nối ban đầu.");
        const other = db.prepare("SELECT id FROM accounts WHERE zalo_uid=? AND id<>?").get(uid, a.id);
        if (other) return fail("Zalo này đã gắn với tài khoản web khác. Hãy dùng tài khoản web đã kết nối ban đầu.");
        db.prepare("UPDATE accounts SET zalo_uid=? WHERE id=?").run(uid, a.id);
        state.zaloUid = uid;
        child.send({ type: "identity-accepted" });
      }
      if (m.type === "ready") {
        if (!state.zaloUid || !m.port || m.port < 1 || m.port > 65535) return fail("Không xác minh được kết nối MCP.");
        clearTimeout(state.timer); state.status = "ready"; state.port = m.port; state.groups = m.groups ?? []; state.selected = m.selected ?? [];
      }
      if (m.type === "selected" && state.zaloUid && state.port) { state.selected = m.selected ?? []; state.status = "ready"; }
      if (m.type === "error") fail(m.reason === "identity-mismatch" ? "Tài khoản này đã gắn với Zalo khác. Hãy đăng nhập đúng Zalo đã kết nối ban đầu." : undefined);
    });
    child.on("exit", () => fail());
    child.on("error", () => fail());
    return state;
  }
  function account(req: http.IncomingMessage): Account | undefined {
    const sid = req.headers.cookie?.match(/(?:^|;\s*)zalo_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!sid) return;
    return db.prepare("SELECT a.* FROM accounts a JOIN sessions s ON s.account=a.id WHERE s.hash=? AND s.expires>?").get(hash(sid), Date.now()) as Account | undefined;
  }
  async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error("body too large"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  const attempts = new Map<string, { n: number; until: number }>();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    try {
      const url = new URL(req.url ?? "/", publicOrigin);
      const mcp = url.pathname.match(/^\/mcp\/([a-f0-9]{64})$/);
      if (mcp) {
        const a = db.prepare("SELECT * FROM accounts WHERE token=?").get(mcp[1]) as Account | undefined;
        if (!a) return send(401, { error: "Kết nối không hợp lệ" });
        const w = workers.get(a.id);
        if (!w?.port || w.status !== "ready" || !w.selected.length || !w.zaloUid || w.zaloUid !== a.zalo_uid) return send(503, { error: "Vui lòng đăng nhập Zalo và chọn nhóm trên website" });
        const upstream = http.request({ hostname: "127.0.0.1", port: w.port, path: "/mcp", method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${w.port}`, authorization: `Bearer ${a.token}` } }, response => {
            res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
          });
        upstream.on("error", () => { if (!res.headersSent) send(502, { error: "Kết nối tạm gián đoạn" }); else res.destroy(); });
        upstream.setTimeout(30_000, () => upstream.destroy());
        req.pipe(upstream); return;
      }
      if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.writeHead(200, { "content-type": file.endsWith("html") ? "text/html; charset=utf-8" : file.endsWith("js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
        fs.createReadStream(path.resolve("public/portal", file)).pipe(res); return;
      }
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "Không tìm thấy" });
      if (req.method === "POST" && req.headers.origin !== publicOrigin) return send(403, { error: "Nguồn truy cập không hợp lệ" });
      if (req.method === "POST" && ["/api/register", "/api/login"].includes(url.pathname)) {
        // Shared quota also limits requests when a reverse proxy hides client IPs.
        const key = req.socket.remoteAddress ?? "local"; const now = Date.now();
        for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
        const rate = attempts.get(key) ?? { n: 0, until: now + 60_000 }; attempts.set(key, rate);
        if (++rate.n > 20) return send(429, { error: "Thử lại sau một phút" });
        const b = await body(req);
        const username = String(b.username ?? "").trim().toLowerCase(); const password = String(b.password ?? "");
        if (!/^[a-z0-9_-]{3,40}$/.test(username) || password.length < 12 || password.length > 256) return send(400, { error: "Tên tài khoản 3–40 ký tự không dấu; mật khẩu tối thiểu 12 ký tự" });
        let a = db.prepare("SELECT * FROM accounts WHERE username=?").get(username) as Account | undefined;
        if (url.pathname === "/api/register") {
          if (!equal(String(b.invite ?? ""), invitation)) return send(403, { error: "Mã mời không hợp lệ" });
          if (b.consent !== true) return send(400, { error: "Cần đồng ý trước khi kết nối Zalo" });
          if (a) return send(409, { error: "Tên tài khoản đã được dùng" });
          if ((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n >= 20) return send(403, { error: "Đã đạt giới hạn người dùng" });
          const salt = randomBytes(16).toString("hex");
          a = { id: randomUUID(), username, salt, password: scryptSync(password, salt, 64).toString("hex"), token: randomBytes(32).toString("hex") };
          db.prepare("INSERT INTO accounts(id,username,salt,password,token) VALUES (?,?,?,?,?)").run(a.id, a.username, a.salt, a.password, a.token);
        } else {
          const computed = scryptSync(password, a?.salt ?? "dummy-salt", 64).toString("hex");
          if (!a || !equal(computed, a.password)) return send(401, { error: "Tên tài khoản hoặc mật khẩu không đúng" });
        }
        const sid = randomBytes(32).toString("hex");
        db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
        db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(hash(sid), a.id, Date.now() + 7 * 86400_000);
        res.setHeader("Set-Cookie", `zalo_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`);
        return send(200, { ok: true });
      }
      const a = account(req);
      if (!a) return send(401, { error: "Vui lòng đăng nhập" });
      if (req.method === "GET" && url.pathname === "/api/status") {
        const w = workers.get(a.id);
        return send(200, { username: a.username, zaloUid: a.zalo_uid ?? null, error: w?.error ?? null, status: w?.status ?? "idle", groups: w?.groups ?? [], selected: w?.selected ?? [],
          mcpUrl: w?.status === "ready" && w.selected.length ? `${publicOrigin}/mcp/${a.token}` : null });
      }
      if (req.method === "GET" && url.pathname === "/api/qr") {
        if (workers.get(a.id)?.status !== "qr") return send(404, { error: "QR chưa sẵn sàng" });
        const qr = path.join(accountDir(a), "data/qr.png");
        if (!fs.existsSync(qr)) return send(404, { error: "Đang tạo QR" });
        res.writeHead(200, { "content-type": "image/png" }).end(fs.readFileSync(qr)); return;
      }
      if (req.method === "POST" && url.pathname === "/api/connect") { await start(a); return send(200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/groups") {
        const b = await body(req); const w = workers.get(a.id);
        if (w?.status === "selecting") return send(409, { error: "Đang lưu nhóm, vui lòng chờ." });
        if (!w || w.status !== "ready" || !Array.isArray(b.selected) || !b.selected.length || b.selected.length > 200 || b.selected.some(id => typeof id !== "string" || !(w.groups as { id: string }[]).some(g => g.id === id))) return send(400, { error: "Vui lòng chọn nhóm hợp lệ" });
        w.status = "selecting"; w.child.send({ type: "select", selected: b.selected }); return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        const sid = req.headers.cookie?.match(/zalo_session=([a-f0-9]{64})/)?.[1];
        if (sid) db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(sid));
        res.setHeader("Set-Cookie", `zalo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
        return send(200, { ok: true });
      }
      return send(404, { error: "Không tìm thấy" });
    } catch { if (!res.headersSent) send(400, { error: "Yêu cầu không hợp lệ" }); }
  });
  for (const a of db.prepare("SELECT * FROM accounts").all() as Account[]) {
    if (fs.existsSync(path.join(accountDir(a), "data/credentials.json"))) void start(a);
  }
  return { server, close: async () => {
    closing = true;
    await Promise.allSettled([...starting.values()]);
    for (const w of workers.values()) w.child.kill();
    await Promise.allSettled([...workers.values()].map(w => w.child.exitCode === null && w.child.signalCode === null ? once(w.child, "exit") : Promise.resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portal = createPortal();
  portal.server.listen(Number(process.env.PORTAL_PORT ?? 3080), "127.0.0.1", () => console.log(`[portal] ${process.env.PORTAL_ORIGIN ?? "http://localhost:3080"}`));
  const shutdown = () => { void portal.close().then(() => process.exit(0)); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
