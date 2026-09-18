// 无头工作进程：被系统唤醒 → 把 spool 里的作业传上去 → 退出。
//
// 它由系统按需拉起，不是常驻的：
//
//   macOS    LaunchAgent 的 WatchPaths 盯着 /var/spool/sustech-print/incoming，
//            目录一有动静 launchd 就起这个进程（见 driver/macos/cn.edu.sustech.print.watch.plist）
//   Windows  计划任务：打印事件日志（PrintService/Operational 307）触发 + 每分钟
//            兜底轮询，跑的是 driver/windows/wake.cmd，里面判断到 out.pdf 存在
//            才把我们叫起来（见 driver/windows/install-printer.ps1）
//
// 关键点：**它不跑 Electron**。启动方式是
//
//     ELECTRON_RUN_AS_NODE=1 <App 的可执行文件> <app.asar>/desktop/worker.mjs --wake
//
// 也就是拿 Electron 那个二进制当纯 node 用（实测 v24.21.0，RSS ≈ 54 MB，
// 没有 Chromium 进程）。为了一份 PDF 去启动一整个 Chromium 是没道理的 ——
// 那正是这个文件存在的理由。
//
// 因此这里**绝对不能 import "electron"**：那种模式下 electron 模块只是个字符串，
// 连 safeStorage 都拿不到。凭据一律走 lib/secret.mjs（钥匙串 / DPAPI）。

import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import {
  DRIVER_LOG_FILE,
  SPOOL_PROCESSING_DIR,
  WATCH_DIRS,
  ensureDirs,
  readApiPort,
} from "../lib/paths.mjs";
import { loadOrCreateDriverToken } from "../lib/store.mjs";
import * as secret from "../lib/secret.mjs";
import { startServer, stopServer, setRememberedCredential, ensureSession } from "../server.mjs";
import { SpoolWatcher } from "./spool-watcher.mjs";

/** 连续这么久没有新作业就认为干完了，可以退出。 */
const QUIET_MS = Number(process.env.SUSTECH_WORKER_QUIET_MS || 3000);
/**
 * 硬上限：万一有作业一直写不完（或者网络卡死），也不能永远赖着不走。
 *
 * 要明显大于"单个作业最坏耗时"：上传本身实测能到 50 秒（上游繁忙时更久），
 * 留 4 分钟足够跑完好几个作业，又不至于卡住了还一直占着。
 */
const MAX_MS = Number(process.env.SUSTECH_WORKER_MAX_MS || 240_000);
const TICK_MS = 250;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ 日志 --- */

