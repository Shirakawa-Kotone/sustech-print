// 生成应用图标与托盘图标（**兜底路径**）。
//
// ⚠️ 现在图标的"源"是 build/icon.svg，由 tools/render-icon.py 光栅化。
//    只要 build/icon.svg 还在，本脚本就会直接退出、不覆盖任何东西 ——
//    否则跑一次就会把 SVG 做的图标悄悄换回程序化图形。
//
// 这条路径保留的意义：完全不依赖第三方图形库。手写最小 PNG 编码器
// （zlib + CRC32）+ 解析式形状 + 超采样，所以哪怕没有 cairosvg 也能出图。
// 想回到程序化图形：删掉 build/icon.svg 再跑本脚本。
//
//   node desktop/make-icons.mjs                    # 有 SVG 时会提示改用 python
//   node desktop/make-icons.mjs --variant=outline   # 兜底路径的字形方案
//
// 产物：
//   build/icon.png                 1024x1024  macOS 打包用
//   build/icon.ico                 多尺寸     Windows 打包用（exe / 安装包 / 快捷方式）
//   desktop/assets/tray.png        32x32      Windows 托盘（彩色）
//   desktop/assets/trayTemplate.png    16x16  macOS 托盘（黑+alpha，模板图）
//   desktop/assets/trayTemplate@2x.png 32x32  macOS 托盘高分屏

import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

/* ------------------------------------------------------------- PNG 编码 --- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Uint8Array，长度 w*h*4 */
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节（0 = None）
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- 图形 --- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形的有符号距离（<0 在内部）。 */
function roundRectSdf(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const A = [0x2f, 0x5b, 0xff]; // 品牌蓝
const B = [0x6f, 0x4b, 0xff]; // 品牌紫

/**
 * 画一个图标。
 * mode = "color"    圆角渐变底 + 白色打印机字形
 * mode = "template" 只有黑色 + alpha 的打印机字形（macOS 菜单栏模板图）
 * options.variant   字形方案，见 glyphAlpha
 * options.simple    true 时强制用简化字形（小尺寸下细节会糊成一团）
 */
function render(size, mode, ss = 2, options = {}) {
  const variant = options.variant ?? "solid";
  const simple = options.simple ?? mode === "template";
  const out = new Uint8Array(size * size * 4);
  const n = size * ss;
  const scale = n / 100; // 用 0..100 的坐标系描述形状

  // 超采样缓冲：累积颜色与覆盖率
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = ((x * ss + sx + 0.5) / n) * 100;
          const uy = ((y * ss + sy + 0.5) / n) * 100;

          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;

          if (mode === "color") {
            // 底：圆角方块 + 斜向渐变
            const dBg = roundRectSdf(ux, uy, 6, 6, 88, 88, 22);
            const cov = clamp01(0.5 - (dBg * scale) / 1);
            if (cov > 0) {
              const t = clamp01((ux + uy) / 200);
              const [gr, gg, gb] = mix(A, B, t);
              cr = gr;
              cg = gg;
              cb = gb;
              ca = cov;
            }
            // 前景白色字形
            const glyph = glyphAlpha(ux, uy, scale, variant, simple);
            if (glyph > 0) {
              cr = 255;
              cg = 255;
              cb = 255;
              ca = Math.max(ca, glyph);
            }
          } else {
            const glyph = glyphAlpha(ux, uy, scale, variant, true);
            cr = 0;
            cg = 0;
            cb = 0;
            ca = glyph;
          }

          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }

      const total = ss * ss;
      const alpha = a / total;
      const i = (y * size + x) * 4;
      if (alpha > 0.0001) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return out;
}

