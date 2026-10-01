// Export all figures to CSV (UTF-8 with BOM so Excel shows Vietnamese correctly).
// Usage: USER_DIR=users/<name> npm run export-metrics [-- out.csv]
import fs from "node:fs";
import { config } from "../config.js";
import { allMetrics, groupName } from "../db.js";

const out = process.argv[2] ?? `${config.dataDir}/metrics.csv`;
const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const header = ["nhóm", "ngày", "chỉ số", "người báo cáo", "giá trị", "đơn vị", "tin gốc"];
const rows = allMetrics().map((m) =>
  [groupName(m.group_id), m.period_date, m.metric, m.reporter, m.value, m.unit, m.source_text].map(cell).join(","),
);
fs.writeFileSync(out, "﻿" + [header.map(cell).join(","), ...rows].join("\r\n"));
console.log(`Đã xuất ${rows.length} dòng ra ${out}`);
