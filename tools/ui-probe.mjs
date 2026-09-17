// 布局探针：无头加载界面，把关键元素的实际几何量打出来。
//
// 排查"下半部分是黑的""被红绿灯挡住"这类问题时光看代码是猜，
// 直接把 clientHeight / getBoundingClientRect 读出来最快。
//
//   node tools/mock-server.mjs &
//   ./node_modules/.bin/electron tools/ui-probe.mjs
//   PROBE_CLICK=1 ./node_modules/.bin/electron tools/ui-probe.mjs
//
// 窗口全程 show:false，不会弹到你脸上。

import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const URL_ = process.env.PROBE_URL || "http://127.0.0.1:8899";
const CLICK = process.env.PROBE_CLICK ? Number(process.env.PROBE_CLICK) : -1;
// 用真实 preload，否则 window.sustechDesktop 不存在，
// data-platform 会退化成 "web"，就测不到 macOS 的红绿灯安全区。
const PRELOAD = join(fileURLToPath(new URL(".", import.meta.url)), "..", "desktop", "preload.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `
(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(b.x), y: Math.round(b.y),
      w: Math.round(b.width), h: Math.round(b.height),
      bottom: Math.round(b.bottom),
      display: cs.display, position: cs.position,
      height: cs.height, overflowY: cs.overflowY,
    };
  };
  const appEl = document.getElementById('app');
  return {
    viewport: { innerH: window.innerHeight, innerW: window.innerWidth },
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    darkClass: document.documentElement.dataset.theme ?? null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    appChildren: appEl ? [...appEl.children].map((c) => c.tagName + (c.className ? '.' + String(c.className).split(' ')[0] : '')) : [],
    app: r('#app'),
    appDirectChildHeights: appEl ? [...appEl.children].map((c) => ({
      tag: c.tagName, cls: String(c.className || '').slice(0, 40), h: Math.round(c.getBoundingClientRect().height),
    })) : [],
    rootVarColor: getComputedStyle(document.documentElement).getPropertyValue('--n-color').trim(),
    // 深色模式回归：这些必须是深色，不能是白色兜底
    themeAttr: document.documentElement.dataset.theme ?? null,
    backgrounds: {
      body: getComputedStyle(document.body).backgroundColor,
      sidebar: (() => { const e = document.querySelector('.sidebar'); return e ? getComputedStyle(e).backgroundColor : null; })(),
      panel: (() => { const e = document.querySelector('.panel'); return e ? getComputedStyle(e).backgroundColor : null; })(),
      topbar: (() => { const e = document.querySelector('.topbar'); return e ? getComputedStyle(e).backgroundColor : null; })(),
    },
    shell: r('.shell'),
    sidebar: r('.sidebar'),
    brandTile: r('.brand-tile'),
    topbar: r('.topbar'),
    content: r('.content'),
    contentInner: r('.content-inner'),
    loginBg: r('.login-bg'),
    // 红绿灯安全区：macOS hiddenInset 下大约 x<92, y<34 是系统按钮的地盘
    trafficLightZoneOccupiedBy: (() => {
      const hits = [];
      for (const sel of ['.brand-tile', '.brand-text', '.sidebar-brand', '.topbar']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const b = el.getBoundingClientRect();
        if (b.x < 92 && b.y < 34) hits.push(sel + ' @' + Math.round(b.x) + ',' + Math.round(b.y));
      }
      return hits;
    })(),
  };
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1340,
    height: 880,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  await win.loadURL(URL_);
  await sleep(2600);

  if (CLICK >= 0) {
    await win.webContents.executeJavaScript(`
      (() => {
        const btns = [...document.querySelectorAll('.sidebar-nav button')];
        if (btns[${CLICK}]) btns[${CLICK}].click();
      })()
    `);
    await sleep(2200);
  }

  const data = await win.webContents.executeJavaScript(MEASURE);
  console.log(JSON.stringify(data, null, 2));

  const image = await win.webContents.capturePage();
  const { writeFile } = await import("node:fs/promises");
  const out = process.env.PROBE_SHOT || "/tmp/probe.png";
  await writeFile(out, image.toPNG());
  console.log(`shot -> ${out}`);

  app.quit();
});
