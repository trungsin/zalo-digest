import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ quiet: true });

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

export const config = {
  dataDir,
  dbPath: path.join(dataDir, "zalo.db"),
  credentialsPath: path.join(dataDir, "credentials.json"),
  qrPath: path.join(dataDir, "qr.png"),

  // Group IDs to record. Get them with `npm run groups`.
  trackedGroupIds: new Set(list(process.env.TRACKED_GROUP_IDS)),

  timezone: process.env.TZ_REPORT ?? "Asia/Ho_Chi_Minh",
  reportCron: process.env.REPORT_CRON ?? "0 8 * * *",
  summaryModel: process.env.SUMMARY_MODEL ?? "claude-sonnet-5-5",

  // Optional: email alert when the Zalo session dies (we can't alert via Zalo then).
  smtpUrl: process.env.SMTP_URL,
  alertEmail: process.env.ALERT_EMAIL,
};
