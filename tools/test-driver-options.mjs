// 驱动选项的端到端回归测试：sidecar → spool 监听 → /api/driver/print → 上游 multipart
//
// 跑法：node tools/test-driver-options.mjs
//
// 为什么需要它（真实踩过的坑）：打印对话框里选的"彩色"曾经**根本没传到云端** ——
// 驱动路径把 dwColor 写成了 0（一个上游不认识的取值），上游不报错、只按默认的
// 黑白处理，于是本地一切正常、打出来永远是黑白。这种"参数写错但没人报错"的
// bug 只有逐字段核对真实请求才抓得住。
//
// 它不需要校园网、不需要真账号：用假上游顶替云打印服务，把收到的 multipart
// 原样记下来核对；本地服务（server.mjs）与 spool 监听都是真进程/真代码。
//
// 取值域来自官方网页客户端（/client/new/cprintPc/cprint.html 的上传表单）：
//     dwColor   1=黑白(默认) 2=彩色
//     dwDuplex  1=单面(默认) 2=双面短边 3=双面长边
//     dwPaperId -1=不指定(默认) 9=A4 8=A3

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "driver/macos/test/fixtures/sample-zh.pdf");
const TOKEN = "e2e".repeat(20); // 服务端要求 >= 32 字符

let pass = 0;
let fail = 0;
const ok = (name, extra = "") => {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m ${name}${extra ? `（=${extra}）` : ""}`);
};
const bad = (name, detail) => {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}：${detail}`);
};
const eq = (name, want, got) =>
  String(want) === String(got) ? ok(name, got) : bad(name, `期望 [${want}] 实际 [${got}]`);

/* ------------------------------------------------------------- 环境 --- */

const tmp = await mkdtemp(join(tmpdir(), "drv-options-"));
const cfg = join(tmp, "config");
const spool = join(tmp, "spool");
await mkdir(cfg, { recursive: true });
await mkdir(spool, { recursive: true });
await writeFile(join(cfg, "driver-token"), TOKEN + "\n", { mode: 0o600 });

// 冒充"已经登录"：种一份会话文件，省掉整个 CAS 登录流程。
// （服务端只在启动时读一次，所以必须在 spawn 之前写好。）
await writeFile(
  join(cfg, "session.json"),
  JSON.stringify({
    cookies: [{ name: "SESSIONID", value: "e2e-session", domain: "127.0.0.1", path: "/" }],
    user: { szLogonName: "e2e", szTrueName: "端到端" },
  }),
  { mode: 0o600 },
);

/* --------------------------------------------------------- 假上游 --- */

/** @type {{ url: string, headers: import("node:http").IncomingHttpHeaders, body: Buffer }[]} */
const seen = [];
const json = (res, obj) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url.startsWith("/api/client/Auth/Check")) {
    return json(res, { code: 0, result: { szLogonName: "e2e", szTrueName: "端到端" } });
  }
  if (req.url.startsWith("/api/client/CloudPrint/Upload")) {
    seen.push({ url: req.url, headers: req.headers, body });
    return json(res, { code: 0, message: "ok" });
  }
  return json(res, { code: 0, result: {} });
});
const upstreamPort = await new Promise((r) =>
  upstream.listen(0, "127.0.0.1", () => r(upstream.address().port)),
);

/* ------------------------------------------------------ 真本地服务 --- */

const apiPort = 18000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    SUSTECH_CONFIG_DIR: cfg,
    SUSTECH_SPOOL_DIR: spool,
    PMS_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
    PORT: String(apiPort),
    HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

const stopAll = async () => {
  watcher?.stop();
  child.kill("SIGTERM");
  upstream.close();
  await rm(tmp, { recursive: true, force: true });
};

