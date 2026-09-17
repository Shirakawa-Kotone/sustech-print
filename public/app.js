// 南科大云打印 · 本地客户端 —— 前端应用（无框架）

import {
  clearVault,
  hasVault,
  loadVault,
  saveVault,
  vaultMeta,
} from "./vault.js";

/* ================================================================ 常量 == */

const SUBSIDY_DEFAULT = 100;

const COLOR_OPTIONS = [
  { value: 1, label: "黑白" },
  { value: 2, label: "彩色" },
];
const DUPLEX_OPTIONS = [
  { value: 1, label: "单面" },
  { value: 2, label: "双面长边" },
  { value: 3, label: "双面短边" },
];

/* ================================================================ 状态 == */

const state = {
  session: null,
  view: "overview",
  summary: null,
  jobs: [],
  scans: [],
  printers: [],
  history: [],
  papers: [],
  selectedJobs: new Set(),
  selectedScans: new Set(),
  search: "",
  printerFilter: "all",
  historyType: "all",
  historyDays: 365,
  queue: [],
  busy: false,
  docsBusy: false,
};

// 调试开关：localStorage.setItem('sustech-print.debug','1')
const DEBUG = localStorage.getItem("sustech-print.debug") === "1";
const log = (...args) => {
  if (DEBUG) console.log("[app]", ...args);
};

