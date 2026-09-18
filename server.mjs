// 南科大云打印 · 本地现代化客户端 —— 零依赖 Node 服务端
//
// 职责：
//   1. 托管 public/ 下的前端静态资源
//   2. 代理云打印系统 API（浏览器同源，绕开 CORS）
//   3. 用学工号 + 密码走学校 CAS 统一认证，并把会话 Cookie 持久化到本地

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CookieJar,
  DEFAULT_ORIGIN,
  apiJson,
  fetchAllHistory,
  loginWithPassword,
} from "./lib/pms.mjs";
import { clearSession, loadOrCreateDriverToken, loadSession, saveSession } from "./lib/store.mjs";
import { LOCAL_API, PRINTER_NAME, SPOOL_DIR, ensureDirs, writeApiPort } from "./lib/paths.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// 前端已迁移到 web/（Vue 3 + Vite），构建产物在 web/dist。
// 若尚未构建则回退到旧的 public/，保证任何时刻都能跑起来。
const WEB_DIST = join(__dirname, "web", "dist");
const LEGACY_PUBLIC = join(__dirname, "public");
const PUBLIC_DIR = existsSync(join(WEB_DIST, "index.html")) ? WEB_DIST : LEGACY_PUBLIC;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ORIGIN = DEFAULT_ORIGIN;

/** 打印驱动调用上传接口时需要的本地令牌；initSession() 里加载。 */
let driverToken = "";

/**
 * 桌面壳交给我们的登录凭据（只放内存，不落盘）。
 * 用途只有一个：会话过期后自动重新登录，这样"打印"这件事不会因为
 * 会话失效而静默失败。密码的持久化由壳用系统钥匙串负责。
 */
let remembered = null;
let reloginInFlight = null;
/** 自动重登失败后的冷却截止时间。 */
let reloginCooldownUntil = 0;
/**
 * 连续失败时不要反复打 CAS —— 短时间内反复提交错误登录有把账号锁掉的风险。
 */
const RELOGIN_COOLDOWN_MS = 30_000;

const DEBUG = !!process.env.DEBUG_UPLOAD;
const dbg = (...args) => {
  if (DEBUG) console.log("[upload]", ...args);
};

// 补贴规则：每学年每人 100 元，学年从 9 月 1 日起算
const SUBSIDY_PER_YEAR = Number(process.env.SUBSIDY_PER_YEAR || 100);
const RESET_MONTH = Number(process.env.SUBSIDY_RESET_MONTH || 9);
const RESET_DAY = Number(process.env.SUBSIDY_RESET_DAY || 1);

/* ------------------------------------------------------------------ */
/* 会话状态                                                            */
/* ------------------------------------------------------------------ */

/** @type {{ jar: CookieJar, user: object|null, savedAt: number }|null} */
let session = null;
let userCache = { at: 0, user: null };

// 汇总数据变化很慢，缓存一下可以让页面切换instant
const SUMMARY_TTL = 20_000;
let summaryCache = { at: 0, data: null };
function bustSummary() {
  summaryCache = { at: 0, data: null };
}

async function initSession() {
  await ensureDirs();
  driverToken = await loadOrCreateDriverToken();
  const saved = await loadSession();
  if (saved) {
    session = {
      jar: CookieJar.fromJSON(saved.cookies),
      user: saved.user || null,
      savedAt: saved.savedAt || 0,
    };
  }
}

/**
 * 把当前会话写盘。
 *
 * 故意吞掉异常：会话只是"下次不用重登"的便利，登录本身已经成功了。写不进去
 * 顶多是下次要重新登录，不该让用户看到一个原始的文件系统报错、也不知道自己是
 * 登上了还是没登上。
 */
async function persistSession() {
  if (!session) return;
  try {
    await saveSession({ cookies: session.jar.toJSON(), user: session.user });
  } catch (err) {
    console.warn(`[session] 会话写盘失败，本次登录仍然有效：${err?.message || err}`);
  }
}

function dropSession() {
  session = null;
  userCache = { at: 0, user: null };
}

/* ------------------------------------------------------------------ */
/* HTTP 小工具                                                         */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: true, message });
}

