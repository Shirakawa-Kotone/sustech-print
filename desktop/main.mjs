// Electron 主进程：桌面壳。
//
// 职责：
//   1. 在本进程内启动那个零依赖的 Node 服务（随机端口，只监听 127.0.0.1）
//   2. 开一个窗口指向它——这就是"webview 套壳"，前端一行没改就跑在桌面里了
//   3. 用系统钥匙串保存密码（safeStorage），并把凭据交给服务端做会话自动续期
//   4. 盯着 spool 目录，把虚拟打印机落盘的 PDF 提交进队列
//   5. 托盘常驻：关窗口不退出，否则驱动就没人接活了

import { mkdirSync } from "node:fs";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

import { CONFIG_DIR, DRIVER_LOG_FILE, PRINTER_NAME, ensureDirs } from "../lib/paths.mjs";
import * as credentials from "./credentials.mjs";
import { SpoolWatcher } from "./spool-watcher.mjs";

// 让 Electron 的 userData 目录和驱动用的 CONFIG_DIR 保持一致，
// 这样 credentials.bin（加密后的密码）和 driver-token 躺在一起，
// 排查问题只看一个地方 —— 而且两者都在用户自己的 %LOCALAPPDATA% 下，
// 不会出现"文件属于别人、自己改不动"的权限问题。
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

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
/** @type {SpoolWatcher|null} */
let watcher = null;
let serverInfo = null;
let driverToken = "";
let quitting = false;
/** 这次启动只驻留托盘、不显示窗口（开机自启拉起来的情形）。 */
let startHidden = false;
/** 供渲染进程读取的"驱动令牌"，只在主进程和服务端之间流转。 */
let serverModule = null;

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

/** 把已保存的凭据交给服务端，用于会话过期后自动重登。 */
async function armCredential() {
  const saved = await credentials.load();
  if (saved?.username && serverModule) {
    serverModule.setRememberedCredential(saved);
    await log(`已加载本机保存的凭据（${saved.username}），会话失效时会自动重登`);
    return true;
  }
  if (serverModule) serverModule.setRememberedCredential(null);
  return false;
}

/* -------------------------------------------------------------- 开机自启 --- */

/**
 * 首次启动默认打开「开机自动启动」（仅 Windows、仅打包版）。
 *
 * 为什么需要这个默认值：虚拟打印机本质上只是一个"把作业写成 PDF"的端口，
 * PDF 得靠这个 App 去上传。App 没在跑，用户打印完就什么都不会发生。
 * Windows 安装包（build/installer.nsh）装完会把 App 拉起来一次，所以
 * 第一次运行时替用户把开关拨到 on 是合理的。
 *
 * 只做一次：写完标记就再也不碰，之后完全交给托盘菜单里的勾选项 ——
 * 用户自己关掉之后，我们不会下次启动又给他打开。
 *
 * 两个刻意的限制：
 *   - 只在 Windows 上做。macOS 的登录项在「系统设置 → 通用 → 登录项」里
 *     很显眼，默认改它属于另一个决定，等需要时再说。
 *   - 只在打包版里做。开发时 `electron .` 跑起来的是 node_modules 里的
 *     electron.exe，给它注册自启是纯粹的污染。
 */
const AUTOSTART_MARKER = join(CONFIG_DIR, "autostart-initialized");

/**
 * 开机自启时附加的命令行标记：带了它就只驻留托盘，不弹窗口。
 *
 * 为什么需要自己造一个：macOS 的 setLoginItemSettings 有 openAsHidden，
 * Windows **没有**，传了会被静静忽略 —— 结果就是每次开机都往屏幕中间
 * 弹一个窗口。想在 Windows 上做到"开机后安静地起在托盘里"，只能往登录项
 * 的命令行里塞一个参数，启动时再认回来。
 */
const HIDDEN_FLAG = "--hidden";

function loginItemArgs() {
  return process.platform === "win32" ? [HIDDEN_FLAG] : [];
}

/**
 * 读「开机自动启动」的当前状态。
 *
 * Windows 上 Electron 是拿注册表里的命令行跟 path + args 逐字比对的：
 * 不传 args 时它会用**当前进程**的命令行，于是"静默启动时勾选是开的、
 * 手动启动时又变成关的"。所以 get 和 set 必须传同一组 args。
 */
function readOpenAtLogin() {
  return process.platform === "win32"
    ? app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin
    : app.getLoginItemSettings().openAtLogin;
}

function writeOpenAtLogin(enabled) {
  const options = { openAtLogin: Boolean(enabled), openAsHidden: true };
  if (process.platform === "win32") options.args = loginItemArgs();
  app.setLoginItemSettings(options);
  return readOpenAtLogin();
}

/** 这次启动是不是登录项拉起来的 —— 是的话只进托盘，不显示窗口。 */
function startedHidden() {
  if (SHOT_MODE) return true;
  if (process.argv.includes(HIDDEN_FLAG)) return true;
  // macOS 由系统在登录项信息里告诉我们
  if (process.platform === "darwin") {
    return Boolean(app.getLoginItemSettings().wasOpenedAsHidden);
  }
  return false;
}