async function log(message, level = "info") {
  const line = `${new Date().toISOString()} [worker] [${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
  try {
    await mkdir(dirname(DRIVER_LOG_FILE), { recursive: true });
    await appendFile(DRIVER_LOG_FILE, line + "\n");
  } catch {
    /* 日志写不进去不该影响主流程 */
  }
}

/* ---------------------------------------------------------------- 通知 --- */

/**
 * 给用户弹一条系统通知。
 *
 * 无头进程没有界面，出问题时如果不吭声，用户看到的就是"打印了但云打印队列里
 * 什么都没有"，只能靠翻日志 —— 那是最糟的一类问题。所以只要能弹就弹一条。
 *
 * 通知失败不算错：这只影响提示，不影响作业本身。
 */
async function notify(title, message) {
  try {
    if (process.platform === "darwin") {
      // 转义双引号，否则 AppleScript 会被消息内容截断
      const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await run("/usr/bin/osascript", [
        "-e",
        `display notification "${esc(message)}" with title "${esc(title)}"`,
      ]);
      return;
    }
    if (process.platform === "win32") {
      // 气泡提示得有个宿主进程撑着，所以让 PowerShell 自己睡几秒再退。
      //
      // 这里**刻意不 await**：等它就等于每次失败都白等 9 秒，而这 9 秒里
      // worker 自己的本地服务还开着，会把并发的唤醒误判成"客户端已经在运行"。
      // detached + unref 让它自己活着，worker 该退就退。
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        "$n.Visible = $true",
        `$n.ShowBalloonTip(8000, '${psQuote(title)}', '${psQuote(message)}', 'Info')`,
        "Start-Sleep -Seconds 9",
        "$n.Dispose()",
      ].join("; ");
      spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { stdio: "ignore", detached: true },
      ).unref();
    }
  } catch {
    /* 弹不出来就算了 */
  }
}

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

/* ------------------------------------------------------------ 谁在服务 --- */

/**
 * 已经有人（通常是用户正开着的客户端）在提供本地接口了吗？
 *
 * 用户的客户端开着的时候，它自己的 spool 监听也在干活。这里再起一个只会
 * 白烧一次进程，还可能在同一个文件上打架。探针用驱动令牌 + /api/driver/status：
 * 只有我们自己人会把 ok 置成 true，所以不会把"某个恰好占了这个端口的别的东西"
 * 误判成自己。
 *
 * api-port 文件在进程退出后**不会被删**，所以必须真的连一下，不能只看文件。
 */
async function someoneElseIsServing() {
  let token = "";
  try {
    token = await loadOrCreateDriverToken();
  } catch {
    return false;
  }
  const { port, host } = await readApiPort();
  try {
    const res = await fetch(`http://${host}:${port}/api/driver/status`, {
      headers: { "x-driver-token": token },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json?.ok === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ 有没有活干 --- */

/** 和 SpoolWatcher 认的文件类型保持一致。 */
const JOB_PATTERN = /\.(pdf|ps|prn)$/i;

/**
 * spool 里现在有东西要处理吗？
 *
 * 这个检查必须放在最前面、而且不能碰网络。原因：Windows 的兜底计划任务
 * 每分钟都会把我们叫起来一次（见 driver/windows/install-wake.ps1），
 * 如果每次都要起服务 + 调一次上游的 Auth/Check，那就是每分钟一次毫无意义的
 * 校园网请求。没有作业时应该几毫秒就退出。
 *
 * 两处都要看：watch 目录里躺着新作业，或者上次退出时留在 processing/ 里的
 * 半成品（那也要接着传完）。
 */
async function hasPendingWork() {
  for (const dir of [...WATCH_DIRS, SPOOL_PROCESSING_DIR]) {
    try {
      const names = await readdir(dir);
      for (const name of names) {
        if (!JOB_PATTERN.test(name)) continue;
        const info = await stat(join(dir, name)).catch(() => null);
        if (info?.isFile() && info.size > 0) return true;
      }
    } catch {
      /* 目录不存在就算了 */
    }
  }
  return false;
}

/* ------------------------------------------------------------------ 主流程 --- */

async function main() {
  await ensureDirs();

  if (!(await hasPendingWork())) {
    // 正常路径：绝大多数分钟级唤醒走的是这里，什么都不做就退。
    // 刻意**不写日志文件** —— 每分钟一条会把 driver.log 刷爆，而这一行毫无信息量。
    console.log(`${new Date().toISOString()} [worker] [info] 没有待处理的作业，直接退出`);
    return 0;
  }

  if (await someoneElseIsServing()) {
    await log("客户端已经在运行，本次唤醒不需要做事");
    return 0;
  }

  const info = await startServer({ port: 0, host: "127.0.0.1" });
  await log(`被唤醒，本地服务已启动：${info.url}`);

  // 凭据传的是**函数**而不是对象：会话没过期就根本不会去读钥匙串/DPAPI，
  // 这样常见路径（一天里绝大多数次打印）不用起 PowerShell、也不用动钥匙串。
  setRememberedCredential(() => secret.load());

  // 先确认拿得到会话，再开始收作业。
  //
  // 顺序很重要：如果没登录就直接开监听，作业会被搬到 failed/ 丢掉。反过来
  // 先探一次，没登录就原样把文件留在 spool 里 —— 用户打开客户端登录后，
  // 客户端的监听会把它捡走，作业不会丢。
  const user = await ensureSession();
  if (!user) {
    await log("当前不可上传（未登录、凭据读不出来或网络不通），作业留在 spool 里等客户端处理", "error");
    // 先把自己的服务收掉再通知：通知是异步的，而本地服务开着会让并发的唤醒
    // 误判成"客户端已经在运行"从而直接退出。
    await stopServer();
    await notify("南科大云打印", "有打印任务没能上传，请打开客户端登录一次");
    return 2;
  }
  await log(`已登录：${user.szLogonName ?? user.szTrueName ?? "?"}`);

  let failures = 0;
  // 驱动令牌读一次就够：整个进程生命周期里它不会变
  const token = await loadOrCreateDriverToken();
  const watcher = new SpoolWatcher({
    onLog: (msg, level) => void log(msg, level),
    getDriverToken: () => token,
    onJob: (result) => {
      if (!result.ok) failures += 1;
    },
  });

  await watcher.start();
  await log(`开始处理 spool：${WATCH_DIRS.join("  |  ")}`);

  const startedAt = Date.now();
  let quietSince = Date.now();
  let reason = "quiet";

  while (Date.now() - startedAt < MAX_MS) {
    await sleep(TICK_MS);
    if (watcher.pending() > 0) {
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= QUIET_MS) break;
  }
  if (Date.now() - startedAt >= MAX_MS) reason = "timeout";

  watcher.stop();
  // 超时收尾时把还挂着的上传直接掐断：我们本来就已经超时了，再等它没有意义，
  // 而文件已经躺在 processing/ 里，下次唤醒会接着传。
  await stopServer({ force: reason === "timeout" });

  if (reason === "timeout") {
    await log(`超过 ${MAX_MS / 1000}s 还没处理完，先退出（剩下的作业下次唤醒继续）`, "error");
  }
  if (failures > 0) {
    await notify("南科大云打印", `有 ${failures} 个打印任务上传失败，详见客户端日志`);
  }
  await log(`本次唤醒结束（${reason}，失败 ${failures} 个）`);
  return 0;
}

process.exitCode = await main().catch(async (err) => {
  await log(`唤醒后执行失败：${err?.stack || err?.message || err}`, "error");
  return 1;
});
// 本地服务会挂住事件循环，这里显式收尾
process.exit(process.exitCode ?? 0);