/**
 * 打印机字形。坐标系 0..100。返回覆盖率 0..1。
 *
 * 两个曾经把图标做丑的坑，都记在这里：
 *
 *   1. 距离必须乘 scale 才能变成"像素"。原先漏了，于是抗锯齿的过渡带是按
 *      0..100 的设计单位算的 —— 1 个单位在 1024px 图上是 10px，白边糊成一片，
 *      整张图看起来就是脏的。
 *   2. 三个白色圆角矩形直接堆叠会互相吃掉，读出来是一坨白块而不是打印机。
 *      现在的做法是先用"外扩的机身"在纸和机身之间挖出一条背景色的缝
 *      （见 body(GAP)），有了负空间，形状才立得住。
 *
 * variant:
 *   classic  旧版：三块直接堆叠 + 一个状态灯洞（留作对比）
 *   solid    机身 + 上方进纸 + 机身上的出纸槽
 *   sheets   机身 + 上方进纸 + 下方出纸，三块之间都留缝
 *   outline  机身画成线稿 + 实心进纸
 * simple: 小尺寸下只留最少部件，缝会缩成噪点所以不留缝
 */
function glyphAlpha(ux, uy, scale, variant, simple) {
  const rr = (x, y, w, h, r) => roundRectSdf(ux, uy, x, y, w, h, r);
  const cov = (d) => clamp01(0.5 - d * scale);

  let out = 0;
  const add = (d) => {
    const c = cov(d);
    if (c > out) out = c;
  };
  const cut = (d) => {
    out = Math.max(0, out - cov(d));
  };

  if (variant === "classic") {
    add(rr(22, 14, 56, 34, 6));
    add(rr(10, 42, 80, 34, 11));
    add(rr(24, 60, 52, 27, 5));
    cut(rr(74, 50, 10, 8, 3));
    return out;
  }

  // 机身；g 是外扩量，用来在它周围留出背景色的缝
  const body = (g = 0) => rr(13 - g, 36 - g, 74 + 2 * g, 40 + 2 * g, 11 + g);

  if (simple) {
    // 小尺寸：机身 + 进纸。不留缝，也不画槽
    add(rr(30, 12, 40, 30, 5));
    add(body());
    return out;
  }

  const GAP = 3.2;

  if (variant === "outline") {
    add(rr(30, 10, 40, 34, 5)); // 实心进纸
    cut(body(GAP));
    add(Math.abs(body()) - 3); // 机身只画 6 个单位宽的线
    add(rr(31, 50, 38, 5, 2.5)); // 出纸槽
    return out;
  }

  if (variant === "sheets") {
    add(rr(30, 8, 40, 36, 5)); // 上方进纸
    add(rr(26, 70, 48, 22, 4)); // 下方出纸
    cut(body(GAP));
    add(body());
    return out;
  }

  // solid
  add(rr(30, 10, 40, 34, 5)); // 上方进纸
  cut(body(GAP));
  add(body());
  cut(rr(31, 50, 38, 5, 2.5)); // 出纸槽
  return out;
}

/* ------------------------------------------------------------- ICO 编码 --- */

/**
 * 把若干张 PNG 打包成 .ico。
 *
 * Vista 以后 ICO 的每一项都可以直接内嵌 PNG（PNG 压缩的 ICO），
 * 于是不必去写 BMP/DIB 那套调色板、行倒序与 4 字节对齐的逻辑。
 * 宽高字段是 1 字节，256 记作 0。
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1（图标，不是光标）
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, png }, i) => {
    const p = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, p + 0); // width
    dir.writeUInt8(size >= 256 ? 0 : size, p + 1); // height
    dir.writeUInt8(0, p + 2); // 调色板颜色数（真彩色为 0）
    dir.writeUInt8(0, p + 3); // reserved
    dir.writeUInt16LE(1, p + 4); // color planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32LE(png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

/* ------------------------------------------------------------- 对比图 --- */

/** 所有可选字形方案。改默认值就改这里的第一个，或者用 --variant=名字。 */
const VARIANTS = ["classic", "solid", "sheets", "outline"];

/**
 * 把各方案拼成一张对比图。
 *
 * 为什么要有这个东西：这个脚本是"闭着眼睛"写图形的 —— 作者看不到渲染结果，
 * 只能靠人来看图挑。所以留一条专门出图给人看的路径，别去猜。
 * 布局：一行一个方案，一列一个尺寸。
 */
