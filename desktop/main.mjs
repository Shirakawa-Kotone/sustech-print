// Electron 主进程：桌面壳。
//
// 职责：
//   1. 在本进程内启动那个零依赖的 Node 服务（随机端口，只监听 127.0.0.1）
//   2. 开一个窗口指向它——这就是"webview 套壳"，前端一行没改就跑在桌面里了
//   3. 用系统加密存储保存密码（lib/secret.mjs），并把凭据交给服务端做会话自动续期
//   4. 盯着 spool 目录，把虚拟打印机落盘的 PDF 提交进队列
//   5. 托盘常驻：关窗口不退出，否则驱动就没人接活了
//
// ── 内存是怎么省的（这是本文件现在最需要注意的部分）────────────────────────
//
// 之前这里是一套"关窗口只 hide、开机自启、托盘常驻"的写法，实测常驻 587 MB
// （主进程 210 + 渲染 217 + GPU 108 + 工具 52）。现在改成**按需存在**：
//
//   - 窗口在关闭时 destroy 而不是 hide，渲染进程和 GPU 进程直接还给系统；
//     下次从托盘/图标打开时重建。代价是重新打开要几百毫秒，换来的是 ~325 MB。
//   - 把窗口收起来之后整段时间没有任何活动，就在 IDLE_EXIT_MS 之后**整个退出**，
//     常驻变成 0。用户再次打开走图标，打印则走系统唤醒（见 desktop/worker.mjs）。
//   - 所以「开机自动启动」这件事没有意义了，这里会把它关掉（含清掉老版本留下的
//     登录项），不再提供这个开关。
//
// 打印链路在没有本进程时怎么活：macOS 由 LaunchAgent 的 WatchPaths、Windows 由
// 计划任务把**无头工作进程**（worker.mjs，纯 node，54 MB，干完就退）叫起来。
// 见 installLaunchAgent() 和 driver/windows/install-wake.ps1。

import { mkdirSync } from "node:fs";
import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  nativeImage,
  shell,
} from "electron";

import {
  CONFIG_DIR,
  DRIVER_LOG_FILE,
  PRINTER_NAME,
  SYSTEM_SPOOL_DIR,
  ensureDirs,
} from "../lib/paths.mjs";
import * as credentials from "./credentials.mjs";
import { SpoolWatcher } from "./spool-watcher.mjs";

// 让 Electron 的 userData 目录和驱动用的 CONFIG_DIR 保持一致，
// 这样 credentials 和 driver-token 躺在一起，排查问题只看一个地方 ——
// 而且两者都在用户自己的 %LOCALAPPDATA% 下，不会出现"文件属于别人、自己改不动"。
//
// setPath 要求目录先存在，所以这里同步建出来（异步的 ensureDirs 在 whenReady 里）。
app.setName("SUSTechPrint");
mkdirSync(CONFIG_DIR, { recursive: true });
app.setPath("userData", CONFIG_DIR);

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = join(__dirname, "assets");

/**
 * 截图模式（SUSTECH_SHOT=<目录>）：只出图，而且**绝不显示窗口**。
 *
 * 早先这里会 show() + focus()，结果每跑一次就往桌面上弹一个抢焦点的窗口，
 * 连着跑几次非常像"程序崩了"。截图根本不需要可见窗口——保持隐藏即可，
 * 配合 backgroundThrottling:false，capturePage 照样能拿到真实帧。
 */
const SHOT_MODE = Boolean(process.env.SUSTECH_SHOT);

/**
 * 关掉窗口之后，再空闲这么久就整个退出。
 *
 * 5 分钟是个折中：短于此，用户"关掉又马上打开"会反复冷启动；长于此，
 * 那段"其实什么都没干"的常驻内存就白占着。开发/测试可以用
 * SUSTECH_IDLE_EXIT_MS 覆盖（0 表示永远不自动退出）。
 */
const IDLE_EXIT_MS = Number(
  process.env.SUSTECH_IDLE_EXIT_MS ?? 5 * 60_000,
);
/** 多久检查一次空闲。 */
const IDLE_CHECK_MS = 10_000;

