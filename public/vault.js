// 浏览器本地凭据保险箱
//
// 用 WebCrypto 的 PBKDF2(SHA-256) 派生密钥，再用 AES-GCM 加密学工号/密码。
// 只有密文和盐/IV 落盘（localStorage），主密码本身永远不保存。
//
// 说清楚边界：这不是"把密码藏起来"的混淆，而是真正的口令加密——
// 不知道主密码就无法还原。但反过来说，主密码太弱的话，
// 拿到这台电脑的人可以离线暴力破解，所以请用一句够长的口令。

const STORAGE_KEY = "sustech-print.vault.v1";
const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 保险箱是否存在。 */
export function hasVault() {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

/** 读取非敏感元信息（用于展示"上次保存的账号"）。 */
export function vaultMeta() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { username, updatedAt, iterations } = JSON.parse(raw);
    return { username, updatedAt, iterations };
  } catch {
    return null;
  }
}

/** 加密保存凭据。 */
export async function saveVault(passphrase, { username, password }) {
  if (!passphrase) throw new Error("请设置主密码");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);

  const plaintext = enc.encode(JSON.stringify({ username, password }));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      v: 1,
      iterations: PBKDF2_ITERATIONS,
      salt: toB64(salt),
      iv: toB64(iv),
      ct: toB64(new Uint8Array(cipher)),
      username, // 明文仅用于提示，不含密码
      updatedAt: Date.now(),
    }),
  );
}

/** 用主密码解出凭据；密码错误会抛错。 */
export async function loadVault(passphrase) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error("本地没有保存的凭据");
  const box = JSON.parse(raw);

  const salt = fromB64(box.salt);
  const iv = fromB64(box.iv);
  const key = await deriveKey(passphrase, salt, box.iterations || PBKDF2_ITERATIONS);

  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      fromB64(box.ct),
    );
  } catch {
    throw new Error("主密码不正确");
  }
  return JSON.parse(dec.decode(plain));
}

/** 删除保险箱。 */
export function clearVault() {
  localStorage.removeItem(STORAGE_KEY);
}
