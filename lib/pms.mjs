// 联创云打印 (UniPrint) 客户端：Cookie 罐 + CAS 统一认证登录 + API 调用。
//
// 登录链路（实测）：
//   GET  /api/client/Auth/SSoPage        -> 返回 authcenter 地址
//   GET  authcenter/toLoginPage          -> 302 到 cas.sustech.edu.cn/cas/login?service=...
//   POST cas/login  (username/password/execution，明文表单)
//        -> 302 service?ticket=ST-...    -> authcenter 校验 -> 302 回 pms
//   GET  /api/client/Auth/Check          -> code 0 表示会话有效

const DEFAULT_ORIGIN = process.env.PMS_ORIGIN || "https://pms.sustech.edu.cn";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/* ------------------------------------------------------------------ */
/* Cookie 罐                                                           */
/* ------------------------------------------------------------------ */

function domainMatches(host, domain) {
  if (!domain) return false;
  return host === domain || host.endsWith("." + domain);
}

function pathMatches(pathname, cookiePath) {
  if (!cookiePath || cookiePath === "/") return true;
  if (pathname === cookiePath) return true;
  const p = cookiePath.endsWith("/") ? cookiePath : cookiePath + "/";
  return pathname.startsWith(p);
}

function parseSetCookie(host, raw) {
  const parts = String(raw).split(";");
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie = { name, value, domain: host, path: "/", secure: false, expires: 0 };
  for (const part of parts) {
    const i = part.indexOf("=");
    const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : part.slice(i + 1).trim();
    if (key === "domain" && val) cookie.domain = val.replace(/^\./, "").toLowerCase();
    else if (key === "path" && val) cookie.path = val;
    else if (key === "secure") cookie.secure = true;
    else if (key === "max-age" && val) cookie.expires = Date.now() + Number(val) * 1000;
    else if (key === "expires" && val) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = t;
    }
  }
  return cookie;
}

export class CookieJar {
  constructor(list) {
    /** @type {Map<string, object>} */
    this.cookies = new Map();
    for (const c of list || []) this.put(c);
  }

  static fromJSON(list) {
    return new CookieJar(list);
  }

  toJSON() {
    return [...this.cookies.values()];
  }

