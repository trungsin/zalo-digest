import fs from "node:fs";
import cron from "node-cron";
import { config } from "../config.js";

const errors: string[] = [];
if (!config.trackedGroupIds.size) errors.push("Chưa điền TRACKED_GROUP_IDS.");
const key = config.llm.provider === "gemini" ? config.llm.geminiApiKey : config.llm.anthropicApiKey;
if (!key?.trim()) errors.push(`Chưa điền API key cho ${config.llm.provider}.`);
if (!cron.validate(config.reportCron)) errors.push("REPORT_CRON không hợp lệ.");
if (!cron.validate(config.extractCron)) errors.push("EXTRACT_CRON không hợp lệ.");
try {
  new Intl.DateTimeFormat("en", { timeZone: config.timezone });
} catch {
  errors.push("TZ_REPORT không hợp lệ.");
}
if (config.mcpToken && config.mcpToken.length < 32) errors.push("MCP_TOKEN cần ít nhất 32 ký tự.");
if (config.mcpToken && (!Number.isInteger(config.mcpPort) || config.mcpPort < 1024 || config.mcpPort > 65535)) {
  errors.push("MCP_PORT cần là số nguyên từ 1024 đến 65535.");
}
if (!fs.existsSync(config.credentialsPath)) errors.push("Chưa đăng nhập Zalo: chạy npm run groups và quét QR trước.");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Cấu hình ${config.userName} hợp lệ; ${config.trackedGroupIds.size} nhóm. Chưa kiểm tra API key qua mạng.`);
