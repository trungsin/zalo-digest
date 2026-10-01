// Deterministic metric rollups: the LLM only extracts numbers, all arithmetic happens here.
import { groupName, metricRows, metricsBetweenDates, metricsUpdatedSince, previousPeriodDate, type Metric } from "./db.js";
import { dayKey } from "./time.js";

const TOTAL = "tổng";
const num = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}/${m}`;
}

/** Total for one day: the reported team total if someone gave one, else the sum of individual figures. */
function dayTotal(rows: Metric[]): number | undefined {
  if (!rows.length || !rows[0].additive) return undefined;
  const reported = rows.find((r) => r.reporter.toLowerCase() === TOTAL);
  return reported ? reported.value : rows.reduce((sum, r) => sum + r.value, 0);
}

function percentChange(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `, ${pct >= 0 ? "+" : ""}${num.format(Math.round(pct))}%`;
}

function byGroupAndMetric(rows: Metric[]): Map<string, Map<string, Metric[]>> {
  const groups = new Map<string, Map<string, Metric[]>>();
  for (const r of rows) {
    const metrics = groups.get(r.group_id) ?? new Map<string, Metric[]>();
    metrics.set(r.metric, [...(metrics.get(r.metric) ?? []), r]);
    groups.set(r.group_id, metrics);
  }
  return groups;
}

/** "doanh số (triệu đồng) · 30/09: Lan 120 · Minh 80 → tổng 200 (29/09: 180, +11%) · lũy kế T09: 2.350" */
function metricLine(groupId: string, metric: string, date: string): string {
  const rows = metricRows(groupId, metric, date, date);
  const unit = rows[0]?.unit ? ` (${rows[0].unit})` : "";
  const people = rows.filter((r) => r.reporter.toLowerCase() !== TOTAL);
  const parts = [`${metric}${unit} · ${shortDate(date)}: ${people.map((r) => `${r.reporter} ${num.format(r.value)}`).join(" · ")}`];

  const total = dayTotal(rows);
  if (total !== undefined) {
    let totalText = `${people.length ? " → " : ""}tổng ${num.format(total)}`;
    const prevDate = previousPeriodDate(groupId, metric, date);
    const prevTotal = prevDate ? dayTotal(metricRows(groupId, metric, prevDate, prevDate)) : undefined;
    if (prevDate && prevTotal !== undefined) {
      totalText += ` (${shortDate(prevDate)}: ${num.format(prevTotal)}${percentChange(total, prevTotal)})`;
    }
    parts[0] += totalText;

    const monthStart = `${date.slice(0, 8)}01`;
    const monthRows = metricRows(groupId, metric, monthStart, date);
    const days = [...new Set(monthRows.map((r) => r.period_date))];
    if (days.length > 1) {
      const mtd = days.reduce((sum, d) => sum + (dayTotal(monthRows.filter((r) => r.period_date === d)) ?? 0), 0);
      parts.push(`lũy kế T${date.slice(5, 7)}: ${num.format(mtd)}`);
    }
  }
  return parts.join(" · ");
}

/** Figures that arrived since `sinceTs`, shown at their latest reported day, for the morning report. */
export function metricSection(sinceTs: number): string {
  const fresh = metricsUpdatedSince(sinceTs);
  if (!fresh.length) return "";

  const blocks = [...byGroupAndMetric(fresh).entries()].map(([groupId, metrics]) => {
    const lines = [...metrics.entries()].map(([metric, rows]) => {
      const latest = rows.map((r) => r.period_date).sort().at(-1)!;
      return `  ${metricLine(groupId, metric, latest)}`;
    });
    return [`== ${groupName(groupId)} ==`, ...lines].join("\n");
  });
  return ["SỐ LIỆU", ...blocks].join("\n");
}

/** Month-to-date rollup for the "solieu" command. */
export function monthToDateSection(now = Date.now()): string {
  const today = dayKey(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const rows = metricsBetweenDates(monthStart, today);
  if (!rows.length) return `Chưa có số liệu nào trong tháng ${today.slice(5, 7)}.`;

  const blocks = [...byGroupAndMetric(rows).entries()].map(([groupId, metrics]) => {
    const lines = [...metrics.entries()].map(([metric, mRows]) => {
      const unit = mRows[0].unit ? ` (${mRows[0].unit})` : "";
      const days = [...new Set(mRows.map((r) => r.period_date))].sort();

      if (!mRows[0].additive) {
        const latest = days.at(-1)!;
        const latestRows = mRows.filter((r) => r.period_date === latest);
        return `  ${metric}${unit} · mới nhất ${shortDate(latest)}: ${latestRows.map((r) => `${r.reporter} ${num.format(r.value)}`).join(" · ")}`;
      }

      const total = days.reduce((sum, d) => sum + (dayTotal(mRows.filter((r) => r.period_date === d)) ?? 0), 0);
      const perPerson = new Map<string, number>();
      for (const r of mRows) {
        if (r.reporter.toLowerCase() === TOTAL) continue;
        perPerson.set(r.reporter, (perPerson.get(r.reporter) ?? 0) + r.value);
      }
      const ranked = [...perPerson.entries()].sort((a, b) => b[1] - a[1]).map(([who, v]) => `${who} ${num.format(v)}`);
      return `  ${metric}${unit} · ${days.length} ngày: tổng ${num.format(total)}${ranked.length ? ` (${ranked.join(" · ")})` : ""}`;
    });
    return [`== ${groupName(groupId)} ==`, ...lines].join("\n");
  });
  return [`SỐ LIỆU LŨY KẾ THÁNG ${today.slice(5, 7)} (đến ${shortDate(today)})`, ...blocks].join("\n");
}
