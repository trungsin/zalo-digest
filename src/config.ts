import dotenv from "dotenv";
import path from "node:path";

// Each person has their own folder (users/<name>/) holding .env and data/.
// USER_DIR picks the folder; without it the repo root is used (single-user setup).
const userDir = path.resolve(process.env.USER_DIR ?? ".");
dotenv.config({ path: path.join(userDir, ".env"), override: true, quiet: true });

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type LlmProvider = "gemini" | "claude";

const provider = (process.env.LLM_PROVIDER ?? "gemini") as LlmProvider;
if (provider !== "gemini" && provider !== "claude") {
  throw new Error(`LLM_PROVIDER must be "gemini" or "claude", got "${provider}"`);
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gemini: "gemini-flash-latest",
  claude: "claude-haiku-4-5",
};

const dataDir = path.resolve(userDir, process.env.DATA_DIR ?? "data");

export const config = {
  userName: process.env.USER_NAME ?? path.basename(userDir),
  dataDir,
  dbPath: path.join(dataDir, "zalo.db"),
  credentialsPath: path.join(dataDir, "credentials.json"),
  qrPath: path.join(dataDir, "qr.png"),

  // Group IDs to record. Get them with `npm run groups`.
  trackedGroupIds: new Set(list(process.env.TRACKED_GROUP_IDS)),

  timezone: process.env.TZ_REPORT ?? "Asia/Ho_Chi_Minh",
  reportCron: process.env.REPORT_CRON ?? "0 8 * * *",

  llm: {
    provider,
    model: process.env.LLM_MODEL ?? DEFAULT_MODELS[provider],
    geminiApiKey: process.env.GEMINI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  },

  // Personalization: who the reader is and how long the report should be.
  userProfile: process.env.USER_PROFILE?.trim() ?? "",
  reportStyle: (process.env.REPORT_STYLE === "detailed" ? "detailed" : "short") as "short" | "detailed",

  // Group-specific shorthand for figures, e.g. "DS = doanh số; KH = khách hàng mới".
  metricHints: process.env.METRIC_HINTS?.trim() ?? "",

  // Task/metric extraction and reminders.
  // Every 2h in working hours by default: at most ~8 LLM calls/day, to stay within free-tier daily limits.
  extractCron: process.env.EXTRACT_CRON ?? "5 7-21/2 * * *",
  remindBeforeMin: Number(process.env.REMIND_BEFORE_MIN ?? 120),
  maxRemindersPerDay: Number(process.env.MAX_REMINDERS_PER_DAY ?? 5),
  // Hours [start, end) when no reminders are sent, e.g. "22-7".
  quietHours: (process.env.QUIET_HOURS ?? "22-7").split("-").map(Number) as [number, number],

  // MCP server (phase 4). Enabled when MCP_TOKEN is set; one port per person.
  mcpPort: Number(process.env.MCP_PORT ?? 3100),
  mcpToken: process.env.MCP_TOKEN?.trim() ?? "",

  // Optional: email alert when the Zalo session dies (we can't alert via Zalo then).
  smtpUrl: process.env.SMTP_URL,
  alertEmail: process.env.ALERT_EMAIL,
};