async function readBody(req, limit = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

/* ------------------------------------------------------------------ */
/* 打印驱动侧：本地令牌 + 上传                                          */
/* ------------------------------------------------------------------ */

/** 把请求头里的值收敛成 [min,max] 内的整数，非法值一律回落到 fallback。 */
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 校验驱动令牌。
 *
 * 上传接口能拿登录用户的身份往云打印队列里塞文件，所以不能只靠"监听 127.0.0.1"
 * 来当权限——同机任何进程（甚至浏览器里的网页）都能打到本地端口。驱动脚本从
 * CONFIG_DIR/driver-token 读到令牌后放在 x-driver-token 里。
 */
function driverAuthorized(req, url) {
  if (!driverToken) return false;
  const supplied = String(
    req.headers["x-driver-token"] || url?.searchParams.get("token") || "",
  );
  const a = Buffer.from(supplied);
  const b = Buffer.from(driverToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 拼 multipart 请求体。
 *
 * 这里不用 Node 自带的 FormData：undici 对非 ASCII 文件名会改用 RFC 5987 的
 * `filename*=utf-8''...` 形式，而云打印后端（ASP.NET）只认 Chrome 那种裸 UTF-8 的
 * `filename="中文.pdf"`。手工拼字节，保证和浏览器发出的完全一致。
 */
/**
 * 上传接口路径。
 *
 * 上游**改过名**：2026-09 实测 `/api/client/CloudPrint/UploadFile` 返回
 * `404 No HTTP resource was found`，而 `/api/client/CloudPrint/Upload`
 * 返回 405（存在但不接受 GET）—— 真正的路径是后者。
 *
 * 两处调用（浏览器透传 /api/upload 和驱动 submitDocument）共用这一个常量，
 * 免得再出现"只改了一处"的情况。复核方法见
 * tools/probe-upstream-capabilities.mjs（GET 一下：405=存在，404=没了）。
 */
const UPLOAD_PATH = "/api/client/CloudPrint/Upload";

/**
 * 判断 404 是"路由不存在"还是"临时抖动"。
 *
 * ASP.NET 在路由不存在时返回的 body 形如：
 *   {"Message":"No HTTP resource was found that matches the request URI '...'."}
 * 路由一旦改名就**永远不会**成功，重试毫无意义。以前把这种 404 当成
 * "服务端临时故障、重试通常就能成功"，结果上游改名后驱动默默重试到死，
 * 用户只看到"打印失败"却不知道为什么。现在明确区分并给出可操作的提示。
 */
function isRouteMissing(status, text) {
  return status === 404 && /No HTTP resource was found/i.test(String(text || ""));
}

function buildMultipart(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.data !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${p.type || "application/octet-stream"}\r\n\r\n`,
        ),
        p.data,
        Buffer.from("\r\n"),
      );
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/**
 * 把一份本地生成的 PDF 提交到云打印队列，并等到服务端确认入库。
 *
 * 与 /api/upload 的区别：那个是浏览器把 multipart 原样透传过来，这个由服务端自己
 * 拼请求体，供打印驱动（Windows 端口落盘 / macOS CUPS backend）调用。
 *
 * @param {Buffer} buf PDF 内容
 * @param {string} fileName 队列里显示的文件名
 * @param {{copies?:number,duplex?:number,color?:number,paperId?:number}} opts
 */
async function submitDocument(buf, fileName, opts = {}) {
  const taskId = crypto.randomUUID();
  const boundary = `----sustechprint${crypto.randomUUID().replace(/-/g, "")}`;

  const body = buildMultipart(
    [
      { name: "szPath", filename: fileName, data: buf, type: "application/pdf" },
      { name: "dwColor", value: String(opts.color ?? 0) },
      { name: "dwPaperId", value: String(opts.paperId ?? 0) },
      { name: "dwDuplex", value: String(opts.duplex ?? 0) },
      { name: "dwFrom", value: "0" },
      { name: "dwTo", value: "0" },
      { name: "dwCopies", value: String(opts.copies ?? 1) },
      { name: "taskId", value: taskId },
      { name: "BackURL", value: "result.html" },
    ],
    boundary,
  );

  const url = `${ORIGIN}${UPLOAD_PATH}`;
  const headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length),
    "user-agent": "sustech-print-local",
    origin: ORIGIN,
    referer: `${ORIGIN}/client/new/cprintPc/cprint.html`,
  };
  const cookie = session.jar.header(url);
  if (cookie) headers.cookie = cookie;

  // 先挂进度通道再上传。
  //
  // 2026-09 实测：上游**已经不再提供这个通道**了 —— wss://.../ws?token= 握手
  // 直接失败（约 0.5s），线上 web 客户端的 JS 里连 taskId / WebSocket 都搜不到，
  // 它现在只是 POST 完看 oReq.status。所以这里不再把它当必要条件：
  // 握手没成功就立刻跳过等待，避免成功路径上白等 30s（waitForFinal 的超时）。
  // 上传成功与否以 POST 的结果为准（见下面 outcome 的处理）；这里留着这段
  // 只是因为万一上游把通道恢复，它报的 error 仍然是最有价值的失败信号。
  // 千万不要再用文档列表去"兜底核实"：那个列表是最终一致的，滞后好几分钟。
  const socket = await openProgressSocket(taskId, cookie);
  const settled = socket.ok ? waitForFinal(socket.ws) : Promise.resolve({ status: "closed" });

  let upstream;
  let text;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
    });
    text = await upstream.text();
  } catch (err) {
    socket.close();
    return {
      ok: false,
      taskId,
      reason: "network",
      retryable: true,
      message: `上传失败：${err.message}`,
    };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: String(text).slice(0, 300) };
  }

  if (!upstream.ok || payload?.code) {
    socket.close();
    const status = upstream.status;
    const code = payload?.code;
    let reason = "error";
    let message = payload?.message || "";
    let retryable = false;

    if (code === 4) {
      reason = "auth";
      message = "登录状态已失效，请重新登录后再打印";
    } else if (status === 404) {
      if (isRouteMissing(status, text)) {
        // 路由改名 —— 重试永远不会成功，别再说成"临时故障"
        reason = "route-missing";
        message = `上游上传接口不存在：${UPLOAD_PATH}（路径可能已变更，需更新程序）`;
        retryable = false;
      } else {
        reason = "upstream-404";
        message = "打印系统返回 404（服务端临时故障）";
        retryable = true;
      }
    } else if (status === 413) {
      reason = "too-large";
      message = "文件过大，打印系统拒绝接收";
    } else if (status >= 500) {
      reason = "upstream-5xx";
      message = `打印系统错误（HTTP ${status}）`;
      retryable = true;
    } else if (!message) {
      message = `上传失败（HTTP ${status}）`;
    }
    return { ok: false, taskId, reason, retryable, message };
  }

  const outcome = await settled;
  socket.close();

  // 上传这一步已经拿到 code=0 + 2xx，就是成功。
  //
  // 这里**刻意不再去文档列表里二次确认**（曾经等 12 秒、后来放宽到 45 秒）。
  // 原因是文档列表最终一致、滞后能到好几分钟：实测一份 18:16:39 提交的作业，
  // 18:17:30 才拿到上传响应，随后 45 秒窗口一次都没命中 —— 而它确实在队列里，
  // szJobName 逐字一致（云打印-20260918-181639.pdf），十几分钟后再查就在了。
  // 拿一个滞后几分钟的列表做同步判断，只会把成功的作业报成失败，而且
  // retryable=true 还会让调用方重传，等于把一份文档变成好几份。
  //
  // 判断成功与否的可信信号只有上传接口本身；"到底进没进队列"由用户在「文档」
  // 页面看（那个页面就是干这个的）。
  if (outcome.status === "error") {
    return {
      ok: false,
      taskId,
      stage: "error",
      reason: "processing",
      retryable: false,
      message: outcome.message || "文件处理失败",
    };
  }

  return {
    ok: true,
    taskId,
    stage: outcome.status === "final" ? "final" : "accepted",
    reason: "ok",
    retryable: false,
    progress: outcome.progress ?? null,
    message: "",
  };
}

/* ------------------------------------------------------------------ */
/* 业务辅助                                                            */
/* ------------------------------------------------------------------ */

/** 当前学年的起始日期，格式 YYYYMMDD。 */
function academicYearStart(now = new Date()) {
  const y = now.getFullYear();
  const start = new Date(y, RESET_MONTH - 1, RESET_DAY);
  const year = now >= start ? y : y - 1;
  const mm = String(RESET_MONTH).padStart(2, "0");
  const dd = String(RESET_DAY).padStart(2, "0");
  return `${year}${mm}${dd}`;
}

function todayStamp(now = new Date()) {
  return (
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}`
  );
}

/**
 * 用本机保存的凭据静默重登。
 *
 * 打印驱动是没有 UI 的：会话如果过期了，用户点"打印"却什么都没发生，
 * 是极难排查的体验。所以只要壳给了凭据，就先自动补一次登录。
 */
async function tryRelogin() {
  if (!remembered) return null;
  if (reloginInFlight) return reloginInFlight;
  if (Date.now() < reloginCooldownUntil) return null;

  reloginInFlight = (async () => {
    try {
      // remembered 可能是对象，也可能是一个异步取凭据的函数（见
      // setRememberedCredential）。无头进程用后者：读钥匙串/DPAPI 有成本
      // （Windows 上要起一次 PowerShell），会话没过期就不该付这个钱。
      const cred = typeof remembered === "function" ? await remembered() : remembered;
      if (!cred?.username) return null;

      const jar = new CookieJar();
      const user = await loginWithPassword(
        jar,
        cred.username,
        cred.password,
        ORIGIN,
      );
      session = { jar, user, savedAt: Date.now() };
      userCache = { at: Date.now(), user };
      await persistSession();
      bustSummary();
      reloginCooldownUntil = 0;
      console.log("[session] 会话已失效，已用本机保存的凭据自动重新登录");
      return user;
    } catch (err) {
      reloginCooldownUntil = Date.now() + RELOGIN_COOLDOWN_MS;
      console.warn(
        `[session] 自动重登失败（${RELOGIN_COOLDOWN_MS / 1000}s 内不再重试）：${err?.message || err}`,
      );
      return null;
    } finally {
      reloginInFlight = null;
    }
  })();

  return reloginInFlight;
}

/** 拿到有效会话；失效时返回 null，不再重复打接口。 */
async function currentUser(force = false) {
  if (!session) return tryRelogin();

  if (!force && userCache.user && Date.now() - userCache.at < 30_000) {
    return userCache.user;
  }
  try {
    const json = await apiJson(session.jar, ORIGIN, "POST", "/api/client/Auth/Check");
    if (json?.code === 0 && json.result) {
      session.user = json.result;
      userCache = { at: Date.now(), user: json.result };
      return json.result;
    }
  } catch {
    /* 网络异常按未登录处理 */
  }
  // 会话确实失效了，试一次自动重登
  return tryRelogin();
}

async function requireSession(res) {
  const user = await currentUser();
  if (!user) {
    sendError(res, 401, "未登录或登录已过期");
    return null;
  }
  return user;
}

/** 原样转发一个二进制/流式响应（用于扫描件下载）。 */
async function proxyStream(res, path) {
  const url = `${ORIGIN}${path}`;
  const headers = { "user-agent": "sustech-print-local" };
  const cookie = session.jar.header(url);
  if (cookie) headers.cookie = cookie;
  const upstream = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "content-disposition":
      upstream.headers.get("content-disposition") || "attachment",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const routes = {
  /* --- 会话 --- */

  "POST /api/login": async (req, res) => {
    const { username, password } = await readJson(req);
    const jar = new CookieJar();
    let user;
    try {
      user = await loginWithPassword(jar, username, password, ORIGIN);
    } catch (err) {
      return sendError(res, 401, err.message || "登录失败");
    }
    session = { jar, user, savedAt: Date.now() };
    userCache = { at: Date.now(), user };
    await persistSession();
    bustSummary();
    sendJson(res, 200, { ok: true, user });
  },

  "POST /api/logout": async (_req, res) => {
    try {
      if (session) await apiJson(session.jar, ORIGIN, "GET", "/api/client/Auth/Logout");
    } catch {
      /* 忽略远端登出失败 */
    }
    dropSession();
    await clearSession();
    bustSummary();
    sendJson(res, 200, { ok: true });
  },

  "GET /api/session": async (_req, res) => {
    const user = await currentUser();
    if (!user) return sendJson(res, 200, { loggedIn: false });
    sendJson(res, 200, {
      loggedIn: true,
      user: {
        logonName: user.szLogonName,
        trueName: user.szTrueName,
        cardNo: user.szCardNo,
        sex: user.dwSex,
      },
    });
  },

  /* --- 汇总：账号 + 补贴 + 概览 --- */

  "GET /api/summary": async (_req, res, url) => {
    const user = await requireSession(res);
    if (!user) return;

    const fresh = url?.searchParams.get("fresh") === "1";
    if (!fresh && summaryCache.data && Date.now() - summaryCache.at < SUMMARY_TTL) {
      return sendJson(res, 200, summaryCache.data);
    }

    const begin = academicYearStart();
    const end = todayStamp();

    // 打印点由 /api/printers 单独返回，这里不重复拉取
    const [jobs, scans, history] = await Promise.all([
      apiJson(session.jar, ORIGIN, "GET", `/api/client/PrintJob/Get?timestamp=${Date.now()}`).catch(
        () => null,
      ),
      apiJson(session.jar, ORIGIN, "GET", `/api/client/Scan/Get?timestamp=${Date.now()}`).catch(
        () => null,
      ),
      fetchAllHistory(session.jar, ORIGIN, { begin, end }).catch(() => ({ rows: [] })),
    ]);

    const rows = history.rows || [];
    const usedCents = rows.reduce((s, r) => s + (Number(r.dwUsedFreeMoney) || 0), 0);
    const paidCents = rows.reduce(
      (s, r) => s + (Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0),
      0,
    );
    const pages = rows.reduce((s, r) => s + (Number(r.dwPages) || 0), 0);

    const payload = {
      user: {
        logonName: user.szLogonName,
        trueName: user.szTrueName,
        cardNo: user.szCardNo,
        // 注意：dwBalance 恒为 0，校园卡真实余额在校园卡系统里，这个接口拿不到，
        // 所以不要把它当成余额展示，免得误导。
        serverSubsidy: (Number(user.dwSubsidy) || 0) / 100,
      },
      subsidy: {
        perYear: SUBSIDY_PER_YEAR,
        academicYearStart: begin,
        academicYearEnd: end,
        used: usedCents / 100,
        remainingComputed: Math.round(SUBSIDY_PER_YEAR * 100 - usedCents) / 100,
        serverReported: (Number(user.dwSubsidy) || 0) / 100,
        paid: paidCents / 100,
        pages,
        records: rows.length,
      },
      history: rows,
      counts: {
        pendingJobs: (jobs?.result || []).length,
        scans: (scans?.result || []).length,
      },
    };

    summaryCache = { at: Date.now(), data: payload };
    sendJson(res, 200, payload);
  },

  /* --- 打印点 --- */

  "GET /api/printers": async (_req, res) => {
    if (!(await requireSession(res))) return;
    const [list, srv] = await Promise.all([
      apiJson(session.jar, ORIGIN, "GET", "/api/client/Station/GetList"),
      apiJson(session.jar, ORIGIN, "GET", "/api/client/Station/GetSrvList").catch(() => null),
    ]);
    if (list?.code !== 0) return sendError(res, 502, list?.message || "获取打印点失败");
    sendJson(res, 200, {
      printers: (list.result || []).map((s) => ({
        id: s.dwDevSN,
        name: s.szName,
        ip: s.szIP,
        mac: s.szMAC,
        status: s.szStatInfo || "未知",
        driver: s.szPrtDriver,
        function: s.dwFunction,
        tray1: s.dwTrayPaper1,
        tray2: s.dwTrayPaper2,
        openTime: s.dwOpenTime,
        closeTime: s.dwCloseTime,
        updatedAt: s.dwUpdateTime,
      })),
      servers: srv?.result || [],
    });
  },

  /* --- 打印文档（待打印任务） --- */

  "GET /api/jobs": async (_req, res) => {
    if (!(await requireSession(res))) return;
    const json = await apiJson(session.jar, ORIGIN, "GET", `/api/client/PrintJob/Get?timestamp=${Date.now()}`);
    if (json?.code !== 0) return sendError(res, 502, json?.message || "获取文档失败");
    sendJson(res, 200, { jobs: json.result || [] });
  },

  "POST /api/jobs/delete": async (req, res) => {
    if (!(await requireSession(res))) return;
    const { ids } = await readJson(req);
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return sendError(res, 400, "未选择文档");

    const results = [];
    for (const id of list) {
      try {
        // 原实现同时提交 dwJobId / dwOldJobId，两者一致
        const json = await apiJson(session.jar, ORIGIN, "POST", "/api/client/PrintJob/Del", {
          dwJobId: id,
          dwOldJobId: id,
        });
        results.push({ id, ok: json?.code === 0, message: json?.message || "" });
      } catch (err) {
        results.push({ id, ok: false, message: err.message });
      }
    }
    bustSummary();
    sendJson(res, 200, {
      ok: results.every((r) => r.ok),
      deleted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  },

  "POST /api/jobs/preview": async (req, res) => {
    if (!(await requireSession(res))) return;
    const { id } = await readJson(req);
    const json = await apiJson(
      session.jar,
      ORIGIN,
      "POST",
      `/api/client/PrintJob/PreviewPage?timestamp=${Date.now()}`,
      { dwJobId: id },
    );
    sendJson(res, json?.code === 0 ? 200 : 502, json);
  },

  /* --- 扫描文档 --- */

  "GET /api/scans": async (_req, res) => {
    if (!(await requireSession(res))) return;
    const json = await apiJson(session.jar, ORIGIN, "GET", `/api/client/Scan/Get?timestamp=${Date.now()}`);
    if (json?.code !== 0) return sendError(res, 502, json?.message || "获取扫描件失败");
    sendJson(res, 200, { scans: json.result || [] });
  },

  "POST /api/scans/delete": async (req, res) => {
    if (!(await requireSession(res))) return;
    const { ids } = await readJson(req);
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return sendError(res, 400, "未选择扫描件");

    const results = [];
    for (const id of list) {
      try {
        const json = await apiJson(session.jar, ORIGIN, "POST", "/api/client/Scan/Del", { dwJobId: id });
        results.push({ id, ok: json?.code === 0, message: json?.message || "" });
      } catch (err) {
        results.push({ id, ok: false, message: err.message });
      }
    }
    bustSummary();
    sendJson(res, 200, {
      ok: results.every((r) => r.ok),
      deleted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  },

  "GET /api/scan-download": async (req, res, url) => {
    if (!(await requireSession(res))) return;
    const id = url.searchParams.get("id");
    if (!id) return sendError(res, 400, "缺少 id");
    await proxyStream(res, `/api/client/Scan/Download?dwJobId=${encodeURIComponent(id)}`);
  },

  /* --- 使用记录 --- */

  "GET /api/history": async (_req, res, url) => {
    if (!(await requireSession(res))) return;
    const begin = url.searchParams.get("begin") || academicYearStart();
    const end = url.searchParams.get("end") || todayStamp();
    const typesParam = url.searchParams.get("types");
    const types = typesParam
      ? typesParam.split(",").map(Number).filter((n) => n >= 1 && n <= 3)
      : [1, 2, 3];
    const { rows } = await fetchAllHistory(session.jar, ORIGIN, { begin, end, types });
    sendJson(res, 200, { begin, end, types, rows });
  },

  /* --- 纸张类型 --- */

  "GET /api/papers": async (_req, res) => {
    if (!(await requireSession(res))) return;
    const json = await apiJson(session.jar, ORIGIN, "POST", "/api/client/Paper/GetPaper");
    if (json?.code !== 0) return sendError(res, 502, json?.message || "获取纸型失败");
    sendJson(res, 200, { papers: json.result || [] });
  },

  /* --- 上传（原始 multipart 透传 + WebSocket 进度） --- */

  "POST /api/upload": async (req, res) => {
    if (!(await requireSession(res))) return;
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return sendError(res, 400, "需要 multipart/form-data");
    }

    // 任务号由前端生成（同时写进表单的 taskId 字段），服务端用它挂进度连接。
    // 这一步是必须的：上传结果只通过 /ws?token=<taskId> 推送，没有它任务不会落库。
    const taskId =
      String(req.headers["x-task-id"] || "").trim() || crypto.randomUUID();
    // 用于兜底核对打印队列（进度通道没回话时）
    let fileName = "";
    try {
      fileName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
    } catch {
      fileName = String(req.headers["x-file-name"] || "");
    }

    const buf = await readBody(req);
    dbg("body read", buf.length);
    const url = `${ORIGIN}${UPLOAD_PATH}`;
    const headers = {
      "content-type": contentType,
      "content-length": String(buf.length),
      "user-agent": "sustech-print-local",
      origin: ORIGIN,
      referer: `${ORIGIN}/client/new/cprintPc/cprint.html`,
    };
    const cookie = session.jar.header(url);
    if (cookie) headers.cookie = cookie;

    // 1) 先挂上进度通道（若上游还提供的话）。握手失败不等它，见下方说明。
    const socket = await openProgressSocket(taskId, cookie);
    dbg("socket", socket.ok ? "open" : "failed");
    const settled = socket.ok ? waitForFinal(socket.ws) : Promise.resolve({ status: "closed" });

    // 2) 再上传文件
    let upstream, text;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: buf,
        signal: AbortSignal.timeout(120_000),
      });
      text = await upstream.text();
      dbg("uploaded", upstream.status);
    } catch (err) {
      socket.close();
      return sendError(res, 502, `上传失败：${err.message}`);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 500) };
    }
    if (!upstream.ok || (payload && payload.code)) {
      socket.close();
      const status = upstream.status;
      const code = payload?.code;

      // 云打印服务端偶尔会返回 ASP.NET 路由 404（"No HTTP resource was found"），
      // 属于临时故障，重试通常就能成功 —— 明确标成可重试。
      let reason = "error";
      let message = payload?.message || "";
      let retryable = false;

      if (code === 4) {
        reason = "auth";
        message = "登录状态已失效，请重新登录后再上传";
      } else if (status === 404) {
        if (isRouteMissing(status, text)) {
          reason = "route-missing";
          message = `上游上传接口不存在：${UPLOAD_PATH}（路径可能已变更，需更新程序）`;
          retryable = false;
        } else {
          reason = "upstream-404";
          message = "打印系统返回 404（服务端临时故障），正在重试…";
          retryable = true;
        }
      } else if (status === 413) {
        reason = "too-large";
        message = "文件过大，打印系统拒绝接收";
      } else if (status >= 500) {
        reason = "upstream-5xx";
        message = `打印系统错误（HTTP ${status}），正在重试…`;
        retryable = true;
      } else if (!message) {
        message = `上传失败（HTTP ${status}）`;
      }

      dbg("upload failed", { status, code, reason });
      return sendJson(res, 200, { ok: false, taskId, reason, retryable, message });
    }

    // 3) 等服务端处理完成（转换 / 入库）
    const outcome = await settled;
    socket.close();

    // 4) 以 HTTP 结果为准，不再拿文档列表做同步确认（理由见 submitDocument 的注释）
    dbg("outcome", "processing=" + outcome.status);

    if (outcome.status === "error") {
      return sendJson(res, 200, {
        ok: false,
        taskId,
        stage: "error",
        reason: "processing",
        retryable: false,
        message: outcome.message || "文件处理失败",
      });
    }

    sendJson(res, 200, {
      ok: true,
      taskId,
      stage: outcome.status === "final" ? "final" : "accepted",
      reason: "ok",
      retryable: false,
      progress: outcome.progress ?? null,
      message: "",
    });
    bustSummary();
  },

  /* --- 打印驱动接口（Windows 端口落盘 / macOS CUPS backend 调用） ---
   *
   * 故意用「裸 body + 请求头传参」而不是 multipart：调用方是我们自己的驱动脚本，
   * 这样 curl / fetch 一行就能发，少一层解析也就少一类 bug。
   */

  "GET /api/driver/status": async (req, res, url) => {
    if (!driverAuthorized(req, url)) return sendError(res, 401, "缺少或错误的驱动令牌");
    const user = await currentUser();
    sendJson(res, 200, {
      ok: true,
      loggedIn: Boolean(user),
      user: user ? { logonName: user.szLogonName, trueName: user.szTrueName } : null,
      printerName: PRINTER_NAME,
      spoolDir: SPOOL_DIR,
      api: LOCAL_API,
    });
  },

  // 打印驱动把生成好的 PDF 发到这里，由本进程带上已保存的会话上传到云打印队列。
  "POST /api/driver/print": async (req, res, url) => {
    if (!driverAuthorized(req, url)) return sendError(res, 401, "缺少或错误的驱动令牌");

    const user = await currentUser();
    if (!user) {
      // 用 200 返回业务失败，让驱动脚本能读到结构化的 reason 再决定是否拉起 App
      return sendJson(res, 200, {
        ok: false,
        reason: "not-logged-in",
        retryable: false,
        message: "本地客户端尚未登录，请先打开「南科大云打印」登录",
      });
    }

    const buf = await readBody(req);
    if (!buf.length) return sendError(res, 400, "请求体为空");

    let fileName = String(req.headers["x-file-name"] || "").trim();
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      /* 不是合法百分号编码就按原样用 */
    }
    if (!fileName) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      fileName = `云打印-${stamp}.pdf`;
    }
    if (!/\.pdf$/i.test(fileName)) fileName += ".pdf";

    const opts = {
      copies: clampInt(req.headers["x-copies"], 1, 1, 99),
      duplex: clampInt(req.headers["x-duplex"], 0, 0, 2),
      color: clampInt(req.headers["x-color"], 0, 0, 1),
      paperId: clampInt(req.headers["x-paper-id"], 0, 0, 9999),
    };

    const result = await submitDocument(buf, fileName, opts);
    bustSummary();
    sendJson(res, 200, result);
  },
};

