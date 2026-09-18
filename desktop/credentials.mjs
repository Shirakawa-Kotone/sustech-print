// 凭据存储（桌面壳这一侧）。
//
// 真正的存取在 lib/secret.mjs —— GUI 和无头工作进程走的是同一条路径，这样
// 用户没开客户端时被系统唤醒的那个进程也能自动重登。
//
// 这个文件只剩两件 Electron 专有的事：
//   1. 迁移：把老版本用 safeStorage 写在 credentials.bin 里的密码搬到新的存储，
//      免得升级之后所有人都要重新登录一次；
//   2. 报告后端名字给界面显示。

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage } from "electron";

import * as secret from "../lib/secret.mjs";

/** 老版本（<= 1.0.0）safeStorage 密文的落盘位置。 */
function legacyFile() {
  return join(app.getPath("userData"), "credentials.bin");
}

/** 读老格式的密文；没有就返回 null（绝大多数情况）。 */
async function readLegacyBlob() {
  try {
    return await readFile(legacyFile());
  } catch {
    return null;
  }
}

/**
 * 把老格式的密文迁到新存储，返回迁移过来的凭据（没得迁就是 null）。
 *
 * 不管迁没迁成都会把老文件删掉 —— 否则用户清空密码之后，下次启动又会从老文件里
 * 把它捞回来。
 */
async function migrateLegacy(blob) {
  if (!blob) return null;

  let credential = null;
  try {
    const parsed = JSON.parse(safeStorage.decryptString(blob));
    if (parsed?.username) credential = parsed;
  } catch {
    // 换过机器 / 换过系统账户 / 文件被改坏：读不出来就按"没保存过"处理
  }

  if (credential) {
    const res = await secret.save(credential);
    if (!res.ok) return null;
  }
  await rm(legacyFile(), { force: true });
  return credential;
}

/** 本机有没有可用的加密存储。 */
export function available() {
  return secret.available();
}

/** 给界面显示用的后端名字。 */
export function backend() {
  return secret.backend();
}

export async function save(credential) {
  const res = await secret.save(credential);
  // 新密码已经存好了，老文件不该继续留着一份旧密码
  if (res.ok) await rm(legacyFile(), { force: true });
  return res;
}

export async function load() {
  const current = await secret.load();
  if (current) return current;
  return migrateLegacy(await readLegacyBlob());
}

/**
 * 启动时主动迁移一次老格式（safeStorage 写的那份）。
 *
 * 为什么不能只靠 load() 的懒迁移：无头工作进程不跑 Electron，读不到 safeStorage。
 * 如果用户升级后一直没在界面上碰过凭据，那份密码就永远迁不过来，于是"会话过期后
 * 打印静默失败"——而会话是服务端 cookie，隔夜必过期，这个场景一点都不罕见。
 *
 * 没有老文件时（绝大多数启动）只做一次 readFile（失败即返回），不会去碰钥匙串/DPAPI。
 */
export async function migrateIfNeeded() {
  const blob = await readLegacyBlob();
  if (!blob) return false;
  // 新存储里已经有新的了，就别拿旧文件去覆盖它
  if (await secret.load()) {
    await rm(legacyFile(), { force: true });
    return false;
  }
  return Boolean(await migrateLegacy(blob));
}

export async function clear() {
  await secret.clear();
  await rm(legacyFile(), { force: true });
}
