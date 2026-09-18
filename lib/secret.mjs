// 跨进程可读的凭据存储。
//
// 为什么不用 Electron 的 safeStorage（desktop/credentials.mjs 原来那套）：
// 打印时被系统唤醒的那个无头进程**不跑 Electron**（它就是本项目的 exe 带
// ELECTRON_RUN_AS_NODE=1 当 node 用），拿不到 safeStorage。而它又必须能自动重登——
// 云打印的登录态是服务端会话 cookie（见 session.json：SESSIONID / JSESSIONID 都没有
// expires），空闲一段时间就会被服务端丢掉。不能重登的话，用户隔夜打印就静默失败。
//
// 于是凭据改存在两个系统级存储里，GUI 和无头进程走同一条路径：
//
//   macOS   钥匙串（/usr/bin/security 的 generic password 条目）
//   Windows DPAPI（PowerShell 调 ProtectedData，CurrentUser 作用域）
//
// ── macOS 的安全边界，必须说清楚 ────────────────────────────────────────────
// `security` 建条目时，「创建它的那个程序」会被自动写进访问控制列表。所以我们
// 之后用 /usr/bin/security 读它不会弹框 —— 这正是不想弹框才这么做的。
//
// 代价是：钥匙串 ACL 信任的是 /usr/bin/security 这个通用命令行工具，而不是本程序。
// 任何以**当前用户身份**运行的进程都能执行 `security find-generic-password -w`
// 把密码读走，且不会有任何提示。这比 safeStorage（ACL 只信任 Electron 应用本身，
// 别人读要弹框）弱。
//
// 之所以接受：无头进程没有别的办法拿到钥匙串（Node 不能直接调 Security.framework，
// 自己编一个原生模块又违背本项目零依赖的约定）。它仍然比原厂客户端强 ——
// 那边是把账号密码**明文**写在 C:\Unifound\UniOPMClient.ini 里（见 reverse/REPORT.md）。
// 这一点在 README 里也写明了。
//
// ── 已知的次要暴露面 ────────────────────────────────────────────────────────
// `security add-generic-password` 只支持从命令行参数或交互式提示拿密码，没有
// stdin/文件的形式（`-w` 后面不给值就变成等用户敲），所以保存的一瞬间密码会出现在
// 自己的 argv 里。同机同用户的进程在那个窗口内 `ps` 能看到。条目本身是 0600 语义的
// 钥匙串数据，不落明文。

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONFIG_DIR } from "./paths.mjs";

/** 钥匙串条目的 service 名。换它等于让所有人重登一次，别动。 */
const KEYCHAIN_SERVICE = "cn.edu.sustech.print";
/** 条目固定用这一个 account，真正的用户名连同密码一起放在密码字段的 JSON 里。 */
const KEYCHAIN_ACCOUNT = "sustech-print";

/** Windows 上 DPAPI 密文的落盘位置（macOS 不用文件，钥匙串自己存）。 */
const DPAPI_FILE = join(CONFIG_DIR, "credentials.dpapi");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

/** 跑一个命令并拿到 stdout；不经过 shell。 */
function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 退出码 ${code}${err.trim() ? `：${err.trim()}` : ""}`));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/* ------------------------------------------------------------------ macOS --- */

// 存进钥匙串之前先 base64 一层，原因见下面 macLoad 的注释。
function macEncode(json) {
  return Buffer.from(json, "utf8").toString("base64");
}

async function macSave(json) {
  // -U：条目已存在就更新，不报错。不加 -A：ACL 默认就把创建者（security）放进去，
  // 够我们读了，不需要"允许一切程序"那个更宽的开关。
  await run("/usr/bin/security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    macEncode(json),
  ]);
}

/**
 * 读钥匙串条目。
 *
 * 这里必须 base64 解回来，别省这一步：`security find-generic-password -w` 在
 * 值里含有非 ASCII（也就是密码里有中文）时，**不会原样打印，而是输出十六进制**。
 * 实测：存 `p@ss word 中文!`，读回来是 `7040737320776f726420e4b8ade6968721`。
 * JSON.parse 当然就炸了 —— 表现为"明明保存成功，却再也读不出来"，非常难查。
 * 存成纯 ASCII 的 base64 就没有这个歧义。
 */
async function macLoad() {
  const b64 = (await run("/usr/bin/security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ])).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

async function macClear() {
  try {
    await run("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
    ]);
  } catch {
    // 本来就没有，删不掉不算错
  }
}

/* ---------------------------------------------------------------- Windows --- */

/**
 * DPAPI 加解密。
 *
 * 密码走 stdin 而不是命令行参数：Windows 上任何同用户的进程都能读别的进程的
 * 命令行，stdin 至少要麻烦一点。ProtectedData 的 CurrentUser 作用域和
 * safeStorage 在 Windows 上用的是同一套东西，所以这里没有降级。
 */
const PS_PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$enc = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($plain), $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;

const PS_UNPROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd()
$dec = [Security.Cryptography.ProtectedData]::Unprotect(
  [Convert]::FromBase64String($b64), $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))
`;

function powershell(script, input) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input },
  );
}

async function winSave(json) {
  const b64 = await powershell(PS_PROTECT, json);
  await mkdir(dirname(DPAPI_FILE), { recursive: true });
  await writeFile(DPAPI_FILE, b64.trim() + "\n", { mode: 0o600 });
}

async function winLoad() {
  const b64 = (await readFile(DPAPI_FILE, "utf8")).trim();
  if (!b64) return "";
  return powershell(PS_UNPROTECT, b64);
}

/* --------------------------------------------------------------- 对外接口 --- */

/** 本机有没有可用的系统级加密存储。 */
export function available() {
  return IS_MAC || IS_WIN;
}

/** 给界面显示用的后端名字（和原来 credentials.backend() 的取值保持一致）。 */
export function backend() {
  if (IS_MAC) return "keychain";
  if (IS_WIN) return "dpapi";
  return "none";
}

/**
 * 保存凭据。
 *
 * 失败时返回 {ok:false, message} 而不是抛异常：调用方是 UI，需要把原因显示出来。
 */
export async function save(credential) {
  if (!available()) {
    return { ok: false, message: "本平台没有可用的系统加密存储，无法保存密码" };
  }
  const payload = JSON.stringify({
    username: String(credential?.username ?? ""),
    password: String(credential?.password ?? ""),
    savedAt: Date.now(),
  });
  try {
    if (IS_MAC) await macSave(payload);
    else await winSave(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `写入系统加密存储失败：${err.message}` };
  }
}

/**
 * 读取凭据；没保存过、读不出来、换过机器/账户都返回 null。
 *
 * 注意 macOS 上 `security` 在钥匙串被锁住时会失败（用户已登录时不会锁），
 * 这里一律按"没保存过"处理，而不是把错误抛给调用方 —— 调用方拿到 null 会
 * 退化成"需要重新登录"，这正是我们想要的降级方向。
 */
export async function load() {
  if (!available()) return null;
  try {
    const text = IS_MAC ? await macLoad() : await winLoad();
    const parsed = JSON.parse(text);
    if (!parsed?.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clear() {
  if (IS_MAC) {
    await macClear();
    return;
  }
  await rm(DPAPI_FILE, { force: true });
}

export { KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, DPAPI_FILE };