/* ------------------------------------------------------------------ */
/* 上传进度 WebSocket（上游已下线，保留兼容）                          */
/* ------------------------------------------------------------------ */

/**
 * 连接上游的进度通道（WebSocket），成功返回 {ws, ok:true}。
 *
 * ⚠️ 2026-09 实测该通道**已经下线**：握手直接失败（约 0.5s）。
 * 线上 web 客户端也不再使用它（JS 里没有 taskId / WebSocket）。
 * 调用方必须容忍 ok:false，并且**不要在 ok:false 时等待 waitForFinal**，
 * 否则成功路径会白等 waitForFinal 的 30s 超时。
 *
 * 历史背景（当时确实需要它）：
 *   1. 必须在实际上传之前建立，否则任务不会被注册、文件不会落库。
 *   2. 握手必须带上会话 Cookie，否则可能「连上但收不到消息」。
 */
function openProgressSocket(taskId, cookie, timeoutMs = 10_000) {
  const url = `wss://pms.sustech.edu.cn/ws?token=${encodeURIComponent(taskId)}`;
  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ws,
        ok,
        close: () => {
          try {
            ws?.close();
          } catch {
            /* 已关闭 */
          }
        },
      });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(url, {
        headers: {
          cookie: cookie || "",
          origin: ORIGIN,
          "user-agent": "sustech-print-local",
        },
      });
    } catch {
      return finish(false);
    }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: "auth", sessionId: taskId }));
      } catch {
        /* 忽略 */
      }
      finish(true);
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