/* ================================================================ 工具 == */

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const money = (n) =>
  Number(n || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDate = (d) => {
  const s = String(d || "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

const fmtTime = (t) => {
  const s = String(t || 0).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
};

const fmtStamp = (unixSeconds) => {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtBytes = (b) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const extOf = (name) => {
  const m = String(name || "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "?";
};

const icon = (name) => {
  const paths = {
    overview: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
    docs: '<path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V8h4.5L13 3.5Z"/>',
    upload: '<path d="M12 3 6.5 8.5 8 10l3-3v9h2V7l3 3 1.5-1.5L12 3ZM4 19h16v2H4v-2Z"/>',
    printer: '<path d="M7 3h10v4H7V3Zm-3 6h16a2 2 0 0 1 2 2v6h-4v3H6v-3H2v-6a2 2 0 0 1 2-2Zm4 7v3h8v-3H8Z"/>',
    history: '<path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v3l4-4-4-4v3Zm-1 5v5l4 2 .8-1.7-3-1.5V8h-1.8Z"/>',
    settings:
      '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4a7.6 7.6 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.7 7.7 0 0 0-2-1.2L16.2 3h-4l-.4 2.7a7.7 7.7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.7 7.7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7.7 7.7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z"/>',
    trash: '<path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 12H7L6 9Z"/>',
    refresh:
      '<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/>',
    search: '<path d="M10 3a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 10 3Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"/>',
    logout:
      '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3Zm5.6 3.6L14.2 8l3 3H9v2h8.2l-3 3 1.4 1.4L21 12l-5.4-5.4Z"/>',
    download:
      '<path d="M12 3v10.2l3.3-3.3 1.4 1.4L12 17 6.3 11.3l1.4-1.4L11 13.2V3h1ZM4 19h16v2H4v-2Z"/>',
    sun: '<path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2v3h1v-3h-1Zm0-19v3h1V0h-1ZM4.2 5.6 2 3.4 3.4 2l2.2 2.2-1.4 1.4Zm14.2 14.2 2.2 2.2 1.4-1.4-2.2-2.2-1.4 1.4ZM0 12h3v1H0v-1Zm21 0h3v1h-3v-1ZM4.2 18.4 2 20.6 3.4 22l2.2-2.2-1.4-1.4ZM18.4 5.6 20.6 3.4 22 4.8l-2.2 2.2-1.4-1.4Z"/>',
    moon: '<path d="M12 3a9 9 0 1 0 9 9 9 9 0 0 1-9-9Z"/>',
    check: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/>',
    shield:
      '<path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm-1 14-3.5-3.5 1.4-1.4L11 13.2l5.1-5.1 1.4 1.4L11 16Z"/>',
    eye: '<path d="M12 5C6.5 5 2.7 9.6 1.5 12c1.2 2.4 5 7 10.5 7s9.3-4.6 10.5-7C21.3 9.6 17.5 5 12 5Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>',
    info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z"/>',
    empty:
      '<path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V8h4.5L13 3.5ZM8 12h8v2H8v-2Zm0 4h5v2H8v-2Z"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${paths[name] || ""}</svg>`;
};

/* ================================================================ 提示 == */

function toast(message, kind = "info", title = "") {
  let host = $(".toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<div><strong>${esc(title || (kind === "err" ? "出错了" : kind === "ok" ? "完成" : "提示"))}</strong><span>${esc(message)}</span></div>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "all .2s ease";
    setTimeout(() => el.remove(), 220);
  }, kind === "err" ? 5200 : 3200);
}

async function confirmDialog(title, body, confirmLabel = "确定") {
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = `
      <div class="modal">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body"><div>${esc(body)}</div></div>
        <div class="modal-foot">
          <button class="btn" data-no>取消</button>
          <button class="btn danger" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (v) => {
      bg.remove();
      resolve(v);
    };
    bg.addEventListener("click", (e) => {
      if (e.target === bg || e.target.closest("[data-no]")) close(false);
      if (e.target.closest("[data-yes]")) close(true);
    });
    document.body.appendChild(bg);
  });
}

/* ================================================================ API == */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务器返回异常（HTTP ${res.status}）`);
  }
  if (res.status === 401) {
    state.session = null;
    renderLogin("登录已过期，请重新登录");
    throw new Error(data.message || "未登录");
  }
  if (data && data.error) throw new Error(data.message || "请求失败");
  return data;
}

/* ================================================================ 主题 == */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sustech-print.theme", theme);
}

function initTheme() {
  const saved = localStorage.getItem("sustech-print.theme");
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

/* ================================================================ 登录页 == */

function renderLogin(notice = "") {
  const meta = vaultMeta();
  const hasSaved = hasVault();
  const app = $("#app");

  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">
          <div class="brand-mark">印</div>
          <h1>南科大云打印</h1>
          <p>本地客户端 · 更快、更顺手</p>
        </div>

        <div class="card card-pad">
          ${notice ? `<div class="note warn" style="margin-bottom:14px">${icon("info")}<span>${esc(notice)}</span></div>` : ""}
          ${
            hasSaved
              ? `<form class="login-form" id="unlock-form">
                   <div class="note">${icon("shield")}<span>本机已保存 <b>${esc(meta?.username || "")}</b> 的加密凭据，输入主密码即可自动登录。</span></div>
                   <div class="field">
                     <label for="master">主密码</label>
                     <input class="input" type="password" id="master" autocomplete="current-password" placeholder="用于解密本地凭据" required />
                   </div>
                   <button class="btn primary" type="submit" style="justify-content:center">解锁并登录</button>
                   <button class="btn ghost" type="button" id="use-password" style="justify-content:center">改用学工号 / 密码</button>
                 </form>`
              : ""
          }

          <form class="login-form" id="login-form" style="${hasSaved ? "display:none" : ""}">
            <div class="field">
              <label for="username">学工号</label>
              <input class="input" id="username" autocomplete="username" placeholder="例如 12345678" required />
            </div>
            <div class="field">
              <label for="password">校园卡密码</label>
              <input class="input" type="password" id="password" autocomplete="current-password" required />
            </div>
            <label class="check"><input type="checkbox" id="remember" /> 加密保存在本机（下次免输）</label>
            <div class="field" id="master-field" style="display:none">
              <label for="master2">设置主密码</label>
              <input class="input" type="password" id="master2" autocomplete="new-password" placeholder="用来加密你的密码，请牢记" />
              <div class="stat-foot">主密码不会保存；忘记它只能重新输入账号密码。</div>
            </div>
            <button class="btn primary" type="submit" style="justify-content:center">登录</button>
          </form>

          <div class="note warn" style="margin-top:14px">
            ${icon("info")}
            <span>凭据通过学校 CAS 统一认证提交，仅保存在这台电脑上，不会上传到任何第三方服务器。</span>
          </div>
        </div>
      </div>
    </div>`;

  $("#use-password")?.addEventListener("click", () => {
    $("#unlock-form").style.display = "none";
    $("#login-form").style.display = "";
  });

  $("#remember")?.addEventListener("change", (e) => {
    $("#master-field").style.display = e.target.checked ? "" : "none";
  });

  $("#unlock-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#unlock-form button[type=submit]");
    btn.disabled = true;
    btn.textContent = "正在登录…";
    try {
      const creds = await loadVault($("#master").value);
      await doLogin(creds.username, creds.password, null);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = "解锁并登录";
    }
  });

  $("#login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-form button[type=submit]");
    const username = $("#username").value.trim();
    const password = $("#password").value;
    const remember = $("#remember").checked;
    const master = $("#master2").value;

    if (remember && master.length < 8) {
      return toast("主密码至少 8 位，建议用一句好记的话", "err");
    }
    btn.disabled = true;
    btn.textContent = "正在登录…";
    try {
      await doLogin(username, password, remember ? master : null);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = "登录";
    }
  });
}

async function doLogin(username, password, master) {
  await api("/api/login", { method: "POST", body: { username, password } });
  if (master) {
    try {
      await saveVault(master, { username, password });
    } catch (err) {
      toast(`已登录，但凭据保存失败：${err.message}`, "err");
    }
  }
  await boot();
}

/* ================================================================ 外壳 == */

function renderShell() {
  const user = state.session?.user || {};
  const nav = [
    ["overview", "总览", "overview"],
    ["documents", "文档", "docs", state.jobs.length + state.scans.length],
    ["upload", "上传", "upload"],
    ["printers", "打印点", "printer"],
    ["history", "历史", "history"],
    ["settings", "设置", "settings"],
  ];

  $("#app").innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">印</div>
          <div class="brand-text">
            <div class="brand-title">云打印</div>
            <div class="brand-sub">SUSTech · 本地版</div>
          </div>
        </div>
        <nav class="nav">
          ${nav
            .map(
              ([key, label, ic, pill]) => `
            <button class="nav-item ${state.view === key ? "active" : ""}" data-nav="${key}">
              ${icon(ic)}<span>${label}</span>
              ${pill ? `<em class="pill">${pill}</em>` : ""}
            </button>`,
            )
            .join("")}
        </nav>
        <div class="sidebar-foot">
          <div class="acct">
            <div class="avatar">${esc((user.trueName || "?").slice(0, 1))}</div>
            <div class="acct-text">
              <div class="acct-name">${esc(user.trueName || "")}</div>
              <div class="acct-id">${esc(user.logonName || "")}</div>
            </div>
            <button class="icon-btn" id="theme-btn" title="切换主题">${icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon")}</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <h1 id="view-title"></h1>
          <span class="sub" id="view-sub"></span>
          <div class="spacer"></div>
          <button class="btn sm" id="refresh-btn">${icon("refresh")}刷新</button>
        </div>
        <div class="view" id="view"></div>
      </main>
    </div>
    <div class="toasts"></div>`;

  $("#app").addEventListener("click", (e) => {
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn) return go(navBtn.dataset.nav);
  });
  $("#refresh-btn")?.addEventListener("click", () => refresh(true));
  $("#theme-btn")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    $("#theme-btn").innerHTML = icon(next === "dark" ? "sun" : "moon");
  });
}

const TITLES = {
  overview: ["总览", "账号、补贴与待办"],
  documents: ["文档", "待打印任务与扫描件"],
  upload: ["上传", "支持批量拖拽"],
  printers: ["打印点", "全校自助终端实时状态"],
  history: ["使用记录", "打印 / 复印 / 扫描明细"],
  settings: ["设置", "账号与本地凭据"],
};

function go(view) {
  state.view = view;
  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.classList.toggle("active", b.dataset.nav === view),
  );
  const [t, s] = TITLES[view] || ["", ""];
  $("#view-title").textContent = t;
  $("#view-sub").textContent = s;
  render();
}

/* ================================================================ 渲染 == */