async function ensureAutostartDefault() {
  if (process.platform !== "win32" || !app.isPackaged) return;

  try {
    await access(AUTOSTART_MARKER);
    return; // 已经初始化过，尊重用户后来的选择
  } catch {
    /* 第一次启动，还没有标记 */
  }

  if (!readOpenAtLogin()) {
    writeOpenAtLogin(true);
    await log(`首次启动：已默认开启「开机自动启动」（静默标记 ${HIDDEN_FLAG}，可在托盘菜单里关掉）`);
  }

  try {
    await writeFile(AUTOSTART_MARKER, `${new Date().toISOString()}\n`);
  } catch {
    /* 标记写不进去只会导致下次再设一遍，不影响功能 */
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
    // 开机自启拉起来、以及截图模式下都保持隐藏：只驻留托盘，不弹窗、不抢焦点。
    // 窗口不 show 就不会有任务栏按钮，"没有窗口任务"就是这么来的。
    //
    // 这里把结论写进日志：从程序外面判断"窗口到底显示了没有"很不可靠
    // （进程是多进程的，窗口归主进程；远程/无桌面会话下枚举结果也会骗人），
    // 而这一行是自己报的，装完机器上出问题看日志就能定性。
    if (startHidden) {
      void log(
        `主窗口已就绪，但本次是隐藏启动（argv 含 ${HIDDEN_FLAG}）：` +
          `不进任务栏、不抢焦点（isVisible=${win?.isVisible() ?? "?"}）`,
      );
      return;
    }
    win?.show();
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

  // 关窗口 = 收进托盘。直接退出的话虚拟打印机就没人在盯了。
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
    if (process.platform === "darwin") app.dock?.hide?.();
  });

  win.on("closed", () => {
    win = null;
  });
}

function showWindow() {
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
 * 返回值很重要：静默启动（开机自启）时托盘是**唯一**的入口，
 * 建不起来就意味着用户完全够不着这个程序，调用方需要据此把窗口显示出来。
 */
function createTray() {
  try {
    tray = new Tray(trayIcon());
  } catch (err) {
    log(`托盘创建失败（不影响主功能）：${err.message}`, "error");
    return false;
  }

  const build = () =>
    Menu.buildFromTemplate([
      { label: "南科大云打印", enabled: false },
      { type: "separator" },
      { label: "打开主界面", click: showWindow },
      { type: "separator" },
      {
        label: "开机自动启动",
        type: "checkbox",
        checked: readOpenAtLogin(),
        click: (item) => {
          writeOpenAtLogin(item.checked);
        },
      },
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
  // 每次弹出前重建，保证"开机自启"的勾选状态是最新的
  tray.on("right-click", () => tray?.setContextMenu(build()));
  return true;
}

/* ------------------------------------------------------------------- IPC --- */

function registerIpc() {
  ipcMain.handle("credentials:available", () => credentials.available());
  ipcMain.handle("credentials:backend", () => credentials.backend());

  ipcMain.handle("credentials:save", async (_e, credential) => {
    const res = await credentials.save(credential);
    if (res.ok) {
      await armCredential();
      await log("已保存登录凭据（系统密钥加密）");
    }
    return res;
  });

  ipcMain.handle("credentials:load", () => credentials.load());

  ipcMain.handle("credentials:clear", async () => {
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
    openAtLogin: readOpenAtLogin(),
  }));

  ipcMain.handle("app:setOpenAtLogin", (_e, enabled) => {
    return { ok: true, openAtLogin: writeOpenAtLogin(enabled) };
  });
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

/* ------------------------------------------------------------------ 启动 --- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    await ensureDirs();
    await log("=== 南科大云打印启动 ===");
    await ensureAutostartDefault();

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

    // 开机自启拉起来时只进托盘。先算好，createWindow 里据此决定显不显示。
    startHidden = startedHidden();
    if (startHidden && !SHOT_MODE) await log("以静默方式启动（登录项），只驻留托盘，不显示窗口");

    createWindow();
    const trayReady = createTray();

    // 静默启动时托盘是唯一入口。托盘要是没建起来、窗口又不显示，
    // 用户就彻底够不着这个程序了 —— 宁可破例把窗口弹出来。
    if (!trayReady && startHidden && !SHOT_MODE) {
      await log("托盘不可用，改为显示主窗口（否则用户没有任何入口）", "error");
      startHidden = false;
      showWindow();
    }

    watcher = new SpoolWatcher({
      onLog: (msg, level) => void log(msg, level),
      getDriverToken: () => driverToken,
    });
    await watcher.start();

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

  // 窗口关掉不等于退出：托盘还在，驱动还要靠它上传
  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return;
    // Windows/Linux 上保持常驻；真要退出用托盘菜单
  });

  app.on("before-quit", () => {
    quitting = true;
    watcher?.stop();
  });
}