/** 兜底核实：打印队列里是否已经出现这份文件。 */
/** 等待进度通道给出 final / error。 */

/** 等待进度通道给出 final / error。 */
function waitForFinal(ws, timeoutMs = 30_000) {
  if (!ws) return Promise.resolve({ status: "closed" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.event !== "progress" || !msg.data) return;
      const { type, progress, info } = msg.data;
      if (type === "final") finish({ status: "final", progress });
      else if (type === "error") finish({ status: "error", message: info });
    };
    ws.onclose = () => finish({ status: "closed" });
    ws.onerror = () => finish({ status: "error", message: "进度连接异常" });
  });
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    return sendError(res, 403, "禁止访问");
  }
  if (pathname === "/" || pathname === "") filePath = join(PUBLIC_DIR, "index.html");

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    // SPA 回退
    try {
      data = await readFile(join(PUBLIC_DIR, "index.html"));
      filePath = "index.html";
    } catch {
      return sendError(res, 404, "未找到");
    }
  }
  const type = MIME[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": data.length,
    "cache-control": "no-cache",
    // 内容全是我们自己托管的，锁死到同源。
    // style 需要 unsafe-inline：Naive UI 用行内样式做主题变量。
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(data);
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    const handler = routes[key];
    if (handler) {
      await handler(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      return sendError(res, 404, `未知接口 ${key}`);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, 405, "方法不支持");
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, err?.message || "服务器内部错误");
    else res.end();
  }
});