/** 把空闲阈值说成人话（测试时经常设成几秒，别显示成 0.0833 分钟）。 */
const IDLE_LABEL =
  IDLE_EXIT_MS >= 60_000
    ? `${Math.round(IDLE_EXIT_MS / 60_000)} 分钟`
    : `${Math.round(IDLE_EXIT_MS / 1000)} 秒`;

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
/** @type {SpoolWatcher|null} */
let watcher = null;
let serverInfo = null;
let driverToken = "";
let quitting = false;
/** 供渲染进程读取的"驱动令牌"，只在主进程和服务端之间流转。 */
let serverModule = null;
/** 最后一次"有事发生"的时刻，空闲退出看的是它。 */
let lastActivity = Date.now();

function touch() {
  lastActivity = Date.now();
}

/* ------------------------------------------------------------------ 日志 --- */

const logLines = [];
async function log(message, level = "info") {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  if (level === "error") console.error(line);
  else console.log(line);
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await appendFile(DRIVER_LOG_FILE, line + "\n");
  } catch {
    /* 日志写不进去不该影响主流程 */
  }
}

/** 跑一个命令，只关心成功与否。 */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/* ------------------------------------------------------------ 本地服务 --- */

async function bootServer() {
  // 开发便利：指向外部服务（例如 tools/mock-server.mjs 的假数据），
  // 这样出门不在校园网也能调界面。
  const external = process.env.SUSTECH_SERVER_URL;
  if (external) {
    const u = new URL(external);
    serverInfo = { url: external, port: Number(u.port || 80), host: u.hostname };
    await log(`[dev] 使用外部服务：${external}`);
    return serverInfo;
  }

  // port 0 => 由系统挑一个空闲端口
  const mod = await import("../server.mjs");
  serverModule = mod;
  serverInfo = await mod.startServer({ port: 0, host: "127.0.0.1" });
  await log(`本地服务已启动：${serverInfo.url}`);

  // 驱动令牌：主进程读出来交给 spool 监听器，同时渲染进程也能查到状态
  try {
    const { loadOrCreateDriverToken } = await import("../lib/store.mjs");
    driverToken = await loadOrCreateDriverToken();
  } catch (err) {
    await log(`读取驱动令牌失败：${err.message}`, "error");
  }
  return serverInfo;
}

/**
 * 把已保存的凭据交给服务端，用于会话过期后自动重登。
 *
 * 传的是**函数**而不是当场读出来的对象：读系统加密存储是有成本的
 * （Windows 上要起一次 PowerShell），而会话还好好的时候根本用不着它。
 * 服务端只在真的要重登时才调用它 —— 见 server.mjs 的 tryRelogin。
 */
async function armCredential() {
  if (!serverModule) return false;
  serverModule.setRememberedCredential(async () => {
    const saved = await credentials.load();
    if (saved?.username) {
      await log(`已加载本机保存的凭据（${saved.username}），会话失效时会自动重登`);
    }
    return saved;
  });
  return true;
}

/* ------------------------------------------------- 开机自启（已废弃）------- */

/**
 * 把老版本登记的「开机自动启动」清掉。
 *
 * 为什么要主动清：以前 App 必须常驻才能接住驱动的作业，所以默认开了自启；
 * 现在打印由系统按需唤醒（worker.mjs），自启只会让用户登录后白白常驻一份
 * 几百兆的 Electron。老用户升级上来时登录项还在，不清掉就等于没改。
 *
 * 只做一次。做完写个标记，之后再也不碰用户的登录项 —— 万一他真有别的用途，
 * 我们不该每次启动都去关一遍。
 */