function render() {
  const v = $("#view");
  if (!v) return;
  const map = {
    overview: viewOverview,
    documents: viewDocuments,
    upload: viewUpload,
    printers: viewPrinters,
    history: viewHistory,
    settings: viewSettings,
  };
  v.innerHTML = (map[state.view] || viewOverview)();
  bindView();
}

function loadingCard(text = "加载中…") {
  return `<div class="card"><div class="empty"><p>${esc(text)}</p></div></div>`;
}

/* ------------------------------------------------------------ 总览 --- */

function viewOverview() {
  const s = state.summary;
  if (!s) return loadingCard("正在读取账号信息…");

  const { subsidy, user, counts } = s;
  const pct = Math.max(0, Math.min(1, subsidy.remainingComputed / (subsidy.perYear || SUBSIDY_DEFAULT)));
  const R = 64;
  const C = 2 * Math.PI * R;
  const stationTotal = state.printers.length;
  const stationBusy = state.printers.filter((p) => !/空闲|Idle/i.test(p.status)).length;

  return `
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="card stat">
        <span class="stat-label">待打印</span>
        <span class="stat-value">${counts.pendingJobs}<small>份</small></span>
        <span class="stat-foot">在终端刷卡即可取</span>
      </div>
      <div class="card stat">
        <span class="stat-label">扫描件</span>
        <span class="stat-value">${counts.scans}<small>份</small></span>
        <span class="stat-foot">扫描到电脑的文件</span>
      </div>
      <div class="card stat">
        <span class="stat-label">本学年已打印</span>
        <span class="stat-value">${subsidy.pages}<small>页</small></span>
        <span class="stat-foot">共 ${subsidy.records} 条记录</span>
      </div>
      <div class="card stat">
        <span class="stat-label">自助终端</span>
        <span class="stat-value">${stationTotal - stationBusy}<small>/ ${stationTotal} 台空闲</small></span>
        <span class="stat-foot">${stationBusy} 台异常或忙碌</span>
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h2>打印补贴</h2><div class="spacer"></div>
          <span class="hint">每学年 ${subsidy.perYear} 元 · ${fmtDate(subsidy.academicYearStart)} 起算</span>
        </div>
        <div class="subsidy">
          <div class="ring">
            <svg width="148" height="148">
              <circle cx="74" cy="74" r="${R}" fill="none" stroke="var(--bg-sunken)" stroke-width="12"/>
              <circle cx="74" cy="74" r="${R}" fill="none" stroke="var(--accent)" stroke-width="12"
                      stroke-linecap="round" stroke-dasharray="${C}"
                      stroke-dashoffset="${C * (1 - pct)}"/>
            </svg>
            <div class="ring-center">
              <div class="ring-amount">¥${money(subsidy.remainingComputed)}</div>
              <div class="ring-cap">剩余补贴</div>
            </div>
          </div>
          <div class="subsidy-meta">
            <h3>${esc(user.trueName)}</h3>
            <p>本学年已用 <b>¥${money(subsidy.used)}</b>，占 ${(subsidy.used / (subsidy.perYear || 100) * 100).toFixed(1)}%</p>
            <div class="kv">
              <div>补贴额度 <b>¥${money(subsidy.perYear)}</b></div>
              <div>已用 <b>¥${money(subsidy.used)}</b></div>
              <div>自费 <b>¥${money(subsidy.paid)}</b></div>
            </div>
            <div class="stat-foot" style="margin-top:12px">
              由本学年 ${subsidy.records} 条使用记录算出，与系统值 ¥${money(subsidy.serverReported)} ${Math.abs(subsidy.remainingComputed - subsidy.serverReported) < 0.01 ? "一致 ✓" : "不一致 ⚠"}
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>快捷操作</h2></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:10px">
          <button class="btn primary" data-go="upload" style="justify-content:center">${icon("upload")}批量上传文档</button>
          <button class="btn" data-go="documents" style="justify-content:center">${icon("docs")}查看全部文档（${counts.pendingJobs + counts.scans}）</button>
          <button class="btn" data-go="printers" style="justify-content:center">${icon("printer")}找空闲打印机</button>
          <button class="btn" data-go="history" style="justify-content:center">${icon("history")}查看使用记录</button>
        </div>
      </div>
    </div>

    ${overviewPrinters()}
  `;
}