await initSession();

// 连接超时：避免半开连接长期占位
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 300_000;

/**
 * 启动本地服务。返回实际监听地址——传 port 0 时由系统分配空闲端口，
 * Electron 走的就是这条路（固定端口容易被别的程序占用，也更容易被猜到）。
 */
export function startServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(port, host, async () => {
      server.off("error", onError);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;

      // 打印驱动靠这个文件找到我们，所以写失败是严重问题 —— 但**不能**让它
      // 把启动链打断。以前这里是裸 await：一旦 rejects 就没人接，这个 Promise
      // 永远不 resolve，于是 whenReady 后面全部不执行，表现为"打开一个白窗口 /
      // 什么都没有，日志也一行不写"，极难排查。真实触发场景：配置文件被上一个
      // 用户或以管理员身份跑过一次的进程创建，属主变了，当前用户改不动。
      let apiPortError = null;
      try {
        await writeApiPort(actualPort, host);
      } catch (err) {
        apiPortError = err.message;
        console.error(`[api-port] 写入失败：${err.message}`);
      }
      resolve({ port: actualPort, host, url, apiPortError });
    });
  });
}

/**
 * 关掉本地服务。
 *
 * `force` 会把还挂着的连接直接掐掉，用在无头进程超时收尾的场景。
 *
 * 为什么不能只写 `server.close(cb)`：那个回调要等**所有**连接结束才会来，
 * 而无头进程里完全可能正挂着一个传到一半的上传（上游慢起来要几十秒）。
 * 实测踩到：worker 过了自己的 MAX_MS 还是不走，计划任务一直显示"正在运行"，
 * 文件名也永远留在 processing/ 里 —— 原因就是卡在这个回调上。
 * 所以这里除了 force 之外还留了一个兜底：无论如何 2 秒内必须返回。
 */
