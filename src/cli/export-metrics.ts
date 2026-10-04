// Export all figures to CSV (UTF-8 with BOM so Excel shows Vietnamese correctly).
// Usage: USER_DIR=users/<name> npm run export-metrics [-- out.csv]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { allMetrics, groupName } from "../db.js";

export function escapeCsvCell(v: unknown): string {
  let text = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportMetrics(out = `${config.dataDir}/metrics.csv`): number {
  const header = ["nhóm", "ngày", "chỉ số", "người báo cáo", "giá trị", "đơn vị", "tin gốc"];
  const rows = allMetrics().map((m) =>
    [groupName(m.group_id), m.period_date, m.metric, m.reporter, m.value, m.unit, m.source_text]
      .map(escapeCsvCell)
      .join(","),
  );
  fs.writeFileSync(out, "﻿" + [header.map(escapeCsvCell).join(","), ...rows].join("\r\n"));
  return rows.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2] ?? `${config.dataDir}/metrics.csv`;
  const rows = exportMetrics(out);
  console.log(`Đã xuất ${rows} dòng ra ${out}`);
}