function overviewPrinters() {
  const list = state.printers.slice(0, 6);
  if (!list.length) return "";
  return `
    <div class="card">
      <div class="card-head"><h2>打印点状态</h2><div class="spacer"></div>
        <button class="btn sm ghost" data-go="printers">全部 ${state.printers.length} 台</button>
      </div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>名称</th><th>状态</th><th>驱动</th></tr></thead>
          <tbody>
            ${list
              .map(
                (p) => `<tr>
                  <td>${esc(p.name)}</td>
                  <td>${statusBadge(p.status)}</td>
                  <td class="mono">${esc(p.driver || "—")}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function statusBadge(status) {
  const raw = String(status || "").trim();
  const text = raw.split("-")[0].trim() || "未知";

  // 注意顺序：未知要显式判断，否则会掉到默认值被误显示成绿色「正常」
  let cls = "";
  if (!raw || /未知|unknown/i.test(raw)) cls = "warn";
  else if (/故障|无法|失去联系|离线|error|offline/i.test(raw)) cls = "danger";
  else if (/忙|busy|稍后/i.test(raw)) cls = "warn";
  else if (/空闲|idle/i.test(raw)) cls = "ok";

  return `<span class="badge ${cls}"><i class="dot"></i>${esc(text)}</span>`;
}

/* --------------------------------------------------------- 文档 --- */

function viewDocuments() {
  if (!state.jobs && !state.scans) return loadingCard();
  const q = state.search.trim().toLowerCase();
  const jobs = state.jobs.filter((j) => !q || String(j.szJobName || "").toLowerCase().includes(q));
  const scans = state.scans.filter((j) => {
    const n = j.szName || j.szJobName || j.szFileName || "";
    return !q || String(n).toLowerCase().includes(q);
  });
  const selJobs = state.selectedJobs;
  const selScans = state.selectedScans;

  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>待打印文档</h2>
        <span class="badge">${jobs.length}</span>
        <div class="spacer"></div>
        <div class="search" style="width:220px">${icon("search")}
          <input class="input" id="doc-search" placeholder="搜索文件名…" value="${esc(state.search)}" />
        </div>
        <button class="btn sm" id="refresh-docs" title="重新获取文档列表">
          ${icon("refresh")}刷新
        </button>
        <button class="btn sm danger" id="del-jobs" ${selJobs.size ? "" : "disabled"}>
          ${icon("trash")}删除所选${selJobs.size ? ` (${selJobs.size})` : ""}
        </button>
      </div>
      ${
        jobs.length
          ? `<div class="table-wrap"><table class="tbl">
              <thead><tr>
                <th style="width:38px"><input type="checkbox" id="sel-all-jobs" ${selJobs.size === jobs.length && jobs.length ? "checked" : ""}></th>
                <th>文件名</th><th>规格</th><th class="num">页数</th><th class="num">份数</th><th>提交时间</th>
              </tr></thead>
              <tbody>
                ${jobs
                  .map(
                    (j) => `<tr class="${selJobs.has(j.dwJobId) ? "selected" : ""}">
                      <td><input type="checkbox" data-job="${j.dwJobId}" ${selJobs.has(j.dwJobId) ? "checked" : ""}></td>
                      <td><div class="doc-name" title="${esc(j.szJobName)}">${esc(j.szJobName || "—")}</div></td>
                      <td>${esc(jobSpec(j))}</td>
                      <td class="num">${j.dwPages ?? 0}</td>
                      <td class="num">${j.dwCopies ?? 1}</td>
                      <td class="mono">${fmtDate(j.dwCreateDate)} ${fmtTime(j.dwCreateTime)}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : `<div class="empty">${icon("empty")}<p>没有待打印的文档</p></div>`
      }
    </div>

    <div class="card">
      <div class="card-head">
        <h2>扫描件</h2>
        <span class="badge">${scans.length}</span>
        <div class="spacer"></div>
        <button class="btn sm danger" id="del-scans" ${selScans.size ? "" : "disabled"}>
          ${icon("trash")}删除所选${selScans.size ? ` (${selScans.size})` : ""}
        </button>
      </div>
      ${
        scans.length
          ? `<div class="table-wrap"><table class="tbl">
              <thead><tr>
                <th style="width:38px"><input type="checkbox" id="sel-all-scans" ${selScans.size === scans.length && scans.length ? "checked" : ""}></th>
                <th>文件名</th><th class="num">页数</th><th>时间</th><th style="width:80px"></th>
              </tr></thead>
              <tbody>
                ${scans
                  .map(
                    (j) => `<tr class="${selScans.has(j.dwJobId) ? "selected" : ""}">
                      <td><input type="checkbox" data-scan="${j.dwJobId}" ${selScans.has(j.dwJobId) ? "checked" : ""}></td>
                      <td><div class="doc-name">${esc(j.szName || j.szJobName || j.szFileName || "扫描件")}</div></td>
                      <td class="num">${j.dwPages ?? "—"}</td>
                      <td class="mono">${fmtStamp(j.dwTime || j.dwCreateTime)}</td>
                      <td><a class="btn sm ghost" href="/api/scan-download?id=${encodeURIComponent(j.dwJobId)}">${icon("download")}下载</a></td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : `<div class="empty">${icon("empty")}<p>没有扫描件</p></div>`
      }
    </div>`;
}

function jobSpec(j) {
  const parts = [];
  try {
    const detail = JSON.parse(j.szPaperDetail || "[]");
    for (const d of detail) parts.push(paperName(d.dwPaperID));
  } catch {
    /* 忽略 */
  }
  const attr = String(j.szAttribe || "");
  if (attr.includes("single")) parts.push("单面");
  else if (attr.includes("double")) parts.push("双面");
  if (attr.includes("color")) parts.push("彩色");
  else parts.push("黑白");
  return parts.join(" · ") || "—";
}

function paperName(id) {
  const p = state.papers.find((x) => x.dwPaperID === id);
  if (p) return p.szPaperName;
  return { 8: "A3", 9: "A4", 123: "A0", 124: "A1" }[id] || `纸型${id}`;
}

/* --------------------------------------------------------- 上传 --- */

function viewUpload() {
  // 始终保留「不指定」，再补上系统支持的 A3/A4
  const papers = [
    { dwPaperID: -1, szPaperName: "不指定" },
    ...(state.papers.length
      ? state.papers.filter((p) => [8, 9].includes(p.dwPaperID))
      : [
          { dwPaperID: 9, szPaperName: "A4" },
          { dwPaperID: 8, szPaperName: "A3" },
        ]),
  ];

  return `
    <div class="grid cols-2" style="margin-bottom:16px;align-items:start">
      <div class="card">
        <div class="card-head"><h2>打印选项</h2><div class="spacer"></div><span class="hint">对本批全部文件生效</span></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:16px">
          <div class="field">
            <label>颜色</label>
            <div class="tag-row" data-opt="dwColor">
              ${COLOR_OPTIONS.map((o) => `<button class="chip ${o.value === 2 ? "active" : ""}" data-val="${o.value}">${o.label}</button>`).join("")}
            </div>
          </div>
          <div class="field">
            <label>纸型</label>
            <div class="tag-row" data-opt="dwPaperId">
              ${papers.map((p) => `<button class="chip ${p.szPaperName === "A4" ? "active" : ""}" data-val="${p.dwPaperID}">${esc(p.szPaperName)}</button>`).join("")}
            </div>
          </div>
          <div class="field">
            <label>单双面</label>
            <div class="tag-row" data-opt="dwDuplex">
              ${DUPLEX_OPTIONS.map((o) => `<button class="chip ${o.value === 1 ? "active" : ""}" data-val="${o.value}">${o.label}</button>`).join("")}
            </div>
          </div>
          <div class="field">
            <label for="copies">份数</label>
            <input class="input" type="number" id="copies" min="1" max="99" value="1" style="width:110px" />
          </div>
          <div class="note">${icon("info")}<span>“不指定”由打印终端按文档实际纸型处理；A4 最常用。</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>上传队列</h2><div class="spacer"></div>
          <span class="hint">${state.queue.filter((q) => q.status === "done").length} / ${state.queue.length} 完成</span>
        </div>
        <div class="card-pad">
          <div class="dropzone" id="dropzone">
            ${icon("upload")}
            <h3>拖拽文件到这里，或点击选择</h3>
            <p>支持 jpg / png / pdf / word / excel / ppt / txt，可一次选多个</p>
            <input type="file" id="file-input" multiple hidden
                   accept=".jpg,.jpeg,.png,.gif,.bmp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.wps" />
          </div>
        </div>
        ${
          state.queue.length
            ? `<div class="queue">${state.queue.map(queueRow).join("")}</div>
               <div class="card-pad" style="border-top:1px solid var(--border);display:flex;gap:9px">
                 <button class="btn" id="clear-queue">清空已完成</button>
                 <div class="spacer" style="flex:1"></div>
                 <button class="btn primary" id="retry-failed">重试失败项</button>
               </div>`
            : ""
        }
      </div>
    </div>`;
}

function queueRow(item) {
  const pct = item.progress ?? 0;
  const cls = item.status === "done" ? "done" : item.status === "error" ? "err" : "";
  const label = {
    waiting: "等待中",
    uploading: `上传中 ${pct}%`,
    processing: "服务器处理中…",
    retrying: item.message || "正在重试…",
    done: "已完成",
    error: item.message || "失败",
  }[item.status];

  return `
    <div class="qrow">
      <div class="qicon">${esc(extOf(item.file.name))}</div>
      <div class="qmain">
        <div class="qname" title="${esc(item.file.name)}">${esc(item.file.name)}</div>
        <div class="qmeta">${esc(fmtBytes(item.file.size))} · ${esc(label)}</div>
        <div class="qbar"><i class="${cls}" style="width:${item.status === "done" ? 100 : pct}%"></i></div>
      </div>
      ${
        item.status === "done"
          ? `<span class="badge ok">${icon("check")}</span>`
          : item.status === "error"
            ? `<span class="badge danger">失败</span>`
            : item.status === "retrying"
              ? `<span class="badge warn">重试 ${item.attempt || 1}/${MAX_ATTEMPTS}</span>`
              : `<span class="badge">${pct}%</span>`
      }
    </div>`;
}

/* ------------------------------------------------------- 打印点 --- */

function viewPrinters() {
  const q = state.search.trim().toLowerCase();
  let list = state.printers;
  if (state.printerFilter === "free") list = list.filter((p) => /空闲|idle/i.test(p.status));
  else if (state.printerFilter === "issue") list = list.filter((p) => !/空闲|idle/i.test(p.status));
  if (q) list = list.filter((p) => `${p.name} ${p.driver}`.toLowerCase().includes(q));

  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div class="seg" id="printer-filter">
          <button data-f="all" class="${state.printerFilter === "all" ? "active" : ""}">全部 ${state.printers.length}</button>
          <button data-f="free" class="${state.printerFilter === "free" ? "active" : ""}">空闲</button>
          <button data-f="issue" class="${state.printerFilter === "issue" ? "active" : ""}">异常 / 忙碌</button>
        </div>
        <div class="spacer"></div>
        <div class="search" style="width:240px">${icon("search")}
          <input class="input" id="printer-search" placeholder="搜索位置或机型…" value="${esc(state.search)}" />
        </div>
      </div>
    </div>
    ${
      list.length
        ? `<div class="printer-grid">
            ${list
              .map(
                (p) => `<div class="card printer">
                  <div class="printer-top">
                    <div style="flex:1;min-width:0">
                      <div class="printer-name">${esc(p.name)}</div>
                      <div class="printer-meta">${esc(p.ip || "")}</div>
                    </div>
                  </div>
                  <div class="printer-foot">
                    ${statusBadge(p.status)}
                    <span class="badge">${esc(paperName(p.tray1))}</span>
                  </div>
                  <div class="stat-foot" style="font-size:11.5px">${esc(p.driver || "")}</div>
                </div>`,
              )
              .join("")}
          </div>`
        : `<div class="card"><div class="empty">${icon("empty")}<p>没有匹配的打印点</p></div></div>`
    }`;
}

/* --------------------------------------------------------- 历史 --- */

function viewHistory() {
  const rows = state.history;
  const pages = rows.reduce((s, r) => s + (Number(r.dwPages) || 0), 0);
  const free = rows.reduce((s, r) => s + (Number(r.dwUsedFreeMoney) || 0), 0) / 100;
  const paid =
    rows.reduce((s, r) => s + (Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0), 0) / 100;

  return `
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="card stat"><span class="stat-label">记录数</span><span class="stat-value">${rows.length}</span></div>
      <div class="card stat"><span class="stat-label">总页数</span><span class="stat-value">${pages}<small>页</small></span></div>
      <div class="card stat"><span class="stat-label">补贴支付</span><span class="stat-value">¥${money(free)}</span></div>
      <div class="card stat"><span class="stat-label">自费</span><span class="stat-value">¥${money(paid)}</span></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>使用记录</h2>
        <div class="spacer"></div>
        <div class="seg" id="hist-type">
          <button data-t="all" class="${state.historyType === "all" ? "active" : ""}">全部</button>
          <button data-t="1" class="${state.historyType === "1" ? "active" : ""}">打印</button>
          <button data-t="3" class="${state.historyType === "3" ? "active" : ""}">复印</button>
          <button data-t="2" class="${state.historyType === "2" ? "active" : ""}">扫描</button>
        </div>
        <select class="input" id="hist-range" style="width:auto">
          <option value="30" ${state.historyDays === 30 ? "selected" : ""}>近 30 天</option>
          <option value="90" ${state.historyDays === 90 ? "selected" : ""}>近 90 天</option>
          <option value="365" ${state.historyDays === 365 ? "selected" : ""}>本学年</option>
          <option value="3650" ${state.historyDays === 3650 ? "selected" : ""}>全部</option>
        </select>
        <button class="btn sm" id="export-csv">${icon("download")}导出 CSV</button>
      </div>
      ${
        rows.length
          ? `<div class="table-wrap"><table class="tbl">
              <thead><tr>
                <th>时间</th><th>文件</th><th>规格</th><th class="num">页数</th>
                <th class="num">补贴</th><th class="num">自费</th><th>终端</th>
              </tr></thead>
              <tbody>
                ${rows
                  .map(
                    (r) => `<tr>
                      <td class="mono">${fmtStamp(r.dwTime)}</td>
                      <td><div class="doc-name" title="${esc(r.szDocName)}">${esc(r.szDocName || "—")}</div></td>
                      <td>${esc(paperName(r.dwPaperID))}</td>
                      <td class="num">${r.dwPages ?? 0}</td>
                      <td class="num">¥${money((Number(r.dwUsedFreeMoney) || 0) / 100)}</td>
                      <td class="num">¥${money(((Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0)) / 100)}</td>
                      <td class="mono">${esc(printerName(r.dwMFPSN))}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table></div>`
          : `<div class="empty">${icon("empty")}<p>该时间段没有记录</p></div>`
      }
    </div>`;
}

function printerName(id) {
  const p = state.printers.find((x) => x.id === id);
  return p ? p.name : `#${id}`;
}

/* --------------------------------------------------------- 设置 --- */

function viewSettings() {
  const s = state.summary;
  const meta = vaultMeta();
  return `
    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <div class="card-head"><h2>账号</h2></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          <div class="kv" style="flex-direction:column;gap:8px">
            <div>姓名 <b>${esc(s?.user.trueName || "")}</b></div>
            <div>学工号 <b>${esc(s?.user.logonName || "")}</b></div>
            <div>卡号 <b>${esc(s?.user.cardNo || "")}</b></div>
          </div>
          <button class="btn danger" id="logout-btn" style="justify-content:center;margin-top:4px">${icon("logout")}退出登录</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>本地凭据</h2></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          ${
            hasVault()
              ? `<div class="note">${icon("shield")}<span>已加密保存 <b>${esc(meta?.username || "")}</b> 的凭据（${meta?.updatedAt ? new Date(meta.updatedAt).toLocaleString("zh-CN") : ""}）。</span></div>
                 <button class="btn danger" id="clear-vault" style="justify-content:center">删除本地凭据</button>`
              : `<div class="note warn">${icon("info")}<span>未保存凭据，每次需要重新输入学工号与密码。</span></div>`
          }
        </div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <div class="card-head"><h2>补贴规则</h2></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:10px">
          <div class="kv">
            <div>每学年额度 <b>¥${money(s?.subsidy.perYear ?? SUBSIDY_DEFAULT)}</b></div>
            <div>学年起始 <b>${fmtDate(s?.subsidy.academicYearStart)}</b></div>
            <div>本学年已用 <b>¥${money(s?.subsidy.used)}</b></div>
            <div>剩余 <b>¥${money(s?.subsidy.remainingComputed)}</b></div>
          </div>
          <div class="stat-foot">剩余额度 = 学年额度 − 本学年记录中的补贴金额合计；可与系统返回的 ¥${money(s?.subsidy.serverReported)} 相互校验。</div>
        </div>
      </div>
    </div>`;
}

/* ================================================================ 交互 == */

function bindView() {
  const view = $("#view");
  if (!view) return;

  view.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => go(b.dataset.go)),
  );

  if (state.view === "documents") bindDocuments(view);
  if (state.view === "upload") bindUpload(view);
  if (state.view === "printers") bindPrinters(view);
  if (state.view === "history") bindHistory(view);
  if (state.view === "settings") bindSettings(view);
}

