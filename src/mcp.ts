// MCP server over the local SQLite: lets the owner's Claude app read groups, messages, tasks and metrics.
// Summarizing/analysis happens in the client (on the owner's own Claude plan), not here.
// Sending uses the existing account's live session, when supplied by the host.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";
import {
  getTask, groupName, groupStats, knownMetrics, messagesInRange, metricsBetweenDates,
  tasksByStatus, updateTask, type Metric, type Task,
} from "./db.js";
import { dayTotal } from "./metrics.js";
import { dayKey, localIso, utcOffset } from "./time.js";

const MAX_SCAN = 50_000;
const DAY_MS = 24 * 3600e3;
const visibleGroups = () => groupStats().filter(g => !config.portalScoped || config.trackedGroupIds.has(g.id));

// ---------------------------------------------------------------- helpers

/** Lowercase and strip Vietnamese diacritics so "doanh so" matches "doanh số". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

/** Start of a local calendar day (YYYY-MM-DD) as a timestamp. */
function dayStart(date: string): number {
  const ts = Date.parse(`${date}T00:00:00${utcOffset(Date.parse(`${date}T12:00:00Z`))}`);
  if (Number.isNaN(ts)) throw new Error(`Ngày không hợp lệ: "${date}". Dùng dạng YYYY-MM-DD.`);
  return ts;
}

/** Resolve a group given by id or (part of) its name; null means all groups. */
function resolveGroups(group: string | undefined): string[] | null {
  if (!group) return config.portalScoped ? [...config.trackedGroupIds] : null;
  const groups = visibleGroups();
  const exact = groups.find((g) => g.id === group);
  if (exact) return [exact.id];
  const matches = groups.filter((g) => fold(g.name).includes(fold(group)));
  if (!matches.length) {
    throw new Error(`Không tìm thấy nhóm "${group}". Các nhóm đang theo dõi: ${groups.map((g) => g.name).join("; ")}`);
  }
  return matches.map((g) => g.id);
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}

function taskView(t: Task) {
  return {
    id: t.id,
    kind: t.kind === "mine" ? "việc của tôi" : "đang chờ người khác",
    title: t.title,
    assignee: t.assignee,
    due: t.due_at ? localIso(t.due_at) : null,
    due_text: t.due_text || null,
    overdue: t.status === "open" && t.due_at !== null && t.due_at < Date.now(),
    status: t.status,
    group: groupName(t.group_id),
    created: localIso(t.created_at),
  };
}

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dạng YYYY-MM-DD");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------- server

export type SelfSender = (text: string) => Promise<void>;
export type McpAccount = { username: string; zalo_uid: string };

