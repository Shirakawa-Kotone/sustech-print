// 开发用的假后端：不做任何登录，直接返回形状正确的假数据。
//
// 存在的理由：这个客户端只在校园网/学校 VPN 内可用，出门就没法调 UI 了。
// 有了它，改样式的时侯不用连学校网络，也能把每个页面渲染出来看。
//
//   node tools/mock-server.mjs            # 默认 127.0.0.1:8899
//   SUSTECH_SERVER_URL=http://127.0.0.1:8899 electron .
//
// 只在开发时用；打包产物里不包含这个文件（见 electron-builder.yml 的 files）。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(__dirname, "..", "web", "dist");
const PORT = Number(process.env.MOCK_PORT || 8899);
const HOST = process.env.MOCK_HOST || "127.0.0.1";

const nowSec = Math.floor(Date.now() / 1000);

const PAPERS = [
  { dwPaperID: 8, szPaperName: "A3" },
  { dwPaperID: 9, szPaperName: "A4" },
  { dwPaperID: 123, szPaperName: "A0" },
];

const PRINTERS = Array.from({ length: 26 }, (_, i) => {
  const idle = i % 3 !== 0;
  const broken = i === 7 || i === 19;
  return {
    id: 100 + i,
    name: `${["一教", "二教", "三教", "图书馆", "学生服务中心", "欣园"][i % 6]}${101 + i}室`,
    ip: `10.20.${Math.floor(i / 8) + 1}.${20 + i}`,
    mac: `00:1B:${String(i).padStart(2, "0")}:A1:B2:C3`,
    status: broken ? "失去联系" : idle ? "系统空闲" : "System Busy",
    driver: i % 5 === 0 ? "HP LaserJet M506" : "RICOH MP C3004",
    function: 3,
    tray1: 9,
    tray2: 8,
    openTime: 800,
    closeTime: 2200,
    updatedAt: nowSec - (i % 7) * 60,
  };
});

const JOBS = [
  { dwJobId: 88001, szJobName: "数据结构实验报告.pdf", szPaperDetail: '[{"dwPaperID":9}]', szAttribe: "single,nocolor", dwPages: 12, dwCopies: 1, dwCreateDate: "20260917", dwCreateTime: "141233" },
  { dwJobId: 88002, szJobName: "毕业论文-第三章.docx", szPaperDetail: '[{"dwPaperID":9}]', szAttribe: "double,color", dwPages: 34, dwCopies: 2, dwCreateDate: "20260917", dwCreateTime: "093001" },
  { dwJobId: 88003, szJobName: "课程表（更新）.xlsx", szPaperDetail: '[{"dwPaperID":9}]', szAttribe: "single,nocolor", dwPages: 2, dwCopies: 1, dwCreateDate: "20260916", dwCreateTime: "182045" },
  { dwJobId: 88004, szJobName: "组会汇报-0916.pptx", szPaperDetail: '[{"dwPaperID":8}]', szAttribe: "single,color", dwPages: 18, dwCopies: 1, dwCreateDate: "20260916", dwCreateTime: "101512" },
  { dwJobId: 88005, szJobName: "英语作文批改.pdf", szPaperDetail: '[{"dwPaperID":9}]', szAttribe: "single,nocolor", dwPages: 4, dwCopies: 1, dwCreateDate: "20260915", dwCreateTime: "204411" },
];

const SCANS = [
  { dwJobId: 77001, szName: "成绩单扫描件.pdf", dwPages: 2, dwTime: nowSec - 3600 },
  { dwJobId: 77002, szName: "身份证正反面.jpg", dwPages: 1, dwTime: nowSec - 86400 },
  { dwJobId: 77003, szName: "护照复印件.pdf", dwPages: 3, dwTime: nowSec - 86400 * 3 },
  { dwJobId: 77004, szName: "实验数据记录.pdf", dwPages: 8, dwTime: nowSec - 86400 * 9 },
];