function bindDocuments(view) {
  const search = $("#doc-search");
  if (search) {
    search.addEventListener("input", (e) => {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = $("#doc-search");
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  view.querySelectorAll("[data-job]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.job);
      cb.checked ? state.selectedJobs.add(id) : state.selectedJobs.delete(id);
      cb.closest("tr").classList.toggle("selected", cb.checked);
      updateDeleteButtons();
    }),
  );
  view.querySelectorAll("[data-scan]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.scan);
      cb.checked ? state.selectedScans.add(id) : state.selectedScans.delete(id);
      cb.closest("tr").classList.toggle("selected", cb.checked);
      updateDeleteButtons();
    }),
  );

  $("#sel-all-jobs")?.addEventListener("change", (e) => {
    state.selectedJobs.clear();
    if (e.target.checked) state.jobs.forEach((j) => state.selectedJobs.add(j.dwJobId));
    render();
  });
  $("#sel-all-scans")?.addEventListener("change", (e) => {
    state.selectedScans.clear();
    if (e.target.checked) state.scans.forEach((j) => state.selectedScans.add(j.dwJobId));
    render();
  });

  $("#del-jobs")?.addEventListener("click", () => deleteJobs());
  $("#del-scans")?.addEventListener("click", () => deleteScans());
  $("#refresh-docs")?.addEventListener("click", (e) => refreshDocuments(e.currentTarget));
}

