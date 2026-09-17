// spool 监听：把驱动落盘的 PDF 提交到本机 App 的上传接口。
//
// 为什么需要它：
//   Windows 的虚拟打印机是把 PostScript/PDF 直接写到一个「文件端口」上的
//   （C:\ProgramData\SUSTechPrint\spool\out.pdf）。写文件这件事没有任何代码
//   参与，所以必须有个人盯着这个目录把它送出去。macOS 的 CUPS backend 可以
//   直接 POST，走不到这里，但两条路径都指向同一个上传接口。
//
// 端口文件是**固定文件名、每个作业覆盖写**（Windows 不允许端口指向目录，
// 实测报 Access was denied），所以监听要够快：轮询间隔 400ms，一稳定就搬走。

import { createReadStream } from "node:fs";
import { copyFile, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  SPOOL_DIR,
  SYSTEM_SPOOL_DIR,
  WATCH_DIRS,
  SPOOL_PROCESSING_DIR,
  SPOOL_DONE_DIR,
  SPOOL_FAILED_DIR,
  ensureDirs,
  readApiPort,
} from "../lib/paths.mjs";

/**
 * 要监听哪些目录，以及捡走文件的方式。
 *
 * - 自己的 spool 目录：Windows 的「文件端口」用固定文件名、每个作业覆盖写，
 *   所以必须用 rename 原子搬走（慢一步就可能被下一个作业盖掉）。
 * - macOS 的共享目录：和家目录不在同一个卷上时 rename 会 EXDEV，用 copy+unlink。
 */
const SOURCES = [
  { dir: SPOOL_DIR, take: "rename", pattern: /\.(pdf|ps|prn)$/i },
  ...(SYSTEM_SPOOL_DIR
    ? [{ dir: SYSTEM_SPOOL_DIR, take: "copy", pattern: /\.pdf$/i }]
    : []),
];