async function removeLegacyAutostart() {
  if (!app.isPackaged) return; // 开发时不要去动用户自己的登录项
  const done = join(CONFIG_DIR, "autostart-disabled");
  try {
    await access(done);
    return;
  } catch {
    /* 还没做过 */
  }

  try {
    // Windows 上 Electron 是按「path + args」逐字匹配登录项的，老版本登记时带了
    // --hidden，所以两种写法都要清一遍，否则会漏掉那条。
    if (app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: false });
      await log("已关闭旧版本设置的「开机自动启动」：现在改为打印时按需唤醒，不再需要常驻");
    }
    if (process.platform === "win32") {
      if (app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: false, args: ["--hidden"] });
        await log("已关闭旧版本设置的「开机自动启动」（带 --hidden 的那条）");
      }
    }
  } catch (err) {
    await log(`清理旧的开机自启项失败（不影响使用）：${err.message}`, "error");
  }

  try {
    await writeFile(done, `${new Date().toISOString()}\n`);
  } catch {
    /* 标记写不进去只会导致下次再做一遍，无害 */
  }
}

/* --------------------------------------------------- macOS 按需唤醒 --- */

/** LaunchAgent 的 label，卸载/重装都靠它定位。 */
const LAUNCH_AGENT_LABEL = "cn.edu.sustech.print.watch";

/**
 * 在 ~/Library/LaunchAgents 里装一个"打印时把无头进程叫起来"的 agent。
 *
 * 用 launchd 的 WatchPaths 盯着 CUPS backend 的落盘目录：目录一有动静，
 * launchd 就把 worker.mjs 拉起来（**以纯 node 方式**，见
 * EnvironmentVariables 里的 ELECTRON_RUN_AS_NODE）。它平时不占任何内存，
 * 而且延迟是毫秒级的 —— 比轮询计划任务好得多。
 *
 * 为什么每次启动都重写一遍：用户可能把 App 拖到别的位置，或者升级换了版本号，
 * 那 plist 里的绝对路径就过期了。这里顺手做自愈。内容没变时不会去动 launchd。
 *
 * 驱动没装（没有共享 spool 目录）时跳过：WatchPaths 指向一个不存在的路径不会触发，
 * 装了也没用，还平白在 launchd 里留个报错的东西。
 */
async function installLaunchAgent() {
  if (process.platform !== "darwin" || SHOT_MODE) return;
  // 开发时 process.execPath 指向 node_modules 里的 electron，写进去就废了
  if (!app.isPackaged) return;

  const plistPath = join(app.getPath("home"), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;

  // 驱动没装（没有共享 spool 目录）就不该留着这个 agent：WatchPaths 指向一个
  // 不存在的路径永远不会触发，只会在 launchd 里留个反复报错的条目。
  // 用户把驱动卸了之后，下次打开客户端就会走到这里，顺手把上一个版本留下的清掉。
  let hasSpool = true;
  try {
    await access(SYSTEM_SPOOL_DIR);
  } catch {
    hasSpool = false;
  }
  if (!hasSpool) {
    try {
      await access(plistPath);
    } catch {
      return; // 既没驱动也没 agent，什么都不用做
    }
    await run("/bin/launchctl", ["bootout", domain, plistPath]);
    await rm(plistPath, { force: true });
    await log("macOS 驱动已不在，已撤掉按需唤醒配置");
    return;
  }

  const exe = process.execPath; // .../南科大云打印.app/Contents/MacOS/南科大云打印
  const worker = join(__dirname, "..", "..", "app.asar", "desktop", "worker.mjs");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe}</string>
    <string>${worker}</string>
    <string>--wake</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>WatchPaths</key>
  <array>
    <string>${SYSTEM_SPOOL_DIR}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;

  let existing = null;
  try {
    existing = await readFile(plistPath, "utf8");
  } catch {
    /* 还没装过 */
  }

  try {
    await mkdir(join(app.getPath("home"), "Library", "LaunchAgents"), { recursive: true });
    if (existing === plist) return; // 一模一样就别去打扰 launchd
    await writeFile(plistPath, plist);
  } catch (err) {
    await log(`写入按需唤醒配置失败（不影响界面使用）：${err.message}`, "error");
    return;
  }

  // 先 bootout 再 bootstrap：已经加载过时 bootstrap 会报 EIO，bootout 让它变成幂等
  await run("/bin/launchctl", ["bootout", domain, plistPath]);
  const ok = await run("/bin/launchctl", ["bootstrap", domain, plistPath]);
  if (ok) {
    await log("已启用按需唤醒：打印时会自动把上传进程叫起来，平时不占内存");
  } else {
    // 老系统上没有 bootstrap，退回 load
    const legacyOk = await run("/bin/launchctl", ["load", "-w", plistPath]);
    await log(
      legacyOk
        ? "已启用按需唤醒（launchctl load）"
        : "启用按需唤醒失败：打印时不会自动上传，需要手动打开客户端",
      legacyOk ? "info" : "error",
    );
  }
}