/** 只刷新「文档」页要的数据，顺带更新侧边栏计数。 */
async function refreshDocuments(btn) {
  if (state.docsBusy) return;
  state.docsBusy = true;
  btn?.classList.add("loading");
  const started = Date.now();
  try {
    const [jobs, scans] = await Promise.all([api("/api/jobs"), api("/api/scans")]);
    state.jobs = jobs.jobs || [];
    state.scans = scans.scans || [];

    // 丢掉已经被删掉的选中项
    const jobIds = new Set(state.jobs.map((j) => j.dwJobId));
    const scanIds = new Set(state.scans.map((j) => j.dwJobId));
    [...state.selectedJobs].forEach((id) => !jobIds.has(id) && state.selectedJobs.delete(id));
    [...state.selectedScans].forEach((id) => !scanIds.has(id) && state.selectedScans.delete(id));

    // 返回太快时也让转圈停一下，避免一闪而过看不清
    const elapsed = Date.now() - started;
    if (elapsed < 450) await new Promise((r) => setTimeout(r, 450 - elapsed));

    renderShellNav();
    render(); // 重建视图，按钮自然回到非加载态
  } catch (err) {
    const elapsed = Date.now() - started;
    if (elapsed < 450) await new Promise((r) => setTimeout(r, 450 - elapsed));
    toast(err.message, "err");
  } finally {
    state.docsBusy = false;
    btn?.classList.remove("loading");
  }
}

