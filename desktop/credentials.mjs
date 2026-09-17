// 凭据存储（Electron 主进程）。
//
// 用 Electron 的 safeStorage 做系统级加密：
//   macOS   -> 钥匙串（Keychain），受登录钥匙串保护
//   Windows -> DPAPI，绑定当前用户账户
//
// 密文写到 app.getPath("userData")/credentials.bin（0600）。明文不落盘——
// 这一点和原厂客户端形成对比：它把账号密码**明文**写在
// C:\Unifound\UniOPMClient.ini 的 [LOGINOPTION] 里（见 reverse/REPORT.md 第 4 节）。

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

function file() {
  return join(app.getPath("userData"), "credentials.bin");
}

export function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 给界面显示用的后端名字。 */
export function backend() {
  if (!available()) return "none";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "win32") return "dpapi";
  try {
    // Linux 上 safeStorage 会告诉我们它选了哪个后端（可能是 basic_text）
    return safeStorage.getSelectedStorageBackend?.() ?? "basic_text";
  } catch {
    return "basic_text";
  }
}

export async function save(credential) {
  if (!available()) {
    return { ok: false, message: "系统没有提供可用的加密存储，无法保存密码" };
  }
  const blob = safeStorage.encryptString(
    JSON.stringify({
      username: String(credential?.username ?? ""),
      password: String(credential?.password ?? ""),
      savedAt: Date.now(),
    }),
  );
  await mkdir(dirname(file()), { recursive: true });
  await writeFile(file(), blob, { mode: 0o600 });
  return { ok: true };
}

export async function load() {
  if (!available()) return null;
  try {
    const blob = await readFile(file());
    const text = safeStorage.decryptString(blob);
    const parsed = JSON.parse(text);
    if (!parsed?.username) return null;
    return parsed;
  } catch {
    // 换过机器、换过系统账户、或文件被改坏，都读不出来——按"没保存过"处理
    return null;
  }
}

export async function clear() {
  await rm(file(), { force: true });
}