const DOC_NAMES = [
  "离散数学作业.pdf", "大学物理实验报告.docx", "英语阅读材料.pdf",
  "线性代数习题.pdf", "毛概论文终稿.docx", "计算机网络实验.pdf",
  "操作系统课程设计.pdf", "概率论复习提纲.pdf", "软件工程需求文档.docx",
  "数字电路实验报告.pdf",
];

const HISTORY = Array.from({ length: 46 }, (_, i) => {
  const type = [1, 1, 1, 3, 2][i % 5];
  const pages = 1 + ((i * 7) % 22);
  const free = type === 2 ? 0 : pages * 8;
  return {
    dwSID: 500000 + i,
    dwTime: nowSec - i * 38000 - 600,
    szDocName: DOC_NAMES[i % DOC_NAMES.length],
    dwPaperID: i % 9 === 0 ? 8 : 9,
    dwPages: pages,
    dwUsedFreeMoney: free,
    dwUsedMoney: i % 11 === 0 ? pages * 10 : 0,
    dwUsedCardMoney: 0,
    dwMFPSN: PRINTERS[i % PRINTERS.length].id,
    dwType: type,
  };
});

const usedCents = HISTORY.reduce((s, r) => s + r.dwUsedFreeMoney, 0);
const paidCents = HISTORY.reduce((s, r) => s + r.dwUsedMoney + r.dwUsedCardMoney, 0);
const pages = HISTORY.reduce((s, r) => s + r.dwPages, 0);

const SUMMARY = {
  user: {
    logonName: "12345678",
    trueName: "陈同学",
    cardNo: "2026****8888",
    serverSubsidy: Math.round((10000 - usedCents)) / 100,
  },
  subsidy: {
    perYear: 100,
    academicYearStart: "20260901",
    academicYearEnd: "20260917",
    used: usedCents / 100,
    remainingComputed: Math.round(10000 - usedCents) / 100,
    serverReported: Math.round(10000 - usedCents) / 100,
    paid: paidCents / 100,
    pages,
    records: HISTORY.length,
  },
  history: HISTORY,
  counts: { pendingJobs: JOBS.length, scans: SCANS.length },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === "/api/session") {
    return json(res, {
      loggedIn: true,
      user: { logonName: "12345678", trueName: "陈同学", cardNo: "2026****8888", sex: 1 },
    });
  }
  if (p === "/api/summary") return json(res, SUMMARY);
  if (p === "/api/printers") return json(res, { printers: PRINTERS, servers: [] });
  if (p === "/api/jobs") return json(res, { jobs: JOBS });
  if (p === "/api/scans") return json(res, { scans: SCANS });
  if (p === "/api/papers") return json(res, { papers: PAPERS });
  if (p === "/api/history") {
    const types = (url.searchParams.get("types") || "1,2,3").split(",").map(Number);
    return json(res, {
      begin: "20260901",
      end: "20260917",
      types,
      rows: HISTORY.filter((r) => types.includes(r.dwType)),
    });
  }
  if (p === "/api/driver/status") {
    return json(res, {
      ok: true,
      loggedIn: true,
      user: { logonName: "12345678", trueName: "陈同学" },
      printerName: "南科大云打印",
    });
  }
  if (p.startsWith("/api/")) return json(res, { ok: true, deleted: 0, failed: 0, results: [] });

  // 静态资源
  const rel = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, "");
  const file = p === "/" ? join(DIST, "index.html") : join(DIST, rel);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    const fallback = await readFile(join(DIST, "index.html")).catch(() => null);
    if (!fallback) {
      res.writeHead(500);
      return res.end("web/dist 还没构建，先跑 npm --prefix web run build");
    }
    res.writeHead(200, { "content-type": MIME[".html"], "content-length": fallback.length });
    res.end(fallback);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  [mock] 假数据服务已启动: http://${HOST}:${PORT}`);
  console.log(`  [mock] 用 SUSTECH_SERVER_URL=http://${HOST}:${PORT} electron . 来指向它\n`);
});
