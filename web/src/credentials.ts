// 凭据存储。
//
// 只有桌面版（Electron）才有真正的"自动保存密码"：主进程用系统的
// safeStorage —— macOS 落到「钥匙串」，Windows 落到「DPAPI（当前用户）」——
// 加密后写到应用数据目录。密码不会以明文落盘，也不经过 localStorage。
//
// 纯浏览器里没有等价的、无需主密码的安全存储（localStorage 是明文的），
// 所以那种情况下干脆不提供这个开关，而不是偷偷存明文。

export interface StoredCredential {
  username: string;
  password: string;
  savedAt?: number;
}

export interface CredentialStore {
  available(): Promise<boolean>;
  backend(): Promise<string>;
  save(c: StoredCredential): Promise<{ ok: boolean; message?: string }>;
  load(): Promise<StoredCredential | null>;
  clear(): Promise<void>;
  /** 让主进程把已保存的凭据交给后端，用于会话过期后自动重登。 */
  arm(): Promise<{ ok: boolean }>;
}

interface DesktopBridge {
  /** preload 里直接暴露的 process.platform（"darwin" / "win32"）。 */
  platform?: string;
  credentials: CredentialStore;
  app?: {
    info(): Promise<{
      version: string;
      platform: string;
      printerName: string;
      serverUrl: string;
      configDir: string;
      logFile: string;
      openAtLogin: boolean;
    }>;
    setOpenAtLogin(enabled: boolean): Promise<{ ok: boolean; openAtLogin: boolean }>;
  };
}

declare global {
  interface Window {
    sustechDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | undefined {
  return window.sustechDesktop;
}

/** 当前环境是否支持系统级加密保存。 */
export async function keychainAvailable(): Promise<boolean> {
  const c = window.sustechDesktop?.credentials;
  if (!c) return false;
  try {
    return await c.available();
  } catch {
    return false;
  }
}

export async function keychainBackend(): Promise<string> {
  const c = window.sustechDesktop?.credentials;
  if (!c) return "";
  try {
    return await c.backend();
  } catch {
    return "";
  }
}

export async function saveCredential(c: StoredCredential) {
  const store = window.sustechDesktop?.credentials;
  if (!store) throw new Error("当前环境不支持自动保存密码");
  return store.save(c);
}

export async function loadCredential(): Promise<StoredCredential | null> {
  const store = window.sustechDesktop?.credentials;
  if (!store) return null;
  try {
    return await store.load();
  } catch {
    return null;
  }
}

export async function clearCredential() {
  await window.sustechDesktop?.credentials?.clear();
}

export async function armCredential() {
  try {
    await window.sustechDesktop?.credentials?.arm();
  } catch {
    /* 主进程没起来的时候忽略 */
  }
}

/** 后端名 -> 给用户看的说法。 */
export function backendLabel(backend: string): string {
  switch (backend) {
    case "keychain":
      return "macOS 钥匙串";
    case "dpapi":
      return "Windows DPAPI（当前用户）";
    case "basic_text":
      return "系统密钥库（弱，无桌面会话）";
    default:
      return "系统安全存储";
  }
}