export function stopServer({ force = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(done);
    if (force) server.closeAllConnections?.();
    setTimeout(done, 2000);
  });
}

/**
 * 确保有一个可用会话（必要且拿得到凭据时会自动重登），返回用户对象或 null。
 *
 * 给无头进程用：它在开始收 spool 作业**之前**必须先确认登录状态。顺序反过来的话，
 * 没登录时作业会被搬进 failed/ 直接丢掉；先探一次则可以把文件原样留在 spool 里，
 * 等用户打开客户端登录后再传。
 */
export async function ensureSession() {
  try {
    return await currentUser();
  } catch {
    return null;
  }
}

/**
 * 记住登录凭据（仅内存），供会话过期后自动重登。
 *
 * 参数可以是一个 { username, password } 对象，也可以是一个**返回它的异步函数**。
 * 后者给无头进程用：凭据从系统钥匙串/DPAPI 里取，取一次要几十毫秒到一秒
 * （Windows 上要起 PowerShell），而绝大多数唤醒其实会话还好好的，不该白付。
 *
 * 由桌面壳调用：密码是用系统加密存储（macOS Keychain / Windows DPAPI）加密后
 * 存在磁盘上的，这里只拿它做自动重登，不落盘。
 */
export function setRememberedCredential(credential) {
  if (typeof credential === "function") {
    remembered = credential;
    return;
  }
  remembered = credential && credential.username ? credential : null;
}

// 直接 `node server.mjs` 时才自动启动；被 Electron import 时不启动。
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const info = await startServer();
  console.log(`\n  南科大云打印 · 本地客户端`);
  console.log(`  ➜  ${info.url}`);
  console.log(`  ➜  上游: ${ORIGIN}`);
  console.log(`  ➜  补贴: 每学年 ${SUBSIDY_PER_YEAR} 元（${RESET_MONTH} 月 ${RESET_DAY} 日重置）\n`);
}
