// 应用状态。
//
// 不用 Pinia：这个应用只有一个根状态，reactive + 一组动作就够了，
// 少一个依赖也少一层心智负担。

import { computed, reactive } from "vue";

import * as api from "./api";
import { daysAgoStamp, todayStamp } from "./format";
import type {
  HistoryRow,
  Paper,
  PrintJob,
  Printer,
  ScanJob,
  SessionResponse,
  Summary,
} from "./types";

export type ViewKey =
  | "overview"
  | "documents"
  | "upload"
  | "printers"
  | "history"
  | "settings";

export type ThemeMode = "auto" | "light" | "dark";

const THEME_KEY = "sustech-print.theme";

interface State {
  booting: boolean;
  session: SessionResponse | null;
  view: ViewKey;
  themeMode: ThemeMode;

  summary: Summary | null;
  jobs: PrintJob[] | null;
  scans: ScanJob[] | null;
  printers: Printer[];
  papers: Paper[];
  history: HistoryRow[];

  historyDays: number;
  historyType: "all" | "1" | "2" | "3";
  search: string;

  selectedJobs: number[];
  selectedScans: number[];

  loading: {
    summary: boolean;
    documents: boolean;
    printers: boolean;
    history: boolean;
    papers: boolean;
  };
}

function readTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "auto" ? v : "auto";
}

export const state = reactive<State>({
  booting: true,
  session: null,
  view: "overview",
  themeMode: readTheme(),

  summary: null,
  jobs: null,
  scans: null,
  printers: [],
  papers: [],
  history: [],

  historyDays: 365,
  historyType: "all",
  search: "",

  selectedJobs: [],
  selectedScans: [],

  loading: {
    summary: false,
    documents: false,
    printers: false,
    history: false,
    papers: false,
  },
});

export const isLoggedIn = computed(() => Boolean(state.session?.loggedIn));

/* ------------------------------------------------------------------ 主题 --- */

export function setThemeMode(mode: ThemeMode) {
  state.themeMode = mode;
  localStorage.setItem(THEME_KEY, mode);
}

/* ------------------------------------------------------------------ 会话 --- */

export async function bootstrap() {
  state.booting = true;
  try {
    state.session = await api.getSession();
    if (state.session.loggedIn) {
      await Promise.allSettled([loadSummary(), loadPapers(), loadPrinters()]);
    }
  } catch {
    state.session = { loggedIn: false };
  } finally {
    state.booting = false;
  }
}

export async function login(username: string, password: string) {
  await api.login(username, password);
  state.session = await api.getSession();
  await Promise.allSettled([loadSummary(true), loadPapers(), loadPrinters()]);
}

export async function logout() {
  await api.logout();
  state.session = { loggedIn: false };
  state.summary = null;
  state.jobs = null;
  state.scans = null;
  state.printers = [];
  state.history = [];
  state.selectedJobs = [];
  state.selectedScans = [];
  state.view = "overview";
}

/* ------------------------------------------------------------------ 概览 --- */

export async function loadSummary(fresh = false) {
  state.loading.summary = true;
  try {
    state.summary = await api.getSummary(fresh);
  } finally {
    state.loading.summary = false;
  }
}

/* ------------------------------------------------------------------ 文档 --- */

export async function loadDocuments() {
  state.loading.documents = true;
  try {
    const [jobs, scans] = await Promise.all([
      api.getJobs().catch(() => ({ jobs: [] as PrintJob[] })),
      api.getScans().catch(() => ({ scans: [] as ScanJob[] })),
    ]);
    state.jobs = jobs.jobs;
    state.scans = scans.scans;
    // 丢掉已经不存在的选中项，否则删除按钮会一直亮着
    const jobIds = new Set(state.jobs.map((j) => j.dwJobId));
    const scanIds = new Set(state.scans.map((s) => s.dwJobId));
    state.selectedJobs = state.selectedJobs.filter((id) => jobIds.has(id));
    state.selectedScans = state.selectedScans.filter((id) => scanIds.has(id));
  } finally {
    state.loading.documents = false;
  }
}

export async function removeJobs(ids: number[]) {
  const res = await api.deleteJobs(ids);
  state.selectedJobs = [];
  await Promise.allSettled([loadDocuments(), loadSummary(true)]);
  return res;
}

export async function removeScans(ids: number[]) {
  const res = await api.deleteScans(ids);
  state.selectedScans = [];
  await Promise.allSettled([loadDocuments(), loadSummary(true)]);
  return res;
}

/* ---------------------------------------------------------------- 打印点 --- */

export async function loadPrinters() {
  state.loading.printers = true;
  try {
    const res = await api.getPrinters();
    state.printers = res.printers || [];
  } finally {
    state.loading.printers = false;
  }
}

/* ------------------------------------------------------------------ 纸型 --- */

export async function loadPapers() {
  state.loading.papers = true;
  try {
    const res = await api.getPapers();
    state.papers = res.papers || [];
  } catch {
    state.papers = [];
  } finally {
    state.loading.papers = false;
  }
}

/* ------------------------------------------------------------------ 记录 --- */

