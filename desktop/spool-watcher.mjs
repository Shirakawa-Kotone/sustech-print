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
import { copyFile, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
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

/** 把打印选项写成人话，只用于日志。取值域见 takeOptions。 */
function describeOptions(opts) {
  if (!opts) return "";
  const duplex = { 1: "单面", 2: "双面短边", 3: "双面长边" }[opts.duplex] || "单面";
  return `（${opts.color === 2 ? "彩色" : "黑白"} · ${duplex} · ${opts.copies} 份）`;
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
  /**
   * @param {{
   *   onLog?: (msg: string, level?: string) => void,
   *   getDriverToken: () => string,
   *   onJob?: (result: { ok: boolean, name: string, reason?: string }) => void,
   * }} opts
   */
  constructor(opts = {}) {
    this.onLog = opts.onLog ?? (() => {});
    this.getDriverToken = opts.getDriverToken ?? (() => "");
    /** 每个作业的最终结果。无头进程靠它决定要不要给用户弹通知。 */
    this.onJob = opts.onJob ?? (() => {});
    this.timer = null;
    this.stopped = false;
    /** @type {Map<string, { size: number, ticks: number }>} */
    this.seen = new Map();
    /** 正在处理中的文件，避免重入。 */
    this.busy = new Set();
  }

  /**
   * 还有没有没处理完的作业。
   *
   * seen = 已经看见但还没确认写稳的文件，busy = 正在搬/正在传的文件。
   * 无头进程用它判断"能不能退出了"：必须等到这两样都空了，否则会在
   * 上传到一半的时候退出，作业就丢在 processing/ 里等下次唤醒。
   */
  pending() {
    return this.busy.size + this.seen.size;
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

  /**
   * 读走驱动写的「打印选项」sidecar（`<作业>.pdf.opt`），读完就删。
   *
   * 只有 macOS 的 CUPS backend 会写它 —— Windows 的文件端口只拿到落盘的字节，
   * 打印对话框里的选项一个都传不出来（见 driver/windows/README.md）。
   *
   * 约定：驱动**先写 sidecar、再 rename PDF**，所以看到 PDF 时它一定已经在了，
   * 两边不需要任何锁。读不到就当没有（用默认的 黑白/单面/1 份），绝不因为一个
   * 可选文件把作业卡住；读到之后立刻删掉，免得留下没有 PDF 的孤儿文件。
   *
   * @returns {Promise<{copies:number,duplex:number,color:number}|null>}
   */
  async takeOptions(pdfPath) {
    const optPath = `${pdfPath}.opt`;
    let text;
    try {
      text = await readFile(optPath, "utf8");
    } catch {
      return null; // 最常见的情况：Windows 作业，根本没有 sidecar
    }
    await unlink(optPath).catch(() => {});

    const int = (v, min, max, dflt) => {
      const n = Number.parseInt(String(v ?? ""), 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
    };
    try {
      const raw = JSON.parse(text);
      // 取值域与上游一致：dwColor 1|2、dwDuplex 1|2|3、dwCopies 1..99
      return {
        copies: int(raw.copies, 1, 99, 1),
        duplex: int(raw.duplex, 1, 3, 1),
        color: int(raw.color, 1, 2, 1),
      };
    } catch {
      this.onLog(`选项文件不是合法 JSON，按默认值（黑白/单面/1份）提交：${optPath}`, "warn");
      return null;
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

    // 先把选项读进内存（读完即删），再搬文件 —— 见 takeOptions 的注释
    const opts = await this.takeOptions(path);

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
      await this.submit(taken, name, size, opts);
      await rename(taken, join(SPOOL_DONE_DIR, basename(taken))).catch(() => {});
      this.onLog(`已提交打印：${name}${describeOptions(opts)}（${size} 字节）`);
      this.onJob({ ok: true, name });
    } catch (err) {
      await rename(taken, join(SPOOL_FAILED_DIR, basename(taken))).catch(() => {});
      this.onLog(`提交失败：${name} — ${err.message}`, "error");
      this.onJob({ ok: false, name, reason: err.message });
    }
  }

  async submit(filePath, originalName, size, opts = null) {
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
    const body = await readFile(filePath);
    if (body.length > MAX_BYTES) throw new Error("文件过大");

    /** @type {Record<string,string>} */
    const headers = {
      "x-driver-token": token,
      "content-type": "application/pdf",
      "x-file-name": encodeURIComponent(fileName),
      "content-length": String(body.length),
    };
    // 打印对话框里选的选项（只有 macOS 驱动带得过来）。
    // 不带时服务端用默认值：黑白 / 单面 / 1 份 —— 与上游官方客户端一致。
    if (opts) {
      headers["x-copies"] = String(opts.copies);
      headers["x-duplex"] = String(opts.duplex);
      headers["x-color"] = String(opts.color);
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
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
    this.onJob({ ok: false, name: basename(path), reason: why });
  }
}

export { SPOOL_DIR };
