#!/bin/sh
#
# make-fixtures.sh —— 生成测试用的真实 PDF / PostScript 文件
# ---------------------------------------------------------------------------
# 不依赖任何第三方工具：
#   - PDF  ：优先生成一个最小合法 PDF（手工写入），再用 cupsfilter 走一遍
#            CUPS 自己的滤镜链，得到"真·打印机产出的 PDF"作为对照
#   - PS   ：手写 PostScript
#
# 结果写到 $1（默认 test/fixtures）

set -eu
OUT="${1:-$(cd "$(dirname "$0")" && pwd)/fixtures}"
mkdir -p "$OUT"

# ---------------------------------------------------------------------------
# 1. 手写的最小单页 PDF（含中文，验证 UTF-8 全链路）
# ---------------------------------------------------------------------------
# 用 Node 精确算好 xref 偏移，避免手工数错字节。
/usr/local/bin/node - "$OUT/sample-zh.pdf" <<'NODE'
const fs = require("fs");
const out = process.argv[2];

function buildPdf() {
  const objects = [];
  // 中文用 UTF-16BE + BOM 写进 PDF 字符串（PDF 规范要求）
  const zh = (s) => "<" + Buffer.from("\uFEFF" + s, "utf16le").swap16().toString("hex").toUpperCase() + ">";
  const content = [
    "BT /F1 20 Tf 60 760 Td (SUSTech Cloud Print - macOS driver test) Tj ET",
    `BT /F1 22 Tf 60 720 Td ${zh("南科大云打印 驱动测试")} Tj ET`,
    `BT /F1 14 Tf 60 680 Td ${zh("第二行：中文标题与文件名编码验证")} Tj ET`,
    "BT /F1 12 Tf 60 640 Td (Generated locally, no external tools.) Tj ET",
    // 一个方块，方便肉眼确认 PDF 真的能渲染
    "0.1 0.3 0.8 rg 60 540 300 60 re f",
  ].join("\n");

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] " +
    "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  const stream = Buffer.from(content, "latin1");
  objects[4] =
    `<< /Length ${stream.length} >>\nstream\n` + content + `\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

fs.writeFileSync(out, buildPdf());
console.log("wrote", out, fs.statSync(out).size, "bytes");
NODE

# ---------------------------------------------------------------------------
# 2. 真·CUPS 产出的 PDF（走 cgtexttopdf），作为"应用打印出来的是什么"的对照
# ---------------------------------------------------------------------------
TXT="$OUT/source.txt"
{
  printf 'SUSTech Cloud Print test document\n'
  printf '南科大云打印 测试文档\n'
  printf 'This PDF was produced by the CUPS filter chain (cgtexttopdf).\n'
} >"$TXT"

if command -v cupsfilter >/dev/null 2>&1; then
    if cupsfilter -i text/plain -m application/pdf "$TXT" >"$OUT/sample-cupsfilter.pdf" 2>/dev/null; then
        printf 'wrote %s %s bytes (via cupsfilter/cgtexttopdf)\n' \
            "$OUT/sample-cupsfilter.pdf" "$(wc -c <"$OUT/sample-cupsfilter.pdf")"
    else
        printf 'warn: cupsfilter 生成 PDF 失败，跳过\n' >&2
    fi
fi

# ---------------------------------------------------------------------------
# 3. 手写 PostScript
# ---------------------------------------------------------------------------
cat >"$OUT/sample.ps" <<'PS'
%!PS-Adobe-3.0
%%Creator: sustech-print test harness
%%Title: SUSTech Cloud Print PS test
%%Pages: 1
%%BoundingBox: 0 0 595 842
%%EndComments
%%Page: 1 1
/Helvetica-Bold findfont 24 scalefont setfont
60 760 moveto (SUSTech Cloud Print) show
/Helvetica findfont 16 scalefont setfont
60 720 moveto (PostScript input test page) show
showpage
%%EOF
PS
printf 'wrote %s %s bytes\n' "$OUT/sample.ps" "$(wc -c <"$OUT/sample.ps")"

# ---------------------------------------------------------------------------
# 4. 非 PDF/PS 的垃圾数据（验证格式判定会拒绝）
# ---------------------------------------------------------------------------
printf 'this is not a PDF or PostScript\n' >"$OUT/sample.txt"

# ---------------------------------------------------------------------------
# 5. 空文件
# ---------------------------------------------------------------------------
: >"$OUT/sample-empty.bin"

ls -la "$OUT"