/* ------------------------------------------------------------------ 窗口 --- */

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: "#f4f6fa",
    title: "南科大云打印",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 窗口被别的窗口挡住时 Chromium 会停止重绘，截图就会拿到旧帧
      backgroundThrottling: false,
    },
  });

  win.loadURL(serverInfo.url);

  win.once("ready-to-show", () => {
    // 截图模式保持隐藏：capturePage 不需要可见窗口，
    // 弹出来反而会抢焦点、看起来像"程序崩了"。
    if (SHOT_MODE) return;
    win?.show();
    touch();
    void log(`主窗口已显示（isVisible=${win?.isVisible() ?? "?"}）`);
    // macOS 上把标题栏按钮往下挪一点，和自制顶栏对齐
    if (process.platform === "darwin") win?.setWindowButtonPosition?.({ x: 16, y: 18 });
  });

  // 站内链接（比如扫描件下载）允许，站外的丢给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(serverInfo.url)) return { action: "allow" };
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(serverInfo.url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // 前端出问题时把控制台报错也写进日志，否则用户只会看到"页面空了"
  win.webContents.on("console-message", (...args) => {
    // Electron 新旧版本给这个事件的参数不一样，两种都兼容
    const details = args[1] && typeof args[1] === "object" ? args[1] : null;
    const level = details ? details.level : args[1];
    const message = details ? details.message : args[2];
    const line = details ? details.lineNumber : args[3];
    const source = details ? details.sourceId : args[4];
    const isError = level === "error" || level === 3 || level === 2;
    if (isError) void log(`[renderer] ${message} (${source}:${line})`, "error");
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    void log(`渲染进程崩溃：${JSON.stringify(details)}`, "error");
  });

  // 关窗口 = 把渲染进程真的还回去。
  //
  // 以前这里是 hide()：窗口看不见了，但整个 Vue 界面、GPU 进程都还活着，
  // 实测白占 325 MB。现在 destroy()，下次打开时重建 —— 本机页面，重开很快。
  // 主进程仍然活着（托盘 + spool 监听），空闲 IDLE_EXIT_MS 之后连它一起退。
  win.on("close", (event) => {
    if (quitting || SHOT_MODE) return;
    event.preventDefault();
    win?.destroy();
    if (process.platform === "darwin") app.dock?.hide?.();
    void log(`主窗口已关闭（渲染进程已释放，${IDLE_LABEL}无操作后整个退出）`);
  });

  win.on("closed", () => {
    win = null;
    touch();
  });
}

