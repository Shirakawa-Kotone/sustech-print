// 本地会话持久化：把云打印系统的 Cookie 罐存到磁盘，避免每次重登。
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { CONFIG_DIR, DRIVER_TOKEN_FILE } from "./paths.mjs";

/**
 * 会话文件放在用户私有目录里，和驱动令牌同一处（见 paths.mjs 的 CONFIG_DIR）。
 *
 * 这里原来写的是 `join(process.cwd(), ".data")`：开发时勉强能用，一打包就炸 ——
 * macOS 从 Finder / LaunchServices 启动时 cwd 是 `/`，于是算出 `/.data`，
 * `mkdir` 在只读根目录上直接报 `ENOENT: mkdir '/.data'`，登录态根本存不下来。
 * 应用自己的数据不该依赖启动时的工作目录。
 */
const DATA_DIR = process.env.DATA_DIR || CONFIG_DIR;
const SESSION_FILE = join(DATA_DIR, "session.json");

/** 开发期遗留位置，只读一次用于迁移。cwd 是 `/` 时这条路径自然读不到。 */
const LEGACY_SESSION_FILE = join(process.cwd(), ".data", "session.json");

function parseSession(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.cookies)) return null;
  return parsed;
}

/** 读取磁盘上的会话；不存在或损坏时返回 null。 */
export async function loadSession() {
  try {
    return parseSession(await readFile(SESSION_FILE, "utf8"));
  } catch {
    /* 正式位置没有，看看是不是老版本留在仓库里的 */
  }
  if (LEGACY_SESSION_FILE === SESSION_FILE) return null;
  try {
    const legacy = parseSession(await readFile(LEGACY_SESSION_FILE, "utf8"));
    if (legacy) {
      await saveSession(legacy).catch(() => {});
      return legacy;
    }
  } catch {
    /* 没有就没有 */
  }
  return null;
}

/** 写入会话（权限 0600，仅当前用户可读）。 */
export async function saveSession(data) {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  const payload = JSON.stringify({ ...data, savedAt: Date.now() }, null, 2);
  await writeFile(SESSION_FILE, payload, { mode: 0o600 });
}

/** 清除本地会话。 */
export async function clearSession() {
  await rm(SESSION_FILE, { force: true });
}

/**
 * 读取（首次运行时生成）打印驱动专用的本地令牌。
 *
 * 打印驱动/端口监视器会把生成的 PDF 提交到本机 App 的上传接口；这个接口必须
 * 只对本机可信调用方开放，否则同机任何进程（包括浏览器里的页面）都能拿你的
 * 账号往云打印队列里塞文件。令牌存在 CONFIG_DIR/driver-token（0600），驱动脚本
 * 读到它之后放在 x-driver-token 头里。
 */
export async function loadOrCreateDriverToken() {
  try {
    const token = (await readFile(DRIVER_TOKEN_FILE, "utf8")).trim();
    if (token.length >= 32) return token;
  } catch {
    /* 不存在或不可读，下面重建 */
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(DRIVER_TOKEN_FILE), { recursive: true });
  await writeFile(DRIVER_TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

export { SESSION_FILE, DATA_DIR, DRIVER_TOKEN_FILE };