export async function loadHistory(days = state.historyDays) {
  state.historyDays = days;
  state.loading.history = true;
  try {
    const end = todayStamp();
    const begin = daysAgoStamp(days);
    // 一次拉全部：上游已经不认 dwType 过滤参数了（按类型分三次请求会把
    // 同一批记录拿回来三遍，补贴算成三倍）。类型筛选改在前端做。
    const res = await api.getHistory(begin, end, [1, 2, 3]);
    state.history = res.rows || [];
  } finally {
    state.loading.history = false;
  }
}

/* ------------------------------------------------------------------ 辅助 --- */

/** 纸型 ID -> 名字。接口没返回时用已知的兜底，避免界面出现「纸型undefined」。 */
export function paperName(id: unknown): string {
  const n = Number(id);
  const found = state.papers.find((p) => p.dwPaperID === n);
  if (found) return found.szPaperName;
  const fallback: Record<number, string> = { 8: "A3", 9: "A4", 123: "A0", 124: "A1" };
  return fallback[n] || `纸型 ${n}`;
}

export function printerName(id: unknown): string {
  const found = state.printers.find((p) => p.id === Number(id));
  return found ? found.name : `#${id}`;
}

/** 把 `szAttribe` + `szPaperDetail` 拼成一行人类可读的规格说明。 */
export function jobSpec(job: PrintJob): string {
  const parts: string[] = [];
  try {
    const detail = JSON.parse(String(job.szPaperDetail || "[]")) as { dwPaperID?: number }[];
    for (const d of detail) {
      if (d?.dwPaperID != null) parts.push(paperName(d.dwPaperID));
    }
  } catch {
    /* szPaperDetail 偶尔不是合法 JSON，忽略即可 */
  }
  // szAttribe 是逗号分隔的标签。**实测出来的词表**（2026-09-21，真账号上传后
  // 从云端队列读回，见 driver/macos/REPORT.md 的 v3 追加报告）：
  //
  //     "single,"       单面 · 黑白
  //     "vdup,"         双面短边 · 黑白
  //     "hdup,color,"   双面长边 · 彩色
  //
  // 两个坑：
  //   1. **黑白没有 token** —— 只有彩色才带 `color`。所以"没有 color"只有在
  //      确实有其它标签时才等于黑白；属性串整个为空时什么都别断言。
  //   2. 双面是 `hdup`/`vdup`（h=长边、v=短边，与上传时 dwDuplex 3/2 一一对应），
  //      **不是** `double` —— 按 `includes("double")` 判永远不命中。
  //
  // 另外，旧写法 `attr.includes("color")` 会把 `nocolor`（当年凭空猜的黑白标签）
  // 也算成彩色 —— 界面上每一份黑白作业都显示"彩色"，与打出来的结果相反。
  const attr = String(job.szAttribe || "")
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (attr.includes("single")) parts.push("单面");
  else if (attr.includes("hdup")) parts.push("双面 · 长边");
  else if (attr.includes("vdup")) parts.push("双面 · 短边");
  else if (attr.includes("double")) parts.push("双面");
  if (attr.length) parts.push(attr.includes("color") ? "彩色" : "黑白");
  return parts.join(" · ") || "—";
}

/**
 * 打印队列里的作业到底几页。
 *
 * 注意：`PrintJob/Get` **不返回 `dwPages`** —— 页数藏在 `szPaperDetail` 里，形如
 *   [{"dwPaperID":9,"dwBWPages":1,"dwColorPages":0,"dwPaperNum":1}]
 * 所以以前那一列读 `dwPages ?? 0` 永远是 0，看起来就像"页数不对"。
 * 与系统一致的口径是「黑白页 + 彩色页」（`dwPaperNum` 是纸张张数，双面时与页数不等）。
 * 实在拿不到就返回 null，让界面显示「—」而不是一个假的 0。
 */
export function jobPages(job: PrintJob): number | null {
  const fallback = Number(job.dwPages);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  try {
    const detail = JSON.parse(String(job.szPaperDetail || "[]")) as {
      dwBWPages?: number;
      dwColorPages?: number;
    }[];
    let total = 0;
    let seen = false;
    for (const d of detail) {
      const bw = Number(d?.dwBWPages);
      const color = Number(d?.dwColorPages);
      if (Number.isFinite(bw)) {
        total += bw;
        seen = true;
      }
      if (Number.isFinite(color)) {
        total += color;
        seen = true;
      }
    }
    return seen ? total : null;
  } catch {
    /* szPaperDetail 偶尔不是合法 JSON */
    return null;
  }
}

/** 打印点状态在中文和英文之间混着，判断空闲要同时匹配。 */
export function printerStatusKind(status: string): "ok" | "warn" | "danger" | "muted" {
  const s = String(status || "");
  if (!s) return "muted";
  if (/故障|无法|失去联系|离线|error|offline/i.test(s)) return "danger";
  if (/忙|busy|稍后/i.test(s)) return "warn";
  if (/空闲|idle/i.test(s)) return "ok";
  return "muted";
}

export function isPrinterIdle(status: string): boolean {
  return printerStatusKind(status) === "ok";
}
