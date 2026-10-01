import cron from "node-cron";
import { alertByEmail } from "./alert.js";
import { config } from "./config.js";
import { refreshGroupNames, startRecorder } from "./recorder.js";
import { buildReport } from "./report.js";
import { login, sendToSelf } from "./zalo.js";

if (!config.trackedGroupIds.size) {
  console.error("TRACKED_GROUP_IDS is empty. Run `npm run groups` to find group IDs, then set it in .env");
  process.exit(1);
}

const api = await login();
await refreshGroupNames(api);
console.log(`[main] Logged in as ${api.getOwnId()}, tracking ${config.trackedGroupIds.size} group(s)`);

startRecorder(api, async (reason) => {
  await alertByEmail("Mất kết nối Zalo", `${reason}\nProcess sẽ thoát để pm2 khởi động lại.`);
  // Let pm2 restart us; a fresh login re-establishes the listener (or asks for a new QR).
  process.exit(1);
});

cron.schedule(
  config.reportCron,
  async () => {
    try {
      const report = await buildReport();
      await sendToSelf(api, report.text);
      report.markReported();
      console.log("[report] sent");
    } catch (err) {
      console.error("[report] failed:", err);
      await alertByEmail("Gửi báo cáo thất bại", String(err));
    }
  },
  { timezone: config.timezone, noOverlap: true },
);
console.log(`[main] Report scheduled: "${config.reportCron}" (${config.timezone})`);
