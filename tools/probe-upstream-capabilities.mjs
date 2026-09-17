// 探针：验证上游的三个"可能已经改名/下线"的东西
//   1) wss://pms.sustech.edu.cn/ws?token=...   —— 进度通道（线上 web 客户端已完全不用它）
//   2) GET /api/client/PrintJob/Get            —— 我们用来兜底核实"作业真的进队列了吗"
//   3) POST /api/client/CloudPrint/Upload      —— 新的上传路由（已知存在，405 on GET）
import { loadSession } from "../lib/store.mjs";
import { CookieJar, DEFAULT_ORIGIN } from "../lib/pms.mjs";

const s = await loadSession();
const jar = new CookieJar(s.cookies);
const cookie = jar.header(DEFAULT_ORIGIN) || "";

// 1) WebSocket 握手
await new Promise((resolve) => {
  const url = "wss://pms.sustech.edu.cn/ws?token=probe-not-a-real-task";
  console.log(`[1] 尝试 WS 握手 ${url}`);
  const t0 = Date.now();
  let done = false;
  const finish = (verdict) => {
    if (done) return;
    done = true;
    console.log(`    -> ${verdict}（${Date.now() - t0}ms）\n`);
    try { ws.close(); } catch {}
    resolve();
  };
  let ws;
  try {
    ws = new WebSocket(url, { headers: { cookie, origin: DEFAULT_ORIGIN, "user-agent": "sustech-print-local" } });
  } catch (e) {
    return finish(`构造失败：${e.message}`);
  }
  ws.onopen = () => finish("握手成功 -> 进度通道仍然存在");
  ws.onerror = (e) => finish(`握手失败 -> 通道已下线（${e?.message || "error"}）`);
  ws.onclose = (e) => finish(`握手被关闭 code=${e?.code} -> 通道已下线`);
  setTimeout(() => finish("10s 超时 -> 视为不存在"), 10000);
});

// 2) + 3) HTTP 路由存在性（GET：405=存在，404=不存在）
for (const [label, path] of [
  ["PrintJob/Get（兜底核实用）", "/api/client/PrintJob/Get"],
  ["CloudPrint/Upload（新上传路由）", "/api/client/CloudPrint/Upload"],
  ["CloudPrint/UploadFile（旧路由）", "/api/client/CloudPrint/UploadFile"],
]) {
  const u = DEFAULT_ORIGIN + path;
  try {
    const r = await fetch(u, {
      method: "GET",
      headers: { cookie, origin: DEFAULT_ORIGIN, "user-agent": "sustech-print-local", referer: DEFAULT_ORIGIN + "/client/new/cprintPc/cprint.html" },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    const body = (await r.text()).slice(0, 130).replace(/\s+/g, " ");
    const verdict = r.status === 405 ? "存在" : r.status === 404 ? "不存在 <-- 改名/下线" : `其它(${r.status})`;
    console.log(`[2] GET ${label.padEnd(30)} -> ${r.status}  ${verdict}\n    ${body}\n`);
  } catch (e) {
    console.log(`[2] GET ${label}: ERR ${e.message}\n`);
  }
}