const base = `http://127.0.0.1:${apiPort}`;
const status = await (async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/driver/status`, { headers: { "x-driver-token": TOKEN } });
      if (r.ok) return r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopAll();
  throw new Error(`本地服务没起来：\n${serverLog}`);
})();

console.log("== 驱动选项端到端（真本地服务 + 假上游）==");
eq("本机服务已就绪", true, status.ok);
eq("服务认为已登录", true, status.loggedIn);

/* -------------------------------------------------------- spool 监听 --- */

// 监听器读的是模块级常量，所以必须在 import 之前把环境变量摆好
process.env.SUSTECH_SPOOL_DIR = spool;
process.env.SUSTECH_CONFIG_DIR = cfg;
process.env.PORT = String(apiPort);
process.env.HOST = "127.0.0.1";
const { SpoolWatcher } = await import(join(ROOT, "desktop/spool-watcher.mjs"));

let watcher;
/** 往 spool 里丢一个作业（可带选项 sidecar），等它被上传 */
async function runJob(name, optJson) {
  const before = seen.length;
  await copyFile(FIXTURE, join(spool, `${name}.pdf`));
  if (optJson) await writeFile(join(spool, `${name}.pdf.opt`), JSON.stringify(optJson));
  for (let i = 0; i < 150; i++) {
    if (seen.length > before) return seen[seen.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`作业 ${name} 一直没上传（serverLog: ${serverLog.slice(-500)}）`);
}

/** 从 multipart 里取一个普通字段的值 */
function field(raw, name) {
  const m = raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`));
  return m ? m[1] : null;
}
/** 从 multipart 里取出 szPath 的文件字节（用 boundary 精确定位结尾） */
function fileBytes(buf, contentType) {
  const at = buf.indexOf(Buffer.from('name="szPath"'));
  if (at < 0) return null;
  const start = buf.indexOf("\r\n\r\n", at) + 4;
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  return buf.subarray(start, buf.indexOf(Buffer.from(`\r\n--${boundary}`), start));
}

watcher = new SpoolWatcher({ getDriverToken: () => TOKEN, onLog: () => {}, onJob: () => {} });
await watcher.start();

try {
  const fixture = await readFile(FIXTURE);

  // 1) 彩色 + 双面短边 + 3 份（sidecar 由 macOS CUPS backend 写出来）
  const job1 = await runJob("彩色作业", { v: 1, copies: 3, duplex: 2, color: 2 });
  const raw1 = job1.body.toString("latin1");
  eq("彩色作业：dwColor", 2, field(raw1, "dwColor"));
  eq("彩色作业：dwDuplex（2=双面短边）", 2, field(raw1, "dwDuplex"));
  eq("彩色作业：dwCopies", 3, field(raw1, "dwCopies"));
  eq("彩色作业：dwPaperId（-1=不指定）", -1, field(raw1, "dwPaperId"));
  eq("彩色作业：dwFrom/dwTo", "0/0", `${field(raw1, "dwFrom")}/${field(raw1, "dwTo")}`);
  eq(
    "彩色作业：上传的 PDF 与本地逐字节一致",
    true,
    Buffer.compare(fileBytes(job1.body, job1.headers["content-type"]), fixture) === 0,
  );

  // 2) 完全没有 sidecar（= Windows 的文件端口路径）→ 全部走默认值
  const raw2 = (await runJob("默认作业", null)).body.toString("latin1");
  eq("无 sidecar：dwColor 默认黑白", 1, field(raw2, "dwColor"));
  eq("无 sidecar：dwDuplex 默认单面", 1, field(raw2, "dwDuplex"));
  eq("无 sidecar：dwCopies 默认 1", 1, field(raw2, "dwCopies"));

  // 3) sidecar 里是越界/非法值 → 必须被夹回合法区间，而不是原样透传给上游
  await writeFile(join(spool, "越界作业.pdf"), fixture);
  await writeFile(
    join(spool, "越界作业.pdf.opt"),
    JSON.stringify({ v: 1, copies: 999, duplex: 9, color: 7 }),
  );
  {
    const before = seen.length;
    for (let i = 0; i < 150 && seen.length === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const raw3 = seen[seen.length - 1].body.toString("latin1");
    eq("越界选项：dwColor 夹到 2", 2, field(raw3, "dwColor"));
    eq("越界选项：dwDuplex 夹到 3", 3, field(raw3, "dwDuplex"));
    eq("越界选项：dwCopies 夹到 99", 99, field(raw3, "dwCopies"));
  }

  // 4) sidecar 内容坏掉（不是 JSON）→ 按默认值提交，作业不能丢
  const badOpt = join(spool, "坏选项.pdf");
  await copyFile(FIXTURE, badOpt);
  await writeFile(`${badOpt}.opt`, "{ 这不是 JSON");
  {
    const before = seen.length;
    for (let i = 0; i < 150 && seen.length === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    eq("坏 sidecar：作业照样提交", true, seen.length > before);
    eq("坏 sidecar：颜色回落黑白", 1, field(seen[seen.length - 1].body.toString("latin1"), "dwColor"));
  }
} finally {
  await stopAll();
}

console.log(`\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
