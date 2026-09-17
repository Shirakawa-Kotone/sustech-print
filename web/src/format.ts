// 展示层格式化。上游返回的时间格式很不统一，这里集中处理。

/** 金额：1234.5 -> "1,234.50" */
export function money(n: unknown): string {
  return Number(n || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** `YYYYMMDD` -> `YYYY-MM-DD`；其他格式原样返回。 */
export function fmtDate(d: unknown): string {
  const s = String(d ?? "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/** `HHMMSS` -> `HH:MM:SS` */
export function fmtTime(t: unknown): string {
  const s = String(t ?? 0).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/** Unix 秒 -> `YYYY-MM-DD HH:MM` */
export function fmtStamp(unixSeconds: unknown): string {
  const n = Number(unixSeconds);
  if (!n) return "—";
  const d = new Date(n * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtBytes(b: number): string {
  if (!b) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = b;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 相对时间，用于「刚刚 / 3 分钟前」。 */
export function fmtRelative(unixSeconds: unknown): string {
  const n = Number(unixSeconds);
  if (!n) return "—";
  const diff = Date.now() / 1000 - n;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return fmtStamp(n);
}

/** 使用记录的时间：优先用后端合好的 Unix 秒，其次退回旧字段。 */
export function fmtRowTime(row: {
  dwTimestamp?: number;
  dwTime?: number | string;
  dwDate?: string;
}): string {
  if (row?.dwTimestamp) return fmtStamp(row.dwTimestamp);
  // 旧接口：dwTime 直接是 Unix 秒
  const n = Number(row?.dwTime);
  if (n > 1e9) return fmtStamp(n);
  // 新接口：dwDate=YYYYMMDD + dwTime=HHMMSS
  const date = String(row?.dwDate ?? "");
  if (/^\d{8}$/.test(date)) {
    const t = String(row?.dwTime ?? "").padStart(6, "0");
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}`;
  }
  return "—";
}

/** `YYYYMMDD` 的今天，接口入参用。 */
export function todayStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}` +
    `${String(d.getMonth() + 1).padStart(2, "0")}` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

/** 减去 n 天后的 `YYYYMMDD`。 */
export function daysAgoStamp(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return todayStamp(d);
}

export function fmtFileSize(bytes: number): string {
  return fmtBytes(bytes);
}