function updateDeleteButtons() {
  const jb = $("#del-jobs");
  if (jb) {
    jb.disabled = state.selectedJobs.size === 0;
    jb.innerHTML = `${icon("trash")}删除所选${state.selectedJobs.size ? ` (${state.selectedJobs.size})` : ""}`;
  }
  const sb = $("#del-scans");
  if (sb) {
    sb.disabled = state.selectedScans.size === 0;
    sb.innerHTML = `${icon("trash")}删除所选${state.selectedScans.size ? ` (${state.selectedScans.size})` : ""}`;
  }
}

async function deleteJobs() {
  const ids = [...state.selectedJobs];
  if (!ids.length) return;
  const ok = await confirmDialog("删除待打印文档", `确定删除选中的 ${ids.length} 份文档？此操作不可撤销。`, "删除");
  if (!ok) return;
  try {
    const r = await api("/api/jobs/delete", { method: "POST", body: { ids } });
    state.selectedJobs.clear();
    toast(`已删除 ${r.deleted} 份${r.failed ? `，${r.failed} 份失败` : ""}`, r.failed ? "info" : "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  }
}

async function deleteScans() {
  const ids = [...state.selectedScans];
  if (!ids.length) return;
  const ok = await confirmDialog("删除扫描件", `确定删除选中的 ${ids.length} 份扫描件？`, "删除");
  if (!ok) return;
  try {
    const r = await api("/api/scans/delete", { method: "POST", body: { ids } });
    state.selectedScans.clear();
    toast(`已删除 ${r.deleted} 份${r.failed ? `，${r.failed} 份失败` : ""}`, r.failed ? "info" : "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  }
}

function bindUpload(view) {
  const dz = $("#dropzone");
  const input = $("#file-input");

  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    addToQueue([...input.files]);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("over");
    }),
  );
  dz.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addToQueue(files);
  });

  view.querySelectorAll("[data-opt]").forEach((group) =>
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      group.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    }),
  );

  $("#clear-queue")?.addEventListener("click", () => {
    state.queue = state.queue.filter((q) => q.status !== "done");
    render();
  });
  $("#retry-failed")?.addEventListener("click", () => {
    state.queue.forEach((q) => {
      if (q.status === "error") {
        q.status = "waiting";
        q.progress = 0;
        q.message = "";
      }
    });
    render();
    pump();
  });
}

function currentOptions() {
  const read = (name) => {
    const el = document.querySelector(`[data-opt="${name}"] .chip.active`);
    return el ? Number(el.dataset.val) : null;
  };
  return {
    dwColor: read("dwColor") ?? 1,
    dwPaperId: read("dwPaperId") ?? 9,
    dwDuplex: read("dwDuplex") ?? 1,
    dwCopies: Math.max(1, Number($("#copies")?.value || 1)),
  };
}

function addToQueue(files) {
  const valid = files.filter((f) => f.size > 0);
  if (!valid.length) return;
  for (const f of valid) {
    state.queue.push({ file: f, status: "waiting", progress: 0, message: "" });
  }
  drainNotified = false;
  render();
  pump();
}

let activeUploads = 0;
let drainNotified = false;
const MAX_CONCURRENT = 3;

function pump() {
  while (activeUploads < MAX_CONCURRENT) {
    const next = state.queue.find((q) => q.status === "waiting");
    if (!next) break;
    activeUploads++;
    uploadOne(next).finally(() => {
      activeUploads--;
      pump();
    });
  }

  // 整批结束后刷新一次文档列表，否则「文档」页看不到刚传上去的文件
  const idle = activeUploads === 0 && !state.queue.some((q) => q.status === "waiting");
  log("pump", { activeUploads, idle, drainNotified, queue: state.queue.length });
  if (idle && !drainNotified && state.queue.length) {
    drainNotified = true;
    const done = state.queue.filter((q) => q.status === "done").length;
    const failed = state.queue.filter((q) => q.status === "error").length;
    toast(
      `${done} 份上传成功${failed ? `，${failed} 份失败` : ""}`,
      failed ? "info" : "ok",
      "上传完成",
    );
    // 上游打印队列有 1~2 秒的写入延迟，稍等再刷新，并补一次以免漏掉
    setTimeout(async () => {
      await refresh();
      await new Promise((r) => setTimeout(r, 1500));
      await refresh();
    }, 900);
  } else if (!idle) {
    drainNotified = false;
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [1500, 4000];

function uploadOne(item) {
  return attemptUpload(item, 0);
}

function attemptUpload(item, attempt) {
  return new Promise((resolve) => {
    const opts = currentOptions();
    const taskId = crypto.randomUUID();
    const form = new FormData();
    form.append("szPath", item.file, item.file.name);
    form.append("dwColor", opts.dwColor);
    form.append("dwPaperId", opts.dwPaperId);
    form.append("dwDuplex", opts.dwDuplex);
    form.append("dwFrom", 0);
    form.append("dwTo", 0);
    form.append("dwCopies", opts.dwCopies);
    form.append("taskId", taskId);
    form.append("BackURL", "result.html");

    item.attempt = attempt + 1;
    item.status = "uploading";
    item.progress = 0;
    item.message = "";
    paintQueue();

    // 决定：成功 / 重试 / 彻底失败
    const settle = (result) => {
      if (result.ok) {
        item.status = "done";
        item.progress = 100;
        item.message = "";
        paintQueue();
        resolve();
        return;
      }
      if (result.retryable && attempt < MAX_ATTEMPTS - 1) {
        const delay = RETRY_DELAYS[attempt] ?? 6000;
        item.status = "retrying";
        item.message = `${result.message} · ${Math.round(delay / 1000)}s 后重试（${attempt + 2}/${MAX_ATTEMPTS}）`;
        paintQueue();
        setTimeout(() => {
          attemptUpload(item, attempt + 1).then(resolve);
        }, delay);
        return;
      }
      item.status = "error";
      item.message = result.message || "上传失败";
      paintQueue();
      if (result.reason === "auth") {
        toast("登录状态已失效，请退出后重新登录", "err");
      }
      resolve();
    };

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("x-task-id", taskId);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(item.file.name));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        item.progress = Math.round((e.loaded / e.total) * 100);
        if (item.progress >= 100) item.status = "processing";
        paintQueue();
      }
    };

    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 非 JSON 响应 */
      }
      if (xhr.status === 200 && data.ok) {
        settle({ ok: true });
      } else if (xhr.status === 401) {
        settle({ ok: false, reason: "auth", message: "登录状态已失效，请重新登录" });
      } else {
        settle({
          ok: false,
          reason: data.reason || "error",
          retryable: !!data.retryable || xhr.status >= 500,
          message: data.message || `上传失败（HTTP ${xhr.status}）`,
        });
      }
    };

    xhr.onerror = () =>
      settle({ ok: false, reason: "network", retryable: true, message: "网络中断" });
    xhr.ontimeout = () =>
      settle({ ok: false, reason: "timeout", retryable: true, message: "上传超时" });

    xhr.send(form);
  });
}