export function createMcpServer(sendToSelf?: SelfSender, account?: McpAccount): McpServer {
  const server = new McpServer({ name: account ? `zalo-digest-${account.username}` : "zalo-digest", version: "0.4.0" });
  const response = (data: Record<string, unknown>) => json({ ...data, ...(account && { account }) });

  if (account) server.registerTool("zalo_get_account", {
    title: "Tài khoản Zalo của kết nối này",
    description: "Identify the Zalo account bound to this MCP connection. Call first when multiple Zalo connectors are available. Each connection reads, updates tasks and sends only for this account; never assume it belongs to another connector.",
    annotations: readOnly,
  }, async () => json(account));

  if (sendToSelf) server.registerTool(
    "zalo_send_to_self",
    {
      title: "Gửi vào Cloud của tôi",
      description: "Send text to the connected account's own Zalo Cloud (Cloud của tôi). Use only when the owner asks to send or save content there. A repeated call sends another copy. Long text may be split into several messages. If sending fails, some parts may already have been delivered; do not automatically retry.",
      inputSchema: { text: z.string().trim().min(1).max(10000).describe("Nội dung cần gửi vào Cloud của tôi, tối đa 10.000 ký tự.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ text }) => {
      try {
        await sendToSelf(text);
        return response({ sent: true, destination: "Cloud của tôi" });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const detail = typeof code === "number" ? ` (mã Zalo: ${code})` : "";
        return { isError: true, content: [{ type: "text" as const, text: `Gửi tin thất bại${detail}. Một phần nội dung có thể đã được gửi; hãy kiểm tra Cloud của tôi trước khi thử lại.` }] };
      }
    },
  );

  server.registerTool(
    "zalo_list_groups",
    {
      title: "Danh sách nhóm Zalo",
      description:
        "List the tracked Zalo groups with message counts, time range, and the metric names extracted from each. " +
        "Also returns today's date and timezone — call this first to resolve relative dates like 'hôm qua'.",
      annotations: readOnly,
    },
    async () => {
      const metrics = knownMetrics();
      return response({
        today: dayKey(Date.now()),
        now: localIso(Date.now()),
        timezone: config.timezone,
        owner_profile: config.userProfile || null,
        groups: visibleGroups().map((g) => ({
          id: g.id,
          name: g.name,
          message_count: g.message_count,
          first_message: g.first_ts ? localIso(g.first_ts) : null,
          last_message: g.last_ts ? localIso(g.last_ts) : null,
          metrics: metrics.filter((m) => m.group_id === g.id).map((m) => `${m.metric} (${m.unit})`),
        })),
      });
    },
  );

  server.registerTool(
    "zalo_get_messages",
    {
      title: "Đọc / tìm tin nhắn",
      description:
        "Read or search recorded group messages, oldest first. Use it to summarize a group, find what was decided, " +
        "or look up who said something. Search is case- and diacritic-insensitive ('bao gia' matches 'báo giá'). " +
        "Without dates it covers the last 24h, or all time when `query` is set. Page with offset when has_more is true.",
      inputSchema: {
        group: z.string().optional().describe("Group id or part of its name, e.g. 'sales hn'. Omit for all groups."),
        query: z.string().optional().describe("Text to search for in message content."),
        sender: z.string().optional().describe("Part of the sender's name."),
        from_date: dateParam.optional().describe("First day, inclusive (YYYY-MM-DD, local time)."),
        to_date: dateParam.optional().describe("Last day, inclusive (YYYY-MM-DD, local time)."),
        limit: z.number().int().min(1).max(500).default(200),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnly,
    },
    async ({ group, query, sender, from_date, to_date, limit, offset }) => {
      const now = Date.now();
      const toTs = to_date ? dayStart(to_date) + DAY_MS : now + 1;
      const fromTs = from_date ? dayStart(from_date) : query ? 0 : now - DAY_MS;

      let rows = messagesInRange(fromTs, toTs, resolveGroups(group), MAX_SCAN);
      if (query) rows = rows.filter((m) => fold(m.text).includes(fold(query)));
      if (sender) rows = rows.filter((m) => fold(m.sender_name).includes(fold(sender)));

      const page = rows.slice(offset, offset + limit);
      return response({
        total: rows.length,
        offset,
        has_more: offset + page.length < rows.length,
        messages: page.map((m) => ({
          time: localIso(m.ts),
          group: groupName(m.group_id),
          sender: m.is_self ? `${m.sender_name} (tôi)` : m.sender_name,
          mentions_me: Boolean(m.mentions_me),
          text: m.text,
        })),
      });
    },
  );

  server.registerTool(
    "zalo_list_tasks",
    {
      title: "Danh sách việc",
      description:
        "List tasks extracted from the groups: 'mine' = assigned to the owner, 'delegated' = the owner is waiting on someone. " +
        "Open tasks are sorted by deadline; each has an `overdue` flag.",
      inputSchema: {
        status: z.enum(["open", "done", "cancelled", "all"]).default("open"),
        kind: z.enum(["mine", "delegated", "all"]).default("all"),
        group: z.string().optional().describe("Group id or part of its name."),
      },
      annotations: readOnly,
    },
    async ({ status, kind, group }) => {
      const groupIds = resolveGroups(group);
      const tasks = tasksByStatus(status === "all" ? null : status)
        .filter((t) => kind === "all" || t.kind === kind)
        .filter((t) => !groupIds || groupIds.includes(t.group_id));
      return response({ count: tasks.length, tasks: tasks.map(taskView) });
    },
  );

  server.registerTool(
    "zalo_update_task",
    {
      title: "Cập nhật việc",
      description: "Mark a task done/cancelled/open, or change its deadline. Only changes the local task list, never sends anything to Zalo.",
      inputSchema: {
        task_id: z.number().int(),
        status: z.enum(["open", "done", "cancelled"]).optional(),
        due: z.string().optional().describe("New deadline as ISO 8601 with offset, e.g. '2026-10-03T17:00:00+07:00'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id, status, due }) => {
      const task = getTask(task_id);
      if (!task || (config.portalScoped && !config.trackedGroupIds.has(task.group_id))) throw new Error(`Không có việc #${task_id}. Dùng zalo_list_tasks với status "all" để xem id.`);
      const dueTs = due === undefined ? undefined : Date.parse(due);
      if (dueTs !== undefined && Number.isNaN(dueTs)) throw new Error(`Hạn không hợp lệ: "${due}". Dùng ISO 8601 có múi giờ.`);
      updateTask(task_id, {
        ...(status && { status }),
        ...(dueTs !== undefined && { due_at: dueTs, due_text: "" }),
      });
      return response(taskView(getTask(task_id)!));
    },
  );

  server.registerTool(
    "zalo_get_metrics",
    {
      title: "Số liệu báo cáo",
      description:
        "Figures reported in the groups (sales, orders, new customers...), one row per day/metric/reporter, plus daily totals. " +
        "Money is in 'triệu đồng'. A reporter named 'Tổng' is a team total the group reported itself; daily_totals already " +
        "prefer it over summing. Non-additive metrics (%, stock) have no totals. Defaults to the current month. " +
        "Values were extracted by an LLM from free text — quote `source` figures carefully.",
      inputSchema: {
        group: z.string().optional().describe("Group id or part of its name."),
        metric: z.string().optional().describe("Part of the metric name, e.g. 'doanh so'. See zalo_list_groups for names."),
        reporter: z.string().optional().describe("Part of the reporter's name."),
        from_date: dateParam.optional(),
        to_date: dateParam.optional(),
      },
      annotations: readOnly,
    },
    async ({ group, metric, reporter, from_date, to_date }) => {
      const today = dayKey(Date.now());
      const from = from_date ?? `${today.slice(0, 8)}01`;
      const to = to_date ?? today;
      const groupIds = resolveGroups(group);

      const rows = metricsBetweenDates(from, to)
        .filter((m) => !groupIds || groupIds.includes(m.group_id))
        .filter((m) => !metric || fold(m.metric).includes(fold(metric)))
        .filter((m) => !reporter || fold(m.reporter).includes(fold(reporter)));

      // Totals use every reporter of that day, even when filtering by reporter would hide some.
      const totals = new Map<string, { group: string; metric: string; unit: string; date: string; total: number }>();
      if (!reporter) {
        const byDay = new Map<string, Metric[]>();
        for (const m of rows) {
          const key = `${m.group_id}|${m.metric}|${m.period_date}`;
          byDay.set(key, [...(byDay.get(key) ?? []), m]);
        }
        for (const [key, dayRows] of byDay) {
          const total = dayTotal(dayRows);
          if (total === undefined) continue;
          const r = dayRows[0];
          totals.set(key, { group: groupName(r.group_id), metric: r.metric, unit: r.unit, date: r.period_date, total });
        }
      }

      return response({
        from,
        to,
        rows: rows.map((m) => ({
          date: m.period_date,
          group: groupName(m.group_id),
          metric: m.metric,
          reporter: m.reporter,
          value: m.value,
          unit: m.unit,
          additive: Boolean(m.additive),
        })),
        daily_totals: [...totals.values()],
      });
    },
  );

  return server;
}

// ---------------------------------------------------------------- HTTP transport

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stateless Streamable HTTP endpoint. Auth: `Authorization: Bearer <token>` (Claude Code, mcp-remote)
 * or the token as the last path segment, `/mcp/<token>` (claude.ai custom connectors, which can't set headers).
 */
export function startMcpHttp(port: number, token: string, sendToSelf?: SelfSender, account?: McpAccount): http.Server {
  if (token.length < 32) throw new Error("MCP_TOKEN must contain at least 32 characters");
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // An optional leading segment ("/an/mcp/...") lets one domain route to several people's ports;
    // Cloudflare Tunnel path rules forward the path unchanged.
    const match = url.pathname.match(/^(?:\/[^/]+)?\/mcp(?:\/([^/]+))?\/?$/);
    if (!match) {
      res.writeHead(404).end();
      return;
    }

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!tokenMatches(match[1] ?? bearer, token)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      const server = createMcpServer(sendToSelf, account);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  httpServer.listen(port, "127.0.0.1", () => console.log(`[mcp] listening on http://127.0.0.1:${port}/mcp`));
  return httpServer;
}