const POLL_MS = 400;
/** 文件大小连续这么多次不变，就认为写完了。 */
const STABLE_TICKS = 2;
/** 超过这个大小直接拒绝，避免把稀奇古怪的东西传给后端。 */
const MAX_BYTES = 200 * 1024 * 1024;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读文件开头/结尾，确认是完整的 PDF。 */
async function looksLikeCompletePdf(path) {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    if (size < 8) return { ok: false, why: "文件过小" };

    const head = Buffer.alloc(5);
    await fh.read(head, 0, 5, 0);
    if (head.toString("latin1") !== "%PDF-") {
      return { ok: false, why: `不是 PDF（开头 ${head.toString("latin1")}）` };
    }

    const tailLen = Math.min(1024, size);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    if (!tail.toString("latin1").includes("%%EOF")) {
      return { ok: false, why: "PDF 没有写完整（缺少 %%EOF）" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: `读取失败：${err.message}` };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * 判断 PostScript 是否写完整。Windows 上如果装了 PostScript 驱动而不是
 * Print To PDF，落到端口的就是 .ps，这里也认一下（后端只收 PDF，
 * 所以 PS 会被标记为 failed 并写日志，而不是悄悄丢进队列）。
 */
async function isPostScript(path) {
  let fh;
  try {
    fh = await open(path, "r");
    const head = Buffer.alloc(2);
    await fh.read(head, 0, 2, 0);
    return head.toString("latin1") === "%!";
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export class SpoolWatcher {
  /** @param {{ onLog?: (msg: string, level?: string) => void, getDriverToken: () => string }} opts */
  constructor(opts = {}) {
    this.onLog = opts.onLog ?? (() => {});
    this.getDriverToken = opts.getDriverToken ?? (() => "");
    this.timer = null;
    this.stopped = false;
    /** @type {Map<string, { size: number, ticks: number }>} */
    this.seen = new Map();
    /** 正在处理中的文件，避免重入。 */
    this.busy = new Set();
  }

  async start() {
    await ensureDirs();
    this.stopped = false;
    this.onLog(`spool 监听已启动：${WATCH_DIRS.join("  |  ")}`);
    // 启动时先把上次没处理完的（processing 里的）捡回来
    await this.recoverProcessing();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.onLog(`监听出错：${err.message}`, "error"));
    }, POLL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 上一次退出时留在 processing/ 的文件重新排队。 */
  async recoverProcessing() {
    try {
      const files = await readdir(SPOOL_PROCESSING_DIR);
      for (const name of files) {
        if (!name.toLowerCase().endsWith(".pdf")) continue;
        const from = join(SPOOL_PROCESSING_DIR, name);
        const to = join(SPOOL_DIR, name);
        await rename(from, to).catch(() => {});
        this.onLog(`恢复上次未提交的文件：${name}`);
      }
    } catch {
      /* 目录还不存在就算了 */
    }
  }

  async tick() {
    if (this.stopped) return;

    for (const source of SOURCES) {
      await this.scanDir(source);
    }
  }

  async scanDir(source) {
    let names;
    try {
      names = await readdir(source.dir);
    } catch {
      // 目录不存在（比如没装 macOS 驱动）就跳过，不是错误
      return;
    }

    for (const name of names) {
      // 只认驱动写出来的端口文件（Windows 上是 out.pdf）
      if (!source.pattern.test(name)) continue;
      const path = join(source.dir, name);
      if (this.busy.has(path)) continue;

      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size === 0) continue;
      if (info.size > MAX_BYTES) {
        await this.fail(path, `文件过大（${info.size} 字节）`);
        continue;
      }

      const prev = this.seen.get(path);
      if (!prev || prev.size !== info.size) {
        this.seen.set(path, { size: info.size, ticks: 1 });
        continue;
      }
      prev.ticks += 1;
      if (prev.ticks < STABLE_TICKS) continue;

      // 文件稳定了，接管它
      this.seen.delete(path);
      this.busy.add(path);
      try {
        await this.handle(path, name, source.take);
      } finally {
        this.busy.delete(path);
      }
    }
  }

  async handle(path, name, take = "rename") {
    const check = await looksLikeCompletePdf(path);
    if (!check.ok) {
      if (await isPostScript(path)) {
        await this.fail(path, "收到的是 PostScript，当前只支持 PDF（请把驱动换成 Microsoft Print To PDF）");
      } else {
        await this.fail(path, check.why);
      }
      return;
    }

    // 立刻搬走：端口文件会被下一个作业覆盖，慢一步就可能张冠李戴
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const taken = join(SPOOL_PROCESSING_DIR, `${stamp}-${basename(name)}`);
    try {
      if (take === "copy") {
        // 跨卷时 rename 会失败，先复制再删源
        await copyFile(path, taken);
        await unlink(path);
      } else {
        await rename(path, taken);
      }
    } catch (err) {
      this.onLog(`搬移失败：${err.message}`, "error");
      return;
    }

    const size = (await stat(taken)).size;
    try {
      await this.submit(taken, name, size);
      await rename(taken, join(SPOOL_DONE_DIR, basename(taken))).catch(() => {});
      this.onLog(`已提交打印：${name}（${size} 字节）`);
    } catch (err) {
      await rename(taken, join(SPOOL_FAILED_DIR, basename(taken))).catch(() => {});
      this.onLog(`提交失败：${name} — ${err.message}`, "error");
    }
  }

  async submit(filePath, originalName, size) {
    const token = this.getDriverToken();
    if (!token) throw new Error("拿不到本地驱动令牌，请先启动客户端");

    const { port, host } = await readApiPort();
    const url = `http://${host}:${port}/api/driver/print`;

    // 打印出来的文件名就用作队列里的文档名。
    //
    // 例外：Windows 的「文件端口」只能写固定文件名 out.pdf —— 原文档名留在假脱机
    // 服务里，端口只拿到裸字节，读不到（见 driver/windows/README.md）。照搬的话
    // 每个作业都会以 "out.pdf" 进云打印队列，用户分不清哪份是哪份。
    // 所以这里换成时间戳命名，格式与 driver/windows/README.md 里写的一致。
    // macOS 走 CUPS backend，标题是从作业名带过来的，不受影响。
    let title = originalName.replace(/\.(pdf|ps|prn)$/i, "") || "云打印任务";
    if (/^out$/i.test(title)) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      title = `云打印-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
    const fileName = `${title}.pdf`;

    // 大文件用流比较稳，但 undici 对流式 body 需要 duplex 选项；
    // 打印作业一般在几十 MB 内，直接读进内存更简单可靠。
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(filePath);
    if (body.length > MAX_BYTES) throw new Error("文件过大");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-driver-token": token,
        "content-type": "application/pdf",
        "x-file-name": encodeURIComponent(fileName),
        "content-length": String(body.length),
      },
      body,
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      throw new Error(`本机接口返回 HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json?.ok) {
      throw new Error(json?.message || json?.reason || "上传未成功");
    }
    return json;
  }

  async fail(path, why) {
    this.seen.delete(path);
    const target = join(SPOOL_FAILED_DIR, `${Date.now()}-${basename(path)}`);
    await rename(path, target).catch(async () => {
      await unlink(path).catch(() => {});
    });
    this.onLog(`已丢弃一个无法提交的任务：${why}`, "error");
  }
}

export { SPOOL_DIR };