  put(cookie) {
    if (!cookie || !cookie.name) return;
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    // 值为空且标记删除时移除
    if (cookie.value === "" && cookie.expires && cookie.expires < Date.now()) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, cookie);
  }

  absorb(url, setCookieHeaders) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    for (const raw of setCookieHeaders || []) {
      const cookie = parseSetCookie(host, raw);
      if (cookie) this.put(cookie);
    }
  }

  header(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return "";
    }
    const host = u.hostname.toLowerCase();
    const now = Date.now();
    const out = [];
    for (const c of this.cookies.values()) {
      if (!domainMatches(host, c.domain)) continue;
      if (!pathMatches(u.pathname, c.path)) continue;
      if (c.expires && c.expires < now) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.join("; ");
  }

  /** 是否已经拿到云打印系统的会话 Cookie（登录成功的标志）。 */
  hasSessionCookie() {
    for (const c of this.cookies.values()) {
      if (c.name === "SESSIONID" && c.value) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 底层请求                                                            */
/* ------------------------------------------------------------------ */

/** 上游默认超时。没有它的话，一次卡住的请求会一直占着连接，把整个本地服务拖死。 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.PMS_TIMEOUT_MS || 20_000);

async function rawFetch(jar, url, init = {}) {
  const headers = new Headers(init.headers || {});
  const cookie = jar.header(url);
  if (cookie) headers.set("cookie", cookie);
  if (!headers.has("user-agent")) headers.set("user-agent", UA);
  if (!headers.has("accept")) headers.set("accept", "*/*");

  const res = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  jar.absorb(url, setCookies);

  return res;
}

/** 手动跟随重定向，逐跳收集 Cookie。POST 遇 301/302/303 自动转 GET。 */
async function follow(jar, url, init = {}, maxHops = 15) {
  let current = url;
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;
  let lastRes = null;

  for (let hop = 0; hop < maxHops; hop++) {
    const res = await rawFetch(jar, current, { ...init, method, body });
    lastRes = res;

    if (REDIRECT_CODES.has(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { res, url: current };
      await res.arrayBuffer().catch(() => {});
      current = new URL(loc, current).toString();
      if (res.status === 303 || method === "POST") {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { res, url: current };
  }
  return { res: lastRes, url: current };
}

/* ------------------------------------------------------------------ */
/* CAS 登录                                                            */
/* ------------------------------------------------------------------ */

function extractExecution(html) {
  const anchor = html.indexOf('id="fm1"');
  const scope = anchor >= 0 ? html.slice(anchor) : html;
  const re = /name="execution"[\s\S]{0,120}?value="([^"]+)"/;
  const m = scope.match(re) || html.match(re);
  return m ? m[1] : null;
}

function extractCasError(html) {
  const patterns = [
    /<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*id="msg"[^>]*>([\s\S]*?)<\/span>/i,
    /<p[^>]*class="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * 用学工号 + 校园卡密码走学校 CAS 登录，成功后 jar 中会带上云打印会话 Cookie。
 * @returns {Promise<object>} 用户信息
 */
export async function loginWithPassword(jar, username, password, origin = DEFAULT_ORIGIN) {
  if (!username || !password) throw new Error("请填写学工号与密码");

  // 1) 拿统一认证地址
  const ssoRes = await rawFetch(
    jar,
    `${origin}/api/client/Auth/SSoPage?backurl=${encodeURIComponent(origin + "/client/new/cprintPc/help.html")}`,
  );
  let ssoUrl;
  try {
    ssoUrl = (await ssoRes.json())?.result;
  } catch {
    throw new Error("云打印服务无响应（SSoPage 返回异常）");
  }
  if (!ssoUrl) throw new Error("无法获取统一认证地址");

  // 2) 跳到 CAS 登录页
  const { res: casRes, url: casUrl } = await follow(jar, ssoUrl);
  const casHtml = await casRes.text();
  const execution = extractExecution(casHtml);
  if (!execution) throw new Error("未找到 CAS execution 令牌（登录页结构可能已变更）");

  // 3) 提交账号密码
  const form = new URLSearchParams({
    username,
    password,
    execution,
    _eventId: "submit",
    geolocation: "",
  });

  const casOrigin = new URL(casUrl).origin;
  const { res: afterRes, url: afterUrl } = await follow(jar, casUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: casUrl,
      origin: casOrigin,
    },
    body: form.toString(),
  });

  // 4) 仍然停在登录页 => 凭据被拒
  if (/\/cas\/login/.test(afterUrl)) {
    const html = await afterRes.text().catch(() => "");
    if (/name="execution"/.test(html)) {
      throw new Error(extractCasError(html) || "学工号或密码错误");
    }
  } else {
    await afterRes.arrayBuffer().catch(() => {});
  }

  if (!jar.hasSessionCookie()) {
    throw new Error("登录未取得会话，请稍后重试");
  }

  // 5) 校验会话
  const me = await apiJson(jar, origin, "POST", "/api/client/Auth/Check");
  if (me?.code !== 0) {
    throw new Error(me?.message || "会话校验失败");
  }
  return me.result;
}

/* ------------------------------------------------------------------ */
/* API 调用                                                            */
/* ------------------------------------------------------------------ */

/** 调用云打印 JSON 接口；code !== 0 时抛出带 message 的错误。 */
export async function apiJson(jar, origin, method, path, body, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  let payload;
  if (body !== undefined && body !== null) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await rawFetch(jar, `${origin}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口 ${path} 返回非 JSON（HTTP ${res.status}）`);
  }
  return json;
}

export { DEFAULT_ORIGIN };

/* ------------------------------------------------------------------ */
/* 使用记录                                                            */
/* ------------------------------------------------------------------ */

/**
 * 记录接口的路径。
 *
 * 2026-09 前后上游把 DetailPageEx 改名成了 DetailPage：
 * 旧路径现在稳定返回 ASP.NET 的 404
 * （"No HTTP resource was found that matches the request URI ..."）。
 * 这里两个都试，谁 code=0 用谁，免得学校哪天又改回去。
 */
const REPORT_PATHS = ["/api/client/Report/DetailPage", "/api/client/Report/DetailPageEx"];

/**
 * 把一条记录规整成前端好用的形状。
 *
 * 新接口相对旧接口有三处变化，都得兼容：
 *   1. 多了 dwDate（YYYYMMDD）；dwTime 不再是 Unix 秒，而是 HHMMSS
 *   2. dwType 变成位掩码（实测 131073 = 0x20001），低 16 位才是类型
 *   3. 不再返回 szDocName（文档名）——界面上不能再指望这个字段
 */
function normalizeHistoryRow(r) {
  const rawType = Number(r.dwType) || 0;
  // 旧接口直接给 1/2/3；新接口是 0x20001 这种，取低 16 位
  const type = rawType > 0xffff ? rawType & 0xffff : rawType;

  const date = /^\d{8}$/.test(String(r.dwDate ?? "")) ? String(r.dwDate) : "";
  const time = String(r.dwTime ?? "").padStart(6, "0");

  let timestamp = 0;
  if (Number(r.dwTime) > 1e9) {
    // 旧接口：dwTime 本身就是 Unix 秒
    timestamp = Number(r.dwTime);
  } else if (date) {
    const d = new Date(
      Number(date.slice(0, 4)),
      Number(date.slice(4, 6)) - 1,
      Number(date.slice(6, 8)),
      Number(time.slice(0, 2)) || 0,
      Number(time.slice(2, 4)) || 0,
      Number(time.slice(4, 6)) || 0,
    );
    timestamp = Math.floor(d.getTime() / 1000);
  }

  return { ...r, dwType: type, dwTypeRaw: rawType, dwDate: date, dwTime: time, dwTimestamp: timestamp };
}

/**
 * 分页拉取使用记录。
 *
 * 服务端每页固定 5 条，必须翻页。
 *
 * 注意：**不要再按 dwType 分三次请求**。新接口已经不认这个过滤参数了，
 * 分三次只会把同一批记录拿回来三遍，补贴直接算成三倍（实测 21.10 被算成 42.20）。
 * 正确做法是拉一次全部，用 dwSID 去重，类型筛选放到前端做。
 */
export async function fetchAllHistory(jar, origin, { begin, end } = {}) {
  let chosen = null;
  let first = null;

  for (const path of REPORT_PATHS) {
    try {
      const probe = await apiJson(jar, origin, "POST", path, {
        dwBeginDate: begin,
        dwEndDate: end,
        dwPageNo: 1,
        dwRowCount: 5,
      });
      if (probe?.code === 0) {
        chosen = path;
        first = probe;
        break;
      }
    } catch {
      /* 换下一个路径 */
    }
  }

  if (!chosen) return { rows: [], scanned: 0, endpoint: null };

  /** @type {Map<number, object>} */
  const seen = new Map();
  const collect = (json) => {
    for (const r of json?.result || []) {
      if (r && r.dwSID != null && !seen.has(r.dwSID)) {
        seen.set(r.dwSID, normalizeHistoryRow(r));
      }
    }
  };

  collect(first);

  const totalPages = Math.min(Number(first.dwTotalPage) || 1, 200);
  for (let page = 2; page <= totalPages; page++) {
    try {
      const json = await apiJson(jar, origin, "POST", chosen, {
        dwBeginDate: begin,
        dwEndDate: end,
        dwPageNo: page,
        dwRowCount: 5,
      });
      if (json?.code !== 0) break;
      collect(json);
      if (!(json.result || []).length) break;
    } catch {
      break;
    }
  }

  const rows = [...seen.values()].sort(
    (a, b) => (b.dwTimestamp || 0) - (a.dwTimestamp || 0),
  );
  return { rows, scanned: rows.length, endpoint: chosen };
}
