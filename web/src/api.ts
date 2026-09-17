// 与本地 Node 服务的接口封装。
//
// 所有请求都是同源的（生产环境由 server.mjs 托管，开发环境走 Vite proxy），
// 所以不需要处理 CORS，也不带任何凭据——会话在服务端。

import { fmtRowTime } from "./format";
import type {
  BulkResult,
  HistoryResponse,
  Paper,
  PrintersResponse,
  SessionResponse,
  Summary,
  UploadOptions,
  UploadOutcome,
  HistoryRow,
  PrintJob,
  ScanJob,
} from "./types";

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    throw new ApiError(
      `无法连接本地服务：${(err as Error).message}`,
      0,
      null,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
  }

  if (!res.ok) {
    const raw = (body as { message?: string } | null)?.message;
    // 5xx 说明是本机服务自己出了问题，服务端会把原始报错（常常是文件路径、
    // 系统调用名之类）直接放进 message。那对用户没有任何意义，只在控制台留一份，
    // 界面上给一句能照做的话。
    if (res.status >= 500) {
      if (raw) console.error(`[api] ${path} -> ${res.status}: ${raw}`);
      throw new ApiError("客户端出了点问题，重启应用后再试一次", res.status, body);
    }
    throw new ApiError(raw || `请求失败（HTTP ${res.status}）`, res.status, body);
  }
  return body as T;
}

/* ------------------------------------------------------------------ 会话 --- */

export function login(username: string, password: string) {
  return request<{ ok: boolean; user: Record<string, unknown> }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request<{ ok: boolean }>("/api/logout", { method: "POST" });
}

export function getSession() {
  return request<SessionResponse>("/api/session");
}

/* ------------------------------------------------------------------ 概览 --- */

export function getSummary(fresh = false) {
  return request<Summary>(`/api/summary${fresh ? "?fresh=1" : ""}`);
}

/* ------------------------------------------------------------- 打印点 --- */

export function getPrinters() {
  return request<PrintersResponse>("/api/printers");
}

/* ------------------------------------------------------------- 文档 --- */

export function getJobs() {
  return request<{ jobs: PrintJob[] }>("/api/jobs");
}

export function deleteJobs(ids: number[]) {
  return request<BulkResult>("/api/jobs/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function previewJob(id: number) {
  return request<unknown>("/api/jobs/preview", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function getScans() {
  return request<{ scans: ScanJob[] }>("/api/scans");
}

export function deleteScans(ids: number[]) {
  return request<BulkResult>("/api/scans/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function scanDownloadUrl(id: number): string {
  return `/api/scan-download?id=${encodeURIComponent(String(id))}`;
}

/* ------------------------------------------------------------- 记录 --- */

export function getHistory(begin: string, end: string, types: number[] = [1, 2, 3]) {
  const q = new URLSearchParams({ begin, end, types: types.join(",") });
  return request<HistoryResponse>(`/api/history?${q}`);
}

/* ------------------------------------------------------------- 纸型 --- */

export function getPapers() {
  return request<{ papers: Paper[] }>("/api/papers");
}

/* ------------------------------------------------------------- 上传 --- */

/**
 * 上传单个文件。
 *
 * 故意用 XHR 而不是 fetch：上传是要显示逐文件进度条的，fetch 在浏览器里
 * 拿不到上传进度。字段名必须和云打印接口一致，别改。
 */
export function uploadFile(
  file: File,
  opts: UploadOptions,
  hooks: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<UploadOutcome> {
  return new Promise((resolve, reject) => {
    const taskId = crypto.randomUUID();
    const form = new FormData();
    form.append("szPath", file, file.name);
    form.append("dwColor", String(opts.dwColor));
    form.append("dwPaperId", String(opts.dwPaperId));
    form.append("dwDuplex", String(opts.dwDuplex));
    form.append("dwFrom", "0");
    form.append("dwTo", "0");
    form.append("dwCopies", String(opts.dwCopies));
    form.append("taskId", taskId);
    form.append("BackURL", "result.html");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("x-task-id", taskId);
    // 文件名里有中文，必须编码后再放进请求头
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && hooks.onProgress) {
        hooks.onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as UploadOutcome);
      } catch {
        reject(new ApiError("上传返回了无法解析的内容", xhr.status, xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new ApiError("网络中断", 0, null));
    xhr.onabort = () => reject(new ApiError("已取消", 0, null));

    hooks.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** 导出使用记录为 CSV，在浏览器里直接下载。 */
export function exportHistoryCsv(rows: HistoryRow[], filename: string) {
  const header = ["时间", "类型", "纸型", "页数", "补贴(元)", "自费(元)", "终端"];
  const typeName = (t: unknown) => ({ 1: "打印", 2: "扫描", 3: "复印" })[Number(t) as 1 | 2 | 3] || "";
  const lines = rows.map((r) =>
    [
      fmtRowTime(r),
      typeName(r.dwType),
      r.dwPaperID ?? "",
      r.dwPages ?? 0,
      ((Number(r.dwUsedFreeMoney) || 0) / 100).toFixed(2),
      (((Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0)) / 100).toFixed(2),
      r.dwMFPSN ?? "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );
  // BOM 让 Excel 正确识别 UTF-8，否则中文会乱码
  const csv = "\uFEFF" + [header.join(","), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