function paintQueue() {
  const host = document.querySelector(".queue");
  if (!host) return;
  host.innerHTML = state.queue.map(queueRow).join("");
  const done = state.queue.filter((q) => q.status === "done").length;
  const hint = document.querySelector(".card-head .hint");
  if (hint && state.view === "upload") hint.textContent = `${done} / ${state.queue.length} 完成`;
}

function bindPrinters(view) {
  $("#printer-filter")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    state.printerFilter = b.dataset.f;
    render();
  });
  const s = $("#printer-search");
  if (s) {
    s.addEventListener("input", (e) => {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = $("#printer-search");
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }
}

function bindHistory(view) {
  $("#hist-type")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]");
    if (!b) return;
    state.historyType = b.dataset.t;
    loadHistory().then(render);
  });
  $("#hist-range")?.addEventListener("change", (e) => {
    state.historyDays = Number(e.target.value);
    loadHistory().then(render);
  });
  $("#export-csv")?.addEventListener("click", () => {
    if (!state.history.length) return toast("没有可导出的记录", "info");
    const head = ["时间", "文件", "纸型", "页数", "补贴(元)", "自费(元)", "终端"];
    const lines = state.history.map((r) =>
      [
        fmtStamp(r.dwTime),
        r.szDocName || "",
        paperName(r.dwPaperID),
        r.dwPages ?? 0,
        ((Number(r.dwUsedFreeMoney) || 0) / 100).toFixed(2),
        (((Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0)) / 100).toFixed(2),
        printerName(r.dwMFPSN),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const csv = "\uFEFF" + [head.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `云打印记录_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出 CSV", "ok");
  });
}

function bindSettings(view) {
  $("#logout-btn")?.addEventListener("click", async () => {
    const ok = await confirmDialog("退出登录", "将清除本机保存的登录会话。", "退出");
    if (!ok) return;
    await api("/api/logout", { method: "POST" }).catch(() => {});
    state.session = null;
    state.summary = null;
    state.jobs = [];
    state.scans = [];
    renderLogin();
  });

  $("#clear-vault")?.addEventListener("click", async () => {
    const ok = await confirmDialog("删除本地凭据", "删除后下次登录需要重新输入学工号和密码。", "删除");
    if (!ok) return;
    clearVault();
    toast("已删除本地凭据", "ok");
    render();
  });
}

/* ================================================================ 数据 == */

async function loadHistory() {
  const end = new Date();
  const begin = new Date(end.getTime() - state.historyDays * 86400_000);
  const stamp = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const types = state.historyType === "all" ? "1,2,3" : state.historyType;
  const data = await api(`/api/history?begin=${stamp(begin)}&end=${stamp(end)}&types=${types}`);
  state.history = data.rows || [];
}

async function refresh(showToast = false) {
  if (state.busy) {
    log("refresh skipped (busy)");
    return;
  }
  state.busy = true;
  const btn = $("#refresh-btn");
  if (btn) btn.disabled = true;
  try {
    const [summary, jobs, scans, printers, papers] = await Promise.all([
      api(`/api/summary${showToast ? "?fresh=1" : ""}`),
      api("/api/jobs"),
      api("/api/scans"),
      api("/api/printers"),
      api("/api/papers").catch(() => ({ papers: [] })),
    ]);
    state.summary = summary;
    state.jobs = jobs.jobs || [];
    state.scans = scans.scans || [];
    state.printers = printers.printers || [];
    state.papers = papers.papers || [];
    // summary 已经带了本学年的完整记录，无需再单独请求一次
    state.history = summary.history || [];
    log("refresh ok", {
      view: state.view,
      jobs: state.jobs.length,
      scans: state.scans.length,
      printers: state.printers.length,
      history: state.history.length,
    });

    // 清理已不存在的选中项
    const jobIds = new Set(state.jobs.map((j) => j.dwJobId));
    const scanIds = new Set(state.scans.map((j) => j.dwJobId));
    [...state.selectedJobs].forEach((id) => !jobIds.has(id) && state.selectedJobs.delete(id));
    [...state.selectedScans].forEach((id) => !scanIds.has(id) && state.selectedScans.delete(id));

    renderShellNav();
    render();
    if (showToast) toast("已刷新", "ok");
  } catch (err) {
    log("refresh failed", err.message);
    toast(err.message, "err");
  } finally {
    state.busy = false;
    if (btn) btn.disabled = false;
  }
}

/** 只更新侧边栏计数，避免整页重绘。 */
function renderShellNav() {
  const docBtn = document.querySelector('[data-nav="documents"]');
  if (!docBtn) return;
  const total = state.jobs.length + state.scans.length;
  let pill = docBtn.querySelector(".pill");
  if (total) {
    if (!pill) {
      pill = document.createElement("em");
      pill.className = "pill";
      docBtn.appendChild(pill);
    }
    pill.textContent = total;
  } else if (pill) {
    pill.remove();
  }
}

/* ================================================================ 启动 == */

async function boot() {
  const s = await api("/api/session");
  if (!s.loggedIn) {
    renderLogin();
    return;
  }
  state.session = s;
  renderShell();
  go("overview");
  await refresh();
}

async function main() {
  initTheme();
  try {
    await boot();
  } catch (err) {
    renderLogin(err.message);
  }
}

main();