function previewSheet(variants, sizes, cell = 288) {
  const W = sizes.length * cell;
  const H = variants.length * cell;
  const out = new Uint8Array(W * H * 4);

  // 浅灰底 + 每格一条分隔线
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const grid = x % cell < 2 || y % cell < 2;
      out[i] = grid ? 0xd6 : 0xf5;
      out[i + 1] = grid ? 0xdb : 0xf6;
      out[i + 2] = grid ? 0xe5 : 0xf8;
      out[i + 3] = 255;
    }
  }

  variants.forEach((variant, row) => {
    sizes.forEach((size, col) => {
      const rgba = render(size, "color", size <= 64 ? 4 : 2, { variant });
      const ox = col * cell + Math.floor((cell - size) / 2);
      const oy = row * cell + Math.floor((cell - size) / 2);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const src = (y * size + x) * 4;
          const dst = ((oy + y) * W + ox + x) * 4;
          const a = rgba[src + 3] / 255;
          out[dst] = Math.round(rgba[src] * a + out[dst] * (1 - a));
          out[dst + 1] = Math.round(rgba[src + 1] * a + out[dst + 1] * (1 - a));
          out[dst + 2] = Math.round(rgba[src + 2] * a + out[dst + 2] * (1 - a));
        }
      }
    });
  });

  return { W, H, rgba: out };
}

/* ----------------------------------------------------------------- 写盘 --- */

async function main() {
  // SVG 优先：见文件头。这里必须早于任何写盘动作。
  if (existsSync(join(ROOT, "build", "icon.svg"))) {
    console.log("检测到 build/icon.svg —— 图标以它为准，本脚本不做任何改动。");
    console.log("重新生成图标请用：");
    console.log("    python3 tools/render-icon.py        # 需要 cairosvg（brew install cairosvg）");
    console.log("想改回程序化图形：先删掉 build/icon.svg。");
    return;
  }

  const picked = process.argv
    .find((a) => a.startsWith("--variant="))
    ?.slice("--variant=".length);
  const variant = VARIANTS.includes(picked) ? picked : "solid";

  await mkdir(join(ROOT, "build"), { recursive: true });
  await mkdir(join(__dirname, "assets"), { recursive: true });

  const jobs = [
    [join(ROOT, "build", "icon.png"), render(1024, "color", 2, { variant }), 1024],
    [join(__dirname, "assets", "tray.png"), render(32, "color", 4, { variant }), 32],
    [join(__dirname, "assets", "trayTemplate.png"), render(16, "template", 8), 16],
    [join(__dirname, "assets", "trayTemplate@2x.png"), render(32, "template", 4), 32],
  ];

  for (const [path, rgba, size] of jobs) {
    await writeFile(path, encodePng(size, size, rgba));
    console.log(`已生成 ${path} (${size}x${size})`);
  }

  // Windows 的 .ico 要带全套尺寸：任务栏/标题栏取 16，桌面快捷方式取 32/48，
  // 资源管理器大图标取 256。小尺寸换简化字形，否则细节糊成一团。
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = encodeIco(
    icoSizes.map((size) => ({
      size,
      png: encodePng(
        size,
        size,
        render(size, "color", size <= 32 ? 6 : 2, { variant, simple: size <= 24 }),
      ),
    })),
  );
  await writeFile(join(ROOT, "build", "icon.ico"), ico);

  // 对比图（下面几行是给人看的，不是给构建用的）
  const sheet = previewSheet(VARIANTS, [256, 96, 48, 32]);
  await mkdir(join(ROOT, "screens"), { recursive: true });
  const sheetPath = join(ROOT, "screens", "icon-preview.png");
  await writeFile(sheetPath, encodePng(sheet.W, sheet.H, sheet.rgba));

  console.log("");
  console.log(`当前采用方案 : ${variant}   （换方案：node desktop/make-icons.mjs --variant=名字）`);
  console.log(`对比图       : ${sheetPath}`);
  console.log(`  行（上→下）: ${VARIANTS.join(" / ")}`);
  console.log(`  列（左→右）: 256 / 96 / 48 / 32`);
  console.log(`已生成 ${join(ROOT, "build", "icon.ico")} (${icoSizes.join("/")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
