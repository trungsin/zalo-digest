import { config } from "./config.js";

const tz = config.timezone;

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ts);
}

export function formatDate(ts: number): string {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit" }).format(ts);
}

/** "17:00 Thứ 6 02/10" — compact form for task deadlines. */
export function formatDue(ts: number): string {
  const weekday = new Intl.DateTimeFormat("vi-VN", { timeZone: tz, weekday: "short" }).format(ts);
  const [day, month] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(ts).split("/");
  return `${formatTime(ts)} ${weekday} ${day}/${month}`;
}

/** Calendar day in the report timezone, e.g. "2026-10-01". */
export function dayKey(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ts);
}

export function localHour(ts: number): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(ts)) % 24;
}

/** UTC offset of the report timezone, e.g. "+07:00". */
export function utcOffset(ts: number): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(ts)
    .find((p) => p.type === "timeZoneName")?.value;
  return name?.replace("GMT", "") || "+00:00";
}

/** Local date-time with offset, e.g. "2026-10-01T08:15+07:00" — what the LLM sees as "now". */
export function localIso(ts: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(ts).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}${utcOffset(ts)}`;
}