function showWindow() {
  touch();
  if (!win) {
    createWindow();
    return;
  }
  if (process.platform === "darwin") app.dock?.show?.();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ 托盘 --- */

function trayIcon() {
  // macOS 用模板图（纯黑 + alpha），跟随菜单栏深浅自动反色
  const file =
    process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const img = nativeImage.createFromPath(join(ASSETS, file));
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/**
 * 建托盘图标。
 *
 * 返回值很重要：托盘是窗口关掉之后**唯一**的入口，
 * 建不起来就意味着用户完全够不着这个程序，调用方需要据此把窗口显示出来。
 */
function createTray() {
  try {
    tray = new Tray(trayIcon());
  } catch (err) {
    void log(`托盘创建失败（不影响主功能）：${err.message}`, "error");
    return false;
  }

  const build = () =>
    Menu.buildFromTemplate([
      { label: "南科大云打印", enabled: false },
      { type: "separator" },
      { label: "打开主界面", click: showWindow },
      { type: "separator" },
      { label: "打开日志", click: () => shell.openPath(DRIVER_LOG_FILE).catch(() => {}) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);

  // 工具提示只写应用名：托盘提示不需要让人看到队列名之类的内部信息
  tray.setToolTip("南科大云打印");
  tray.setContextMenu(build());
  tray.on("click", showWindow);
  // 每次弹出前重建，保证菜单状态是最新的
  tray.on("right-click", () => tray?.setContextMenu(build()));
  return true;
}

/* ------------------------------------------------------------------- IPC --- */

function registerIpc() {
  ipcMain.handle("credentials:available", () => credentials.available());
  ipcMain.handle("credentials:backend", () => credentials.backend());

  ipcMain.handle("credentials:save", async (_e, credential) => {
    touch();
    const res = await credentials.save(credential);
    if (res.ok) {
      await armCredential();
      await log("已保存登录凭据（系统加密存储）");
    }
    return res;
  });

  ipcMain.handle("credentials:load", () => credentials.load());

  ipcMain.handle("credentials:clear", async () => {
    touch();
    await credentials.clear();
    serverModule?.setRememberedCredential(null);
    await log("已删除本机保存的凭据");
    return { ok: true };
  });

  ipcMain.handle("credentials:arm", async () => ({ ok: await armCredential() }));

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    printerName: PRINTER_NAME,
    serverUrl: serverInfo?.url ?? "",
    configDir: CONFIG_DIR,
    logFile: DRIVER_LOG_FILE,
  }));
}

/* ------------------------------------------------------------- 截图工具 --- */

/**
 * 逐个视图截图，给 UI 评审用。
 *
 * 只是为了出图，不参与正常流程：设置 SUSTECH_SHOT=<输出目录> 启动即可。
 * 未登录时只会截到登录页——那也是有意义的一张。
 */
async function captureScreenshots(dir) {
  const { writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await new Promise((r) => setTimeout(r, 2000));
  if (!win) return;

  const shoot = async (name) => {
    const image = await win.webContents.capturePage();
    const path = join(dir, `${name}.png`);
    await writeFile(path, image.toPNG());
    console.log(`[shot] ${path}`);
  };

  const loggedIn = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.sidebar-nav'))`,
  );

  if (!loggedIn) {
    await shoot("login");
    return;
  }

  const views = ["overview", "documents", "upload", "printers", "history", "settings"];

  // 全程不 show()/focus()：窗口保持隐藏，不打断用户
  for (let i = 0; i < views.length; i++) {
    const key = views[i];
    // 按序号点，不按文字——带角标的按钮 textContent 会多出数字来
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const btns = [...document.querySelectorAll('.sidebar-nav button')];
        if (!btns[${i}]) return { ok: false, count: btns.length };
        btns[${i}].click();
        return { ok: true, label: btns[${i}].textContent.trim() };
      })()
    `);
    // 等数据回来 + 过渡动画结束
    await new Promise((r) => setTimeout(r, 2400));

    // 确认真的换页了，并且等内容区域的文本稳定下来
    const probe = await win.webContents.executeJavaScript(`
      (async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const el = document.querySelector('.content-inner');
        const text = (el?.innerText ?? '').replace(/\\s+/g, ' ');
        let hash = 0;
        for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
        return {
          topbar: document.querySelector('.topbar h1')?.textContent?.trim() ?? '',
          chars: text.length,
          hash,
          found: Boolean(el),
          kids: el?.childElementCount ?? -1,
          html: (el?.innerHTML ?? '').slice(0, 240),
        };
      })()
    `);

    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    await writeFile(join(dir, `${key}.png`), png);

    // 空白画面说明没渲染出来，值得显式报出来而不是悄悄存一张废图
    const blank = png.length < 12000;
    console.log(
      `[shot] ${key}.png topbar=${JSON.stringify(probe.topbar)} chars=${probe.chars} ` +
        `bytes=${png.length}${blank ? "  <== 可能是空白图" : ""}`,
    );
  }
}

/* --------------------------------------------------------------- 空闲退出 --- */

/**
 * 没窗口、也没人打印，就整个退出。
 *
 * 这是"后台内存占用"的最终答案：不是把 Electron 减到多小，而是让它不存在。
 * 退出之后打印照样能用 —— 系统唤醒一个 54 MB 的纯 node 进程去上传，干完就退。
 */
function startIdleWatchdog() {
  if (SHOT_MODE || !(IDLE_EXIT_MS > 0)) return;

  setInterval(() => {
    if (quitting) return;
    if (win) {
      touch(); // 窗口开着就不算空闲
      return;
    }
    if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
    void (async () => {
      quitting = true;
      await log(
        `关掉窗口后已空闲 ${IDLE_LABEL}，退出以释放内存` +
          `（打印时会由系统自动唤醒，无需手动打开）`,
      );
      app.quit();
    })();
  }, IDLE_CHECK_MS);
}

/* ------------------------------------------------------------------ 启动 --- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 第二个实例：用户又点了一次图标。把已有窗口亮出来就行 ——
  // 打印走的是 worker.mjs（纯 node），根本不会走到这里，所以不会凭空弹窗。
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    await ensureDirs();
    await log("=== 南科大云打印启动 ===");

    try {
      await bootServer();
    } catch (err) {
      await log(`本地服务启动失败：${err.message}`, "error");
      // 服务起不来就没什么可显示的了，直接告诉用户
      const { dialog } = await import("electron");
      dialog.showErrorBox("启动失败", `无法启动本地服务：${err.message}`);
      app.quit();
      return;
    }

    // api-port 写不出去 => 打印机找不到本程序。界面还能用，但"打印"这条链路
    // 是断的，必须让用户知道，否则他会以为一切正常。
    if (serverInfo?.apiPortError) {
      await log(`写 api-port 失败：${serverInfo.apiPortError}`, "error");
      const { dialog } = await import("electron");
      dialog.showErrorBox(
        "虚拟打印机暂时不可用",
        "本程序无法写入配置文件，打印驱动将找不到它。\n\n" +
          `原因：${serverInfo.apiPortError}\n\n` +
          "通常是因为该目录下的文件属于其他用户或管理员。\n" +
          "重新运行安装包（以管理员身份）即可修复。",
      );
    }

    await armCredential();
    registerIpc();

    createWindow();
    const trayReady = createTray();

    watcher = new SpoolWatcher({
      onLog: (msg, level) => void log(msg, level),
      getDriverToken: () => driverToken,
      onJob: () => touch(),
    });
    await watcher.start();
    touch();

    // 后台把这些装好：它们不影响界面可用性，失败也只写日志
    if (await credentials.migrateIfNeeded()) {
      await log("已把旧版本保存的密码迁移到系统加密存储（不需要重新登录）");
    }
    await removeLegacyAutostart();
    await installLaunchAgent();
    startIdleWatchdog();

    // 托盘没建起来的话，窗口关掉之后用户就够不着这个程序了 —— 提一句
    if (!trayReady && !SHOT_MODE) {
      await log("托盘不可用：关闭窗口后请从桌面图标重新打开", "error");
    }

    // 截图模式：只为出 UI 图用（SUSTECH_SHOT=<目录>），正常启动不会走到
    if (process.env.SUSTECH_SHOT) {
      await captureScreenshots(process.env.SUSTECH_SHOT).catch((err) =>
        log(`截图失败：${err.message}`, "error"),
      );
      quitting = true;
      app.quit();
      return;
    }

    app.on("activate", showWindow);
  });

  // 窗口关掉不等于退出：托盘还在，驱动还要靠它接活（空闲了才会自己退）
  app.on("window-all-closed", () => {
    // macOS / Windows / Linux 都保持常驻到空闲退出
  });

  app.on("before-quit", () => {
    quitting = true;
    watcher?.stop();
  });
}
