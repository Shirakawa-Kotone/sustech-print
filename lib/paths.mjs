// 跨平台的目录约定。
//
// 桌面 App、Windows 打印端口、macOS CUPS backend 三方必须对"令牌放哪、spool 放哪"
// 达成一致，所以这些路径集中在这里定义，任何一方都不要自己拼路径。
//
//   macOS   ~/Library/Application Support/SUSTechPrint/
//   Windows %LOCALAPPDATA%\SUSTechPrint\        （每用户一份）
//   Linux   ~/.config/SUSTechPrint/
//
// Windows 的落盘目录是例外，见下面 SPOOL_DIR —— 它必须机器级共享。
//
// 可用 SUSTECH_CONFIG_DIR / SUSTECH_SPOOL_DIR 覆盖（测试与便携部署用）。

import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_DIR_NAME = "SUSTechPrint";

/**
 * 应用私有目录：**每个用户一份**。
 *
 * Windows 上曾经放在 %ProgramData%（机器级共享），踩了大坑：ProgramData 默认
 * 给 Users 的权限是 `(CI)(WD,AD,WEA,WA)`，那个 `(CI)` 只作用于**子目录**，
 * 管不到该目录里已存在的文件。于是"上一个用户 —— 或者你自己用管理员身份跑过
 * 一次 —— 创建的文件，当前用户再也改不动"。实际后果：
 *
 *   - 写 api-port 抛 EPERM，启动链断在那儿：白窗口、没有日志、没有提示；
 *   - 写 driver-token 抛 EPERM：保存密码直接报"没有权限"。
 *
 * 这些都是应用自己的东西，本来就不该放共享目录。现在放用户自己的
 * %LOCALAPPDATA%，永远只有自己会碰，不存在属主冲突。
 */
function defaultConfigDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP_DIR_NAME);
}

export const CONFIG_DIR = process.env.SUSTECH_CONFIG_DIR || defaultConfigDir();

/**
 * 驱动落盘目录。
 *
 * Windows 上它必须是**机器级共享**的，不能跟着 CONFIG_DIR 走：
 * 打印机队列是按机器注册的，那个"文件端口"写死成一个路径，假脱机服务
 * （SYSTEM 身份）把作业写进去，所以任何用户打印都得落到同一个文件上。
 * 因此固定在 %ProgramData%\SUSTechPrint\spool，由安装包创建并授权 Users
 * 读写 —— 注意这里只需要授权**这一个子目录**，应用私有数据已经不在这儿了。
 */
function defaultSpoolDir() {
  if (process.platform === "win32") {
    return join(process.env.ProgramData || "C:\\ProgramData", APP_DIR_NAME, "spool");
  }
  return join(CONFIG_DIR, "spool");
}

export const SPOOL_DIR = process.env.SUSTECH_SPOOL_DIR || defaultSpoolDir();

/** spool 里已被取走、正在上传的文件（避免监听器重复处理）。 */
export const SPOOL_PROCESSING_DIR = join(SPOOL_DIR, "processing");
export const SPOOL_DONE_DIR = join(SPOOL_DIR, "done");
export const SPOOL_FAILED_DIR = join(SPOOL_DIR, "failed");

/** 驱动提交用的本地令牌。 */
export const DRIVER_TOKEN_FILE = join(CONFIG_DIR, "driver-token");

/**
 * macOS 上 CUPS backend 落盘的共享目录。
 *
 * 为什么不能让它写用户家目录：CUPS 跑 backend 时把 `HOME` 设成了
 * `/var/spool/cups/tmp`（实测，见 /var/log/cups/error_log 里 backend 报的路径），
 * 所以 backend 里任何 `$HOME/Library/...` 都会指到 CUPS 的临时目录去。
 * 而且 backend 不在用户的 GUI 会话里，`open -a` 拉起 App 也不可能成功。
 *
 * 于是双方约定这个固定路径：目录由 install.sh 建成「安装用户可写」，
 * App（以用户身份）读，backend（以 root 身份）写。App 没运行时作业就躺在
 * 这里，App 一起来就会自动提交。
 */
export const SYSTEM_SPOOL_DIR =
  process.platform === "darwin"
    ? process.env.SUSTECH_SPOOL_DIR || "/var/spool/sustech-print/incoming"
    : "";

/** App 需要监听的落盘目录：自己的 + macOS 上 CUPS backend 的共享目录。 */
export const WATCH_DIRS = [SPOOL_DIR, SYSTEM_SPOOL_DIR].filter(Boolean);

/** 驱动日志，出问题时让用户能自己看到。 */
export const DRIVER_LOG_FILE = join(CONFIG_DIR, "driver.log");

/** App 的本地 API 基址。 */
export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || "127.0.0.1";
export const LOCAL_API = `http://${HOST}:${PORT}`;

/**
 * 虚拟打印机的显示名。用户在 Word/浏览器里点"打印"时看到的就是它。
 *
 * 用下划线而不是空格：CUPS 的 lpadmin **拒绝空白字符**（空格 / TAB / LF），
 * 报错却写成"打印机名称只能包含可打印字符"，很容易被误导。
 * Windows 允许空格，但两边统一用同一个名字，否则会出现文档/界面/系统三份名字。
 *
 * 必须与以下文件逐字一致（driver/macos/test/run-tests.sh 有一致性断言）：
 *   web/src/const.ts · driver/macos/install.sh · driver/windows/install-printer.ps1
 */
export const PRINTER_NAME = process.env.SUSTECH_PRINTER_NAME || "SUSTech_Printer";

/** 服务实际监听的端口。桌面版用随机端口，驱动得从这里读。 */
export const API_PORT_FILE = join(CONFIG_DIR, "api-port");

/** 建好所有驱动要用的目录。启动时调用一次即可。 */
export async function ensureDirs() {
  await Promise.all(
    [CONFIG_DIR, SPOOL_DIR, SPOOL_PROCESSING_DIR, SPOOL_DONE_DIR, SPOOL_FAILED_DIR].map((d) =>
      mkdir(d, { recursive: true }),
    ),
  );
}

export async function writeApiPort(port, host = HOST) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(API_PORT_FILE, JSON.stringify({ port, host, updatedAt: Date.now() }), {
    mode: 0o600,
  });
}

/** 读取服务端口；没写过就退回默认/环境变量。 */
export async function readApiPort() {
  try {
    const raw = JSON.parse(await readFile(API_PORT_FILE, "utf8"));
    const n = Number(raw?.port);
    if (Number.isFinite(n) && n > 0) return { port: n, host: raw.host || HOST };
  } catch {
    /* 还没写过 */
  }
  return { port: PORT, host: HOST };
}

export { APP_DIR_NAME };
