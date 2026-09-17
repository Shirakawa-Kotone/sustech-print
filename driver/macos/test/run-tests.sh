#!/bin/sh
#
# run-tests.sh —— sustech-print backend（落盘版）的端到端测试
# ---------------------------------------------------------------------------
# **不需要 root、不需要 sudo、不改动系统。**
#
# 覆盖：
#   A. 按 cupsd 的 argv/env/stdin 约定直接驱动 backend
#      —— 含 **HOME=/var/spool/cups/tmp 回归用例**（这正是线上翻车的原因）
#   B. capture backend：记录 CUPS 到底把什么交给 backend（argv/stdin 字节）
#   C. PPD 滤镜链：证明 PDF 直通、不需要 Ghostscript
#   D. 原子性 / 中断 / 唯一性等落盘语义
#   E. install.sh / uninstall.sh（沙箱 prefix，真跑）
#
# 用法：
#   sh run-tests.sh            # 全部
#   sh run-tests.sh --fast     # 跳过较慢的用例

set -u

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
DRIVER_DIR="$(cd "$TEST_DIR/.." && pwd)"
BACKEND="$DRIVER_DIR/sustech-print"
PPD="$DRIVER_DIR/sustech-print.ppd"
FIXTURES="$TEST_DIR/fixtures"
WORK="$TEST_DIR/.work"

# CUPS 给 backend 设的 HOME（线上实测值）。回归用例会显式用它。
CUPS_HOME="/var/spool/cups/tmp"

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

PASS=0; FAIL=0; SKIP=0
say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33mSKIP\033[0m %s\n' "$*"; }

assert_eq() {
    if [ "$2" = "$3" ]; then ok "$1（=$3）"; else bad "$1：期望 [$2] 实际 [$3]"; fi
}
assert_contains() {
    if grep -q -- "$3" "$2" 2>/dev/null; then ok "$1"; else bad "$1：在 $2 里找不到 [$3]"; fi
}
assert_not_exists() {
    if [ ! -e "$2" ]; then ok "$1"; else bad "$1：$2 竟然存在"; fi
}

# ---------------------------------------------------------------------------
# 环境
# ---------------------------------------------------------------------------

[ -f "$FIXTURES/sample-zh.pdf" ] || sh "$TEST_DIR/make-fixtures.sh" >/dev/null

rm -rf "$WORK"
mkdir -p "$WORK/logs" "$WORK/out" "$WORK/bin"
SPOOL="$WORK/spool"
INCOMING="$SPOOL/incoming"
mkdir -p "$INCOMING"

BACKEND_OUT="$WORK/logs/backend.out"
BACKEND_ERR="$WORK/logs/backend.err"
DRIVER_LOG="$SPOOL/driver.log"

# 每次调用前清空 incoming，便于断言"这次产出了什么"
clear_incoming() { rm -f "$INCOMING"/*.pdf 2>/dev/null; }
incoming_list()  { ls -1 "$INCOMING" 2>/dev/null | grep -v '^\.[a-z]' ; }
incoming_count() { incoming_list | wc -l | tr -d ' '; }

# ---------------------------------------------------------------------------
# 按 cupsd 的约定驱动 backend。
#   $1 输入文件  $2 title  $3 copies(argv[4])  $4 options(argv[5])  $5 HOME
# 环境里显式带上 DEVICE_URI / PRINTER / CUPS_* ，以及 SUSTECH_SPOOL_DIR。
# ---------------------------------------------------------------------------
run_backend() {
    _in="$1"; _title="$2"; _copies="$3"; _opts="$4"; _home="${5:-$HOME}"
    : >"$BACKEND_OUT"; : >"$BACKEND_ERR"
    if [ -n "$_in" ]; then
        env -i \
            PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
            HOME="$_home" \
            LANG="zh_CN.UTF-8" \
            CHARSET="utf-8" \
            DEVICE_URI="sustech-print:/sustech" \
            PRINTER="南科大云打印" \
            CUPS_SERVERBOT="/usr/libexec/cups/daemon/cups-deviced" \
            CUPS_SERVERBIN="/usr/libexec/cups" \
            CUPS_SERVERROOT="/etc/cups" \
            SUSTECH_SPOOL_DIR="$INCOMING" \
            "$BACKEND" 42 chen "$_title" "$_copies" "$_opts" \
            <"$_in" >"$BACKEND_OUT" 2>"$BACKEND_ERR"
        RC=$?
    else
        env -i \
            PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
            HOME="$_home" \
            LANG="zh_CN.UTF-8" \
            CHARSET="utf-8" \
            DEVICE_URI="sustech-print:/sustech" \
            PRINTER="南科大云打印" \
            SUSTECH_SPOOL_DIR="$INCOMING" \
            "$BACKEND" 42 chen "$_title" "$_copies" "$_opts" \
            </dev/null >"$BACKEND_OUT" 2>"$BACKEND_ERR"
        RC=$?
    fi
}

# 用一个"假 CUPS HOME"驱动（回归用例专用）
run_backend_cups_home() { run_backend "$1" "$2" "$3" "$4" "$CUPS_HOME"; }

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " A. 基础语义"
say "=============================================================="

say ""
say "A1. PDF 落盘：exit 0、字节一致、文件名带中文标题"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "中文标题测试" 2 "copies=2 sides=two-sided-long-edge"
assert_eq "PDF 落盘退出码" 0 "$RC"
assert_eq "incoming 里恰好 1 个文件" 1 "$(incoming_count)"
GOT="$(incoming_list | head -1)"
say "    产出文件：$GOT"
if cmp -s "$FIXTURES/sample-zh.pdf" "$INCOMING/$GOT"; then
    ok "落盘内容与输入 PDF 逐字节相同"
else
    bad "落盘内容与输入不一致"
fi
case "$GOT" in
    *.pdf) ok "文件以 .pdf 结尾" ;;
    *) bad "文件后缀不是 .pdf：$GOT" ;;
esac
case "$GOT" in
    *中文标题测试*) ok "文件名保留了中文标题" ;;
    *) bad "文件名没有中文标题：$GOT" ;;
esac
if [ -s "$BACKEND_OUT" ]; then bad "stdout 必须为空，实际有输出"; else ok "stdout 为空"; fi
assert_contains "驱动日志记录落盘" "$DRIVER_LOG" "已落盘"
assert_contains "驱动日志记录标题" "$DRIVER_LOG" "中文标题测试"

say ""
say "A2. 标题里的路径危险字符被清理（不产生子目录、不逃逸）"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "../../etc/pa:sswd*x?\"<>|" 1 ""
assert_eq "危险标题退出码" 0 "$RC"
assert_eq "仍然只产出 1 个文件（没有建目录）" 1 "$(incoming_count)"
GOT="$(incoming_list | head -1)"
case "$GOT" in
    */*) bad "文件名里竟然有路径分隔符：$GOT" ;;
    *) ok "文件名不含路径分隔符（=${GOT}）" ;;
esac
if [ -e "$SPOOL/../etc" ] || [ -e "$WORK/etc" ]; then bad "标题导致了路径逃逸"; else ok "没有路径逃逸"; fi

say ""
say "A3. title 为空 → 仍要有合法文件名"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "" 1 ""
assert_eq "空标题退出码" 0 "$RC"
assert_eq "空标题也产出 1 个文件" 1 "$(incoming_count)"
_f="$(incoming_list | head -1)"
case "$_f" in
    *云打印*.pdf) ok "文件名回退为「云打印」（=${_f}）" ;;
    *) bad "空标题的文件名不合预期：[${_f}]" ;;
esac

say ""
say "A4. copies / options 非法不影响落盘（落盘版不解析这些，只记日志）"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "copies 测试" 1 "copies=abc"
assert_eq "copies=abc 仍成功落盘" 0 "$RC"
assert_eq "产出 1 个文件" 1 "$(incoming_count)"

say ""
say "A5. 空作业 → exit 1，且不产出文件"
clear_incoming
run_backend "$FIXTURES/sample-empty.bin" "空文件" 1 ""
assert_eq "空作业退出码" 1 "$RC"
assert_eq "空作业不产出文件" 0 "$(incoming_count)"

say ""
say "A6. 非 PDF/PS 数据 → exit 1，且不产出文件"
clear_incoming
run_backend "$FIXTURES/sample.txt" "垃圾输入" 1 ""
assert_eq "垃圾输入退出码" 1 "$RC"
assert_eq "垃圾输入不产出文件" 0 "$(incoming_count)"

say ""
say "A7. PostScript 输入"
clear_incoming
run_backend "$FIXTURES/sample.ps" "PS 测试" 1 ""
if command -v ps2pdf >/dev/null 2>&1 || command -v gs >/dev/null 2>&1 || \
   command -v pstopdf >/dev/null 2>&1 || command -v mutool >/dev/null 2>&1; then
    assert_eq "PS 输入（本机有转换器）退出码" 0 "$RC"
    assert_contains "日志说明做了转换" "$DRIVER_LOG" "转换为 PDF"
else
    assert_eq "PS 输入（本机无转换器）退出码" 1 "$RC"
    assert_eq "PS 输入不产出文件（不能写出坏文件）" 0 "$(incoming_count)"
    assert_contains "日志说明缺转换器" "$DRIVER_LOG" "没有 PS→PDF 转换器"
fi

say ""
say "A8. 连续打印两次 → 两个不同的文件名（唯一性）"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "唯一性测试" 1 ""
F1="$(incoming_list | head -1)"
run_backend "$FIXTURES/sample-zh.pdf" "唯一性测试" 1 ""
assert_eq "两次打印产出 2 个文件" 2 "$(incoming_count)"
F2="$(incoming_list | grep -v -F -x "$F1" | head -1)"
if [ -n "$F1" ] && [ -n "$F2" ] && [ "$F1" != "$F2" ]; then
    ok "两个文件名不同：$F1 / $F2"
else
    bad "文件名重复或缺失：[$F1] [$F2]"
fi
if cmp -s "$F1" "$F2" 2>/dev/null; then
    true
fi
if cmp -s "$INCOMING/$F1" "$INCOMING/$F2"; then
    ok "两个文件内容都正确"
else
    bad "两个文件内容不一致"
fi

say ""
say "A9. 不产生 stdout（CUPS 会把 stdout 当设备 URI）"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "stdout 测试" 1 ""
assert_eq "成功路径 stdout 字节数" 0 "$(wc -c <"$BACKEND_OUT" | tr -d ' ')"
run_backend "$FIXTURES/sample.txt" "stdout 失败路径" 1 ""
assert_eq "失败路径 stdout 字节数" 0 "$(wc -c <"$BACKEND_OUT" | tr -d ' ')"

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " B. 【回归】HOME 不是用户家目录（线上翻车的根因）"
say "=============================================================="
#
# 实测 CUPS error_log：
#   [Job 205] 未找到驱动令牌
#     /private/var/spool/cups/tmp/Library/Application Support/SUSTechPrint/driver-token
# 说明 CUPS 给 backend 的 HOME 是 /var/spool/cups/tmp。
# v1 依赖 $HOME 找配置 → 必然失败。v2 只看 SUSTECH_SPOOL_DIR / 固定系统路径。

say ""
say "B1. HOME=$CUPS_HOME 时依然能落盘"
clear_incoming
run_backend_cups_home "$FIXTURES/sample-zh.pdf" "CUPS HOME 回归" 1 ""
assert_eq "HOME=$CUPS_HOME 退出码" 0 "$RC"
assert_eq "HOME=$CUPS_HOME 也产出 1 个文件" 1 "$(incoming_count)"
GOT="$(incoming_list | head -1)"
if cmp -s "$FIXTURES/sample-zh.pdf" "$INCOMING/$GOT"; then
    ok "HOME=$CUPS_HOME 下落盘内容依然正确"
else
    bad "HOME=$CUPS_HOME 下落盘内容不对"
fi
if [ -e "$CUPS_HOME/Library" ]; then
    bad "backend 竟然在 $CUPS_HOME 下建了 Library 目录"
else
    ok "没有在 CUPS 的 HOME 下建任何东西"
fi

say ""
say "B2. HOME 为空 / HOME 指向不存在目录 也要能工作"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "HOME 为空" 1 "" ""
assert_eq "HOME='' 退出码" 0 "$RC"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "HOME 不存在" 1 "" "/nonexistent-home-xyz"
assert_eq "HOME=/nonexistent 退出码" 0 "$RC"

say ""
say "B3. backend 源码里不得再用 \$HOME 定位任何东西"
if grep -n '\$HOME\|${HOME}' "$BACKEND" | grep -v '^\s*[0-9]*:#' | grep -q .; then
    bad "源码里仍有 \$HOME 展开："
    grep -n '\$HOME\|${HOME}' "$BACKEND" | grep -v ':#' | sed 's/^/      /'
else
    ok "源码里没有可执行的 \$HOME 展开（只有注释里的说明）"
fi
if grep -q 'Library/Application Support' "$BACKEND"; then
    if grep -n 'Library/Application Support' "$BACKEND" | grep -v ':#' | grep -q .; then
        bad "源码里仍有 Library/Application Support 路径"
    else
        ok "Library/Application Support 只出现在注释里"
    fi
else
    ok "源码里没有 Library/Application Support"
fi
for pat in 'curl' 'open -a' 'x-driver-token' 'api-port'; do
    if grep -v '^\s*#' "$BACKEND" | grep -q -- "$pat"; then
        bad "源码里不应再出现 [$pat]"
    fi
done
ok "源码里没有 curl / open -a / 令牌 / api-port"

say ""
say "B4. spool 目录不存在时给出明确错误（而不是去写 \${HOME}）"
clear_incoming
: >"$BACKEND_OUT"; : >"$BACKEND_ERR"
env -i PATH="/usr/bin:/bin" HOME="$CUPS_HOME" SUSTECH_SPOOL_DIR="$WORK/no-such-spool/incoming" \
    "$BACKEND" 42 chen "缺目录" 1 "" <"$FIXTURES/sample-zh.pdf" \
    >"$BACKEND_OUT" 2>"$BACKEND_ERR"
RC=$?
assert_eq "spool 目录缺失退出码" 1 "$RC"
assert_contains "错误信息指出目录缺失" "$BACKEND_ERR" "spool 目录不存在"

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " C. 落盘语义：原子性 / 中断 / 暂存区"
say "=============================================================="

say ""
say "C1. App 监听的 incoming 里不会出现暂存文件（只能看到 .pdf）"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "暂存测试" 1 ""
STRAY="$(ls -1a "$INCOMING" 2>/dev/null | grep -E '^\.sustech-print' || true)"
if [ -z "$STRAY" ]; then ok "没有残留的暂存文件"; else bad "incoming 里有暂存残留：$STRAY"; fi
assert_eq "incoming 里只有 1 个条目（就是那个 pdf）" 1 "$(incoming_count)"

say ""
say "C2. 用失败的 mv 模拟"写完却搬不过去" → exit 1、incoming 无文件"
# 造一个假的 mv：只对"搬进 incoming"这一步失败
FAKEBIN="$WORK/bin"
cat >"$FAKEBIN/mv" <<FAKEMV
#!/bin/sh
case "\$*" in
    *"$INCOMING"*) exit 1 ;;
esac
exec /bin/mv "\$@"
FAKEMV
chmod +x "$FAKEBIN/mv"
clear_incoming
: >"$BACKEND_OUT"; : >"$BACKEND_ERR"
env -i PATH="$FAKEBIN:/usr/bin:/bin" HOME="$CUPS_HOME" \
    SUSTECH_SPOOL_DIR="$INCOMING" \
    "$BACKEND" 42 chen "mv 失败" 1 "" <"$FIXTURES/sample-zh.pdf" \
    >"$BACKEND_OUT" 2>"$BACKEND_ERR"
RC=$?
assert_eq "mv 失败时退出码" 1 "$RC"
assert_eq "mv 失败时 incoming 里没有文件" 0 "$(incoming_count)"
assert_contains "日志说明搬移失败" "$BACKEND_ERR" "无法把作业移动到"
rm -f "$FAKEBIN/mv"

say ""
say "C3. 落盘过程中被 SIGTERM 打断 → incoming 无文件、暂存区被清理"
clear_incoming
rm -rf "$SPOOL/.staging"
FIFO="$WORK/fifo"
rm -f "$FIFO"; mkfifo "$FIFO"
env -i PATH="/usr/bin:/bin" HOME="$CUPS_HOME" SUSTECH_SPOOL_DIR="$INCOMING" \
    "$BACKEND" 42 chen "中断测试" 1 "" <"$FIFO" >"$BACKEND_OUT" 2>"$BACKEND_ERR" &
BPID=$!
# 打开写端并写半份 PDF，保持打开状态 → backend 阻塞在读取
exec 3>"$FIFO"
printf '%%PDF-1.4\n' >&3
printf 'partial data partial data partial data\n' >&3
sleep 1
kill -TERM "$BPID" 2>/dev/null
exec 3>&-
wait "$BPID" 2>/dev/null
RC=$?
sleep 0.5
assert_eq "被中断时 incoming 里没有文件" 0 "$(incoming_count)"
LEFT="$(ls -1a "$SPOOL/.staging" 2>/dev/null | grep -vE '^\.$|^\.\.$' || true)"
if [ -z "$LEFT" ]; then ok "暂存目录被打扫干净"; else bad "暂存目录有残留：$LEFT"; fi
rm -f "$FIFO"

say ""
say "C4. 落盘文件权限：App（同用户）可读"
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "权限测试" 1 ""
GOT="$(incoming_list | head -1)"
PERM="$(stat -f '%Sp' "$INCOMING/$GOT" 2>/dev/null)"
assert_eq "落盘文件权限" "-rw-r--r--" "$PERM"

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " D. CUPS 交给 backend 的原始现场 + PPD 滤镜链"
say "=============================================================="

say ""
say "D1. capture backend：argv 与 stdin"
CAPTURE_BIN="$WORK/capture-backend"
cat >"$CAPTURE_BIN" <<'CAP'
#!/bin/sh
D="${CAPTURE_DIR:-/tmp/capture-backend}"
mkdir -p "$D"
{
    printf 'argc=%s\n' "$#"
    i=0
    for a in "$@"; do printf 'argv[%d]=%s\n' "$i" "$a"; i=$((i+1)); done
    printf 'DEVICE_URI=%s\n' "${DEVICE_URI:-}"
    printf 'PRINTER=%s\n' "${PRINTER:-}"
    printf 'CUPS_SERVERBOT=%s\n' "${CUPS_SERVERBOT:-}"
    printf 'CHARSET=%s\n' "${CHARSET:-}"
    printf 'LANG=%s\n' "${LANG:-}"
    printf 'HOME=%s\n' "${HOME:-}"
    printf 'UID=%s\n' "$(id -u)"
} >"$D/meta.txt"
cat >"$D/stdin.bin"
printf 'bytes=%s\n' "$(wc -c <"$D/stdin.bin" | tr -d ' ')" >>"$D/meta.txt"
printf 'magic=%s\n' "$(head -c 5 "$D/stdin.bin")" >>"$D/meta.txt"
exit 0
CAP
chmod +x "$CAPTURE_BIN"

rm -rf "$WORK/capture"
env -i PATH=/usr/bin:/bin HOME="$CUPS_HOME" LANG=zh_CN.UTF-8 CHARSET=utf-8 \
    CAPTURE_DIR="$WORK/capture" \
    DEVICE_URI="sustech-print:/sustech" PRINTER="南科大云打印" \
    CUPS_SERVERBOT="/usr/libexec/cups/daemon/cups-deviced" \
    "$CAPTURE_BIN" 42 chen "中文标题 测试" 2 "copies=2 sides=two-sided-long-edge" \
    <"$FIXTURES/sample-zh.pdf"
say "  CUPS → backend 的现场："
sed 's/^/    /' "$WORK/capture/meta.txt"
assert_eq "argv 个数为 5（CUPS 1.2+ 不传 filename）" 5 "$(sed -n 's/^argc=//p' "$WORK/capture/meta.txt")"
if cmp -s "$FIXTURES/sample-zh.pdf" "$WORK/capture/stdin.bin"; then
    ok "backend 从 stdin 收到的字节与原 PDF 完全相同"
else
    bad "stdin 字节与输入不一致"
fi
assert_contains "capture 到的 HOME 就是 CUPS 的" "$WORK/capture/meta.txt" "HOME=$CUPS_HOME"

say ""
say "D2. cupstestppd 校验 PPD"
if command -v cupstestppd >/dev/null 2>&1; then
    if cupstestppd -q "$PPD" >/dev/null 2>&1; then ok "PPD 通过校验"; else bad "PPD 校验失败"; fi
else
    skip "没有 cupstestppd"
fi

say ""
say "D3. PDF 输入的滤镜链（必须直通，不能有 cgpdftops）"
CHAIN="$(cupsfilter -p "$PPD" -i application/pdf -m application/vnd.cups-pdf --list-filters "$FIXTURES/sample-zh.pdf" 2>&1)"
printf '    %s\n' "$CHAIN"
case "$CHAIN" in
    *cgpdftops*) bad "PDF 被送进 cgpdftops（会变 PostScript，需要 Ghostscript）" ;;
    *) ok "PDF 没有走 cgpdftops" ;;
esac

say ""
say "D4. PDF 直通后字节是否原样"
cupsfilter -p "$PPD" -i application/pdf -m application/vnd.cups-pdf "$FIXTURES/sample-zh.pdf" >"$WORK/out/pass.pdf" 2>/dev/null
if cmp -s "$FIXTURES/sample-zh.pdf" "$WORK/out/pass.pdf"; then
    ok "直通输出与输入逐字节相同（不需要 Ghostscript）"
else
    bad "直通输出被改写"
fi

say ""
say "D5. text/plain 会被 cgtexttopdf 转成 PDF（所以 lp 打 txt 也能用）"
cupsfilter -p "$PPD" -i text/plain -m application/vnd.cups-pdf "$FIXTURES/source.txt" >"$WORK/out/txt.pdf" 2>/dev/null
if [ "$(head -c 5 "$WORK/out/txt.pdf")" = "%PDF-" ]; then
    ok "text/plain → PDF 成功"
else
    bad "text/plain 未产出 PDF"
fi

say ""
say "D6. PostScript 在提交阶段被拒（本机无 PS→PDF 转换器）"
cupsfilter -p "$PPD" -i application/postscript -m application/vnd.cups-pdf \
    "$FIXTURES/sample.ps" >"$WORK/out/ps-reject.bin" 2>"$WORK/out/ps-reject.err"
PS_RC=$?
say "    cupsfilter 退出码=${PS_RC}，输出字节=$(wc -c <"$WORK/out/ps-reject.bin" | tr -d ' ')"
if [ "$PS_RC" -ne 0 ] && [ ! -s "$WORK/out/ps-reject.bin" ]; then
    ok "PS 被明确拒绝（非 0 退出且无输出）"
else
    bad "PS 没有被拒绝"
fi

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " E. 安装 / 卸载脚本（沙箱 prefix，不需要 root）"
say "=============================================================="

SANDBOX="$WORK/sandbox"
SPOOLROOT="$SANDBOX/var-spool"
S_INCOMING="$SPOOLROOT/incoming"

say ""
say "E1. install.sh --dry-run 能看到 mkdir/chown/chmod（现在用 install -d）"
if sh "$DRIVER_DIR/install.sh" --dry-run >"$WORK/out/install-dry.txt" 2>&1; then
    ok "dry-run 执行成功"
    grep -E 'install -d|install -o|ln -sf|lpadmin -p' "$WORK/out/install-dry.txt" | sed 's/^/      /'
else
    bad "dry-run 失败"
fi
assert_contains "dry-run 里有 spool 目录创建" "$WORK/out/install-dry.txt" "install -d -m 0750"
assert_contains "dry-run 里有队列创建" "$WORK/out/install-dry.txt" "lpadmin -p"
assert_contains "dry-run 里的 DEVICE_URI 正确" "$WORK/out/install-dry.txt" "sustech-print:/sustech"
# 回归（真机上踩过两次）：scheme 必须纯 ASCII。
#   中文 scheme 会让 lpadmin 报「错误的device-uri」，而且它会**先把队列删掉再报错**。
if grep -qE '南科大云打印:/' "$WORK/out/install-dry.txt"; then
    bad "出现了中文 scheme 的 DEVICE_URI（lpadmin 会拒绝，还会删掉已有队列）"
else
    ok "DEVICE_URI 的 scheme 是纯 ASCII"
fi
# 回归：不该再创建那个做不了 scheme 的中文别名
if grep -q '创建 backend 别名' "$WORK/out/install-dry.txt"; then
    bad "又在创建无用的中文 backend 别名"
else
    ok "没有创建无用的中文 backend 别名"
fi

say ""
say "E2. 沙箱真装：spool 目录、权限、backend、别名、PPD"
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/backend" "$SANDBOX/ppd"
env SUSTECH_BACKEND_DIR="$SANDBOX/backend" \
    SUSTECH_PPD_DIR="$SANDBOX/ppd" \
    SUSTECH_SPOOL_ROOT="$SPOOLROOT" \
    SUSTECH_ALLOW_NONROOT=1 \
    SUSTECH_SKIP_QUEUE=1 \
    SUSTECH_INSTALL_OWNER="$(id -un)" \
    SUSTECH_INSTALL_GROUP="$(id -gn)" \
    SUSTECH_SPOOL_OWNER="$(id -un)" \
    SUSTECH_SPOOL_GROUP="$(id -gn)" \
    sh "$DRIVER_DIR/install.sh" >"$WORK/out/install-sandbox.txt" 2>&1
assert_eq "沙箱安装退出码" 0 "$?"

if [ -d "$S_INCOMING" ]; then
    ok "spool incoming 目录已创建"
    assert_eq "incoming 权限是 0750" "drwxr-x---" "$(stat -f '%Sp' "$S_INCOMING")"
else
    bad "spool incoming 目录没有创建"
fi
if [ -d "$SPOOLROOT" ]; then
    assert_eq "spool 根目录权限是 0750" "drwxr-x---" "$(stat -f '%Sp' "$SPOOLROOT")"
    assert_eq "spool 根目录属主" "$(id -un)" "$(stat -f '%Su' "$SPOOLROOT")"
fi

if [ -f "$SANDBOX/backend/sustech-print" ]; then
    assert_eq "backend 权限是 0700" "-rwx------" "$(stat -f '%Sp' "$SANDBOX/backend/sustech-print")"
    if cmp -s "$DRIVER_DIR/sustech-print" "$SANDBOX/backend/sustech-print"; then
        ok "安装后的 backend 与源文件一致"
    else
        bad "安装后的 backend 与源文件不一致"
    fi
else
    bad "backend 没有装到沙箱"
fi
if [ -e "$SANDBOX/backend/南科大云打印" ] || [ -L "$SANDBOX/backend/南科大云打印" ]; then
    bad "不该再创建中文 backend 别名（中文不能作为 URI scheme）"
else
    ok "没有创建无用的中文 backend 别名"
fi
if [ -f "$SANDBOX/ppd/sustech-print.ppd" ]; then
    assert_eq "PPD 权限是 0644" "-rw-r--r--" "$(stat -f '%Sp' "$SANDBOX/ppd/sustech-print.ppd")"
else
    bad "PPD 没有装到沙箱"
fi

say ""
say "E3. 用沙箱装好的 spool 目录跑一次 backend（端到端，模拟真实安装后）"
RUN_BACKEND="$SANDBOX/backend/sustech-print"
env -i PATH="/usr/bin:/bin" HOME="$CUPS_HOME" \
    SUSTECH_SPOOL_DIR="$S_INCOMING" \
    "$RUN_BACKEND" 77 chen "沙箱端到端 中文标题" 1 "copies=1" \
    <"$FIXTURES/sample-zh.pdf" >"$WORK/out/sandbox-be.out" 2>"$WORK/out/sandbox-be.err"
assert_eq "沙箱 backend 落盘退出码" 0 "$?"
SN="$(ls -1 "$S_INCOMING" | head -1)"
if [ -n "$SN" ] && cmp -s "$FIXTURES/sample-zh.pdf" "$S_INCOMING/$SN"; then
    ok "沙箱端到端落盘内容正确（=${SN}）"
else
    bad "沙箱端到端落盘内容不对"
fi
assert_contains "spool 根目录里写下了日志" "$SPOOLROOT/driver.log" "已落盘"
assert_eq "沙箱 backend stdout 为空" 0 "$(wc -c <"$WORK/out/sandbox-be.out" | tr -d ' ')"

say ""
say "E4. 幂等：再装一次仍成功"
env SUSTECH_BACKEND_DIR="$SANDBOX/backend" SUSTECH_PPD_DIR="$SANDBOX/ppd" \
    SUSTECH_SPOOL_ROOT="$SPOOLROOT" SUSTECH_ALLOW_NONROOT=1 SUSTECH_SKIP_QUEUE=1 \
    SUSTECH_INSTALL_OWNER="$(id -un)" SUSTECH_INSTALL_GROUP="$(id -gn)" \
    SUSTECH_SPOOL_OWNER="$(id -un)" SUSTECH_SPOOL_GROUP="$(id -gn)" \
    sh "$DRIVER_DIR/install.sh" >"$WORK/out/install2.txt" 2>&1
assert_eq "第二次安装退出码" 0 "$?"
# 幂等不能只看"有没有打印某句提示语"——那是极其脆弱的断言
# （之前就因为提示语改名而误报失败）。这里直接验证可观察的结果：
# 文件内容没被改坏、权限没被改掉、步骤确实按预期执行了。
assert_contains "第二次安装确实走到了队列步骤" "$WORK/out/install2.txt" "跳过队列创建"
if cmp -s "$DRIVER_DIR/sustech-print" "$SANDBOX/backend/sustech-print"; then
    ok "第二次安装后 backend 仍与源文件逐字节一致"
else
    bad "第二次安装把 backend 改坏了"
fi
assert_eq "第二次安装后 backend 权限仍是 0700" "-rwx------" \
    "$(stat -f '%Sp' "$SANDBOX/backend/sustech-print")"
assert_eq "第二次安装后 spool incoming 权限仍是 0750" "drwxr-x---" \
    "$(stat -f '%Sp' "$SPOOLROOT/incoming")"
assert_eq "第二次安装后 PPD 权限仍是 0644" "-rw-r--r--" \
    "$(stat -f '%Sp' "$SANDBOX/ppd/sustech-print.ppd")"

say ""
say "E5. 安全护栏：非 root + 系统路径必须被拒绝"
if env SUSTECH_ALLOW_NONROOT=1 sh "$DRIVER_DIR/install.sh" >"$WORK/out/guard.txt" 2>&1; then
    bad "非 root 且系统路径时竟然没被拒绝"
else
    assert_contains "被明确拒绝" "$WORK/out/guard.txt" "只允许配合"
fi

say ""
say "E6. uninstall.sh 默认保留 spool；--purge-spool 才删"
#
# ⚠️ 沙箱卸载**必须**带 SUSTECH_SKIP_QUEUE=1，并且额外指定一个用不上的队列名。
# 真事故：这里曾经只覆盖了 BACKEND_DIR / PPD_DIR / SPOOL_ROOT，没覆盖 QUEUE。
# 当时 QUEUE 默认值是本机不存在的 `南科大云打印`，`lpstat -p` 判定"不存在"就走了
# 跳过分支，测试一路绿灯 —— 直到默认值被改成真正装在机器上的 `SUSTech_Printer`，
# 这一行立刻把**用户的真实打印队列删掉了**。
# 双保险：① 明确 skip；② 即便 skip 失效，目标也只是一个沙箱专用名字。
SANDBOX_QUEUE="ZZSustechSandboxQueue"
# 记录真实队列在本节前后的存在性，见 E9 —— 测试套件声称"不改动系统"就必须自己保证。
REAL_QUEUE="$(sed -n 's/^QUEUE="\${SUSTECH_QUEUE:-\([^}]*\)}".*/\1/p' "$DRIVER_DIR/install.sh" | head -1)"
if lpstat -p "$REAL_QUEUE" >/dev/null 2>&1; then REAL_BEFORE=yes; else REAL_BEFORE=no; fi

# 先造一个"未提交的作业"
env -i PATH="/usr/bin:/bin" HOME="$CUPS_HOME" SUSTECH_SPOOL_DIR="$S_INCOMING" \
    "$RUN_BACKEND" 78 chen "卸载前遗留作业" 1 "" <"$FIXTURES/sample-zh.pdf" >/dev/null 2>&1
BEFORE="$(ls -1 "$S_INCOMING" | wc -l | tr -d ' ')"
env SUSTECH_BACKEND_DIR="$SANDBOX/backend" SUSTECH_PPD_DIR="$SANDBOX/ppd" \
    SUSTECH_SPOOL_ROOT="$SPOOLROOT" SUSTECH_ALLOW_NONROOT=1 \
    SUSTECH_SKIP_QUEUE=1 SUSTECH_QUEUE="$SANDBOX_QUEUE" \
    sh "$DRIVER_DIR/uninstall.sh" >"$WORK/out/uninstall.txt" 2>&1
assert_eq "沙箱卸载退出码" 0 "$?"
assert_contains "沙箱卸载明确跳过了队列删除" "$WORK/out/uninstall.txt" "跳过队列删除"
if [ -d "$S_INCOMING" ] && [ "$(ls -1 "$S_INCOMING" | wc -l | tr -d ' ')" = "$BEFORE" ]; then
    ok "默认卸载保留了 spool 里的 $BEFORE 个文件"
else
    bad "默认卸载把 spool 文件删了"
fi
assert_contains "卸载输出告诉用户 spool 在哪" "$WORK/out/uninstall.txt" "$SPOOLROOT"
assert_contains "卸载输出提醒还有未提交作业" "$WORK/out/uninstall.txt" "没被 App 取走"
if [ ! -e "$SANDBOX/backend/sustech-print" ] && [ ! -L "$SANDBOX/backend/南科大云打印" ] \
   && [ ! -e "$SANDBOX/ppd/sustech-print.ppd" ]; then
    ok "backend / 别名 / PPD 都已删除"
else
    bad "卸载后有残留"
fi

say ""
say "E7. uninstall.sh --purge-spool 才真正删掉 spool"
env SUSTECH_BACKEND_DIR="$SANDBOX/backend" SUSTECH_PPD_DIR="$SANDBOX/ppd" \
    SUSTECH_SPOOL_ROOT="$SPOOLROOT" SUSTECH_ALLOW_NONROOT=1 \
    SUSTECH_SKIP_QUEUE=1 SUSTECH_QUEUE="$SANDBOX_QUEUE" \
    sh "$DRIVER_DIR/uninstall.sh" --purge-spool >"$WORK/out/purge.txt" 2>&1
assert_eq "purge 卸载退出码" 0 "$?"
assert_not_exists "spool 目录已被删除" "$SPOOLROOT"

say ""
say "E8. dry-run 覆盖卸载"
if sh "$DRIVER_DIR/uninstall.sh" --dry-run >"$WORK/out/uninstall-dry.txt" 2>&1; then
    ok "uninstall --dry-run 执行成功"
else
    bad "uninstall --dry-run 失败"
fi
if sh "$DRIVER_DIR/uninstall.sh" --purge-spool --dry-run >"$WORK/out/purge-dry.txt" 2>&1; then
    ok "uninstall --purge-spool --dry-run 执行成功"
    assert_contains "dry-run 里能看到 rm -rf spool" "$WORK/out/purge-dry.txt" "rm -rf"
else
    bad "uninstall --purge-spool --dry-run 失败"
fi

say ""
say "E9. 整节沙箱操作没有碰过真实系统队列"
# 这是本节最重要的断言：测试套件开头写着"不需要 root、不需要 sudo、不改动系统"。
# 上面那次真事故就是这句话变成了谎话 —— 沙箱卸载把真实队列删了，而测试全绿。
# 这里直接对"真实队列的存在性"做前后比对，任何越界都会立刻暴露。
if lpstat -p "$REAL_QUEUE" >/dev/null 2>&1; then REAL_AFTER=yes; else REAL_AFTER=no; fi
assert_eq "真实队列「${REAL_QUEUE}」存在性与测试前一致" "$REAL_BEFORE" "$REAL_AFTER"
if lpstat -p "$SANDBOX_QUEUE" >/dev/null 2>&1; then
    bad "沙箱队列名 ${SANDBOX_QUEUE} 竟然被创建/残留了"
else
    ok "沙箱队列名 ${SANDBOX_QUEUE} 未被创建（用的是纯沙箱名字）"
fi

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " G. 跨文件一致性 / 平台硬约束"
say "=============================================================="
#
# 这一节防的是"界面说 A、系统里叫 B"的漂移 —— 本项目已经踩过两次：
#   1. macOS 队列名一度是中文，而 URI scheme 必须纯 ASCII，两者被混在一起
#   2. web 界面里硬编码的打印机名和安装脚本注册的队列名不一致
# 队列名现在只允许在一个地方"改错"：四个文件里的字面量必须逐字相同。

REPO_ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
INSTALL_SH="$DRIVER_DIR/install.sh"
PATHS_MJS="$REPO_ROOT/lib/paths.mjs"
WEB_CONST="$REPO_ROOT/web/src/const.ts"
WIN_PS1="$REPO_ROOT/driver/windows/install-printer.ps1"

N_PATHS="$(sed -n 's/.*PRINTER_NAME = process\.env\.SUSTECH_PRINTER_NAME || "\([^"]*\)".*/\1/p' "$PATHS_MJS" | head -1)"
N_WEB="$(sed -n 's/.*export const PRINTER_NAME = "\([^"]*\)".*/\1/p' "$WEB_CONST" | head -1)"
N_SH="$(sed -n 's/^QUEUE="\${SUSTECH_QUEUE:-\([^}]*\)}".*/\1/p' "$DRIVER_DIR/install.sh" | head -1)"
N_PS1="$(sed -n "s/.*\[string\] \\\$PrinterName = '\([^']*\)'.*/\1/p" "$WIN_PS1" | head -1)"
# 卸载脚本也有同一个默认值。漏掉它的代价很实在：不带参数执行会去删一个不存在的队列，
# 真正的队列留在系统里（这个 bug 在 Windows 和 macOS 两边都真的出现过，
# 都是靠人工核对才发现 —— 所以现在两边都纳入断言）。
N_SH_UN="$(sed -n 's/^QUEUE="\${SUSTECH_QUEUE:-\([^}]*\)}".*/\1/p' "$DRIVER_DIR/uninstall.sh" | head -1)"
WIN_PS1_UN="$REPO_ROOT/driver/windows/uninstall-printer.ps1"
N_PS1_UN="$(sed -n "s/.*\[string\] \\\$PrinterName = '\([^']*\)'.*/\1/p" "$WIN_PS1_UN" | head -1)"

say ""
say "G1. 六个文件里的队列名字面量必须完全一致"
# 先确认"抠出来了"。否则 sed 模式一旦过期，几个空串会互相相等、假绿通过。
if [ -n "$N_PATHS" ] && [ -n "$N_WEB" ] && [ -n "$N_SH" ] && [ -n "$N_SH_UN" ] && [ -n "$N_PS1" ] && [ -n "$N_PS1_UN" ]; then
    ok "六处都抠到了队列名：[$N_PATHS]"
else
    bad "有文件没抠出队列名（sed 模式过期？）paths=[$N_PATHS] web=[$N_WEB] sh=[$N_SH] sh_un=[$N_SH_UN] ps1=[$N_PS1] ps1_un=[$N_PS1_UN]"
fi
assert_eq "install.sh 与 lib/paths.mjs 一致" "$N_PATHS" "$N_SH"
assert_eq "uninstall.sh 与 lib/paths.mjs 一致" "$N_PATHS" "$N_SH_UN"
assert_eq "web/src/const.ts 与 lib/paths.mjs 一致" "$N_PATHS" "$N_WEB"
assert_eq "install-printer.ps1 与 lib/paths.mjs 一致" "$N_PATHS" "$N_PS1"
assert_eq "uninstall-printer.ps1 与 lib/paths.mjs 一致" "$N_PATHS" "$N_PS1_UN"

say ""
say "G2. 队列名不含空白字符"
# lpadmin 拒绝 C 语言意义上的空白（空格 / TAB / LF / VT / FF / CR），
# 但报错信息写成"打印机名称只能包含可打印字符"，极具误导性。
# 实测：空格 ✗、TAB ✗、LF ✗、中文 ✓、下划线 ✓、全角空格 ✓（但命令行没法输入，不要用）。
if printf '%s' "$N_PATHS" | LC_ALL=C grep -q '[[:space:]]'; then
    bad "队列名 [$N_PATHS] 含空白字符，macOS 上 lpadmin 一定会拒绝"
else
    ok "队列名 [$N_PATHS] 不含空白字符，macOS 可接受"
fi

say ""
say "G3. install.sh 的预检真的拦得住带空格的队列名（行为验证，不只是看代码）"
PRECHECK_OUT="$(SUSTECH_QUEUE='SUSTech Printer' sh "$DRIVER_DIR/install.sh" --dry-run 2>&1)" && PRECHECK_RC=0 || PRECHECK_RC=$?
if [ "$PRECHECK_RC" -eq 0 ]; then
    bad "带空格的队列名竟然通过了安装预检（lpadmin 随后会拒绝）"
else
    case "$PRECHECK_OUT" in
        *"含空白字符"*) ok "带空格的队列名被预检拦下，且报错说明了真实原因" ;;
        *) bad "预检拦下了，但报错信息不对：$PRECHECK_OUT" ;;
    esac
fi
# 反例：中文名必须放行（历史上中文名是被允许的，别把预检写宽了）
if SUSTECH_QUEUE='南科大云打印' sh "$DRIVER_DIR/install.sh" --dry-run >/dev/null 2>&1; then
    ok "中文队列名仍被放行（预检没有过宽）"
else
    bad "中文队列名被预检误拦了"
fi

say ""
say "G4. driver/windows/*.ps1 必须带 UTF-8 BOM"
# PowerShell 5.1 读无 BOM 的 .ps1 会按系统 ANSI 代码页解码，中文全变乱码。
# 这是硬要求，见 driver/windows/REPORT.md。工具重写文件时很容易把 BOM 吃掉 ——
# 实测：改写 .ps1 的编辑器/agent edit 工具会**静默**把 BOM 删掉，本项目已踩到两次。
# 所以改完任何 .ps1 都必须跑这条断言。
for f in "$REPO_ROOT"/driver/windows/*.ps1; do
    [ -e "$f" ] || continue
    bom="$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')"
    if [ "$bom" = "efbbbf" ]; then
        ok "BOM 完好：$(basename "$f")"
    else
        bad "$(basename "$f") 缺少 UTF-8 BOM（实际首 3 字节：$bom）—— PowerShell 5.1 会把中文解码成乱码"
    fi
done

say ""
say "G5. backend 不会把 .pdf 拼两遍"
# `lp -d 队列 文件.pdf` 时 CUPS 把作业名设成 "文件.pdf"，而 DEST 还会补一个 .pdf。
# 不剥掉已有后缀，用户就会在云打印队列里看到 "xxx.pdf.pdf"（实测踩到）。
clear_incoming
run_backend "$FIXTURES/sample-zh.pdf" "sample-zh.pdf" 1 "copies=1"
assert_eq "标题以 .pdf 结尾时退出码" 0 "$RC"
GOT5="$(incoming_list | head -1)"
case "$GOT5" in
    *.pdf.pdf) bad "拼出了双扩展名：$GOT5" ;;
    *-sample-zh.pdf) ok "已有 .pdf 后缀被剥掉，只剩一个扩展名：$GOT5" ;;
    *) bad "文件名不符合预期：$GOT5" ;;
esac

say ""
say "G6. driver.log 在 CUPS 的 umask=0077 下仍然对用户可读"
# CUPS 给 backend 的 umask 是 0077：root 首次创建 driver.log 会得到 0600，
# 而 install.sh 恰恰让用户"出问题看 driver.log" —— 用户会吃到 Permission denied。
# 这里刻意用 umask 077 复现线上条件，再断言 backend 自己把它修成 0644。
rm -f "$DRIVER_LOG"
( umask 077; run_backend "$FIXTURES/sample-zh.pdf" "日志权限测试" 1 "copies=1" )
if [ -f "$DRIVER_LOG" ]; then
    # 用八进制比较：`ls -l` 在 macOS 上会带一个 `@`（有扩展属性）后缀，
    # 直接比 "-rw-r--r--" 会误报失败。
    assert_eq "umask=0077 下 driver.log 权限（八进制）" "644" "$(stat -f '%Lp' "$DRIVER_LOG")"
else
    bad "umask=0077 下 driver.log 没被创建：$DRIVER_LOG"
fi

say ""
say "G7. 上传路由常量：新路由只定义一处、且没有残留已下线的旧路由"
# 上游改过名：CloudPrint/UploadFile -> CloudPrint/Upload（2026-09 实测：
# 前者 404 "No HTTP resource was found"，后者 405）。两处调用共用一个常量，
# 免得再出现"只改了一处"的半死状态。复核工具：
#   node tools/probe-upstream-capabilities.mjs   （GET 一下：405=存在，404=没了）
SERVER_MJS="$REPO_ROOT/server.mjs"
assert_contains "server.mjs 定义了新上传路径" "$SERVER_MJS" 'UPLOAD_PATH = "/api/client/CloudPrint/Upload"'
if grep -q 'CloudPrint/UploadFile' "$SERVER_MJS" 2>/dev/null; then
    # 注释里**故意**留着旧路由名（记录"上游改过名"这段历史），所以要先剥掉注释
    # 再看：`//...` 行内注释去掉，以 `*` 开头的 docstring 行整行丢掉。
    leftover="$(sed -e 's://.*::' "$SERVER_MJS" | grep -v '^[[:space:]]*\*' | grep -n 'CloudPrint/UploadFile' || true)"
    if [ -n "$leftover" ]; then
        bad "server.mjs 代码里还残留已下线的 CloudPrint/UploadFile：$leftover"
    else
        ok "server.mjs 代码里没有残留的 UploadFile（只有注释提到旧名字）"
    fi
else
    ok "server.mjs 里没有 UploadFile"
fi
assert_eq "两处调用都走同一个常量" "2" "$(grep -c 'ORIGIN}${UPLOAD_PATH}' "$SERVER_MJS" | tr -d ' ')"
# 404=路由不存在时不能再说成"临时故障"：改名后重试永远不会成功
assert_contains "能识别 ASP.NET 的路由不存在" "$SERVER_MJS" "isRouteMissing"

say ""
say "G8. 队列描述里不能带括号注释"
# macOS 会把 CUPS 的 printer-info（= lpadmin -D 的值）当作打印机名显示出来。
# 以前写成「南科大云打印（虚拟打印机，提交到云端打印系统）」，那个括号注释会跟着
# 名字一起显示，所以去掉了括号部分。这里守住：QUEUE_INFO 里不许再出现全角括号。
assert_contains "install.sh 定义了 QUEUE_INFO" "$INSTALL_SH" 'QUEUE_INFO="${SUSTECH_QUEUE_INFO:-'
if grep -q 'QUEUE_INFO=.*（' "$INSTALL_SH" 2>/dev/null; then
    bad "QUEUE_INFO 的默认值里又出现了括号注释（macOS 会把 -D 当打印机名显示）"
else
    ok "QUEUE_INFO 默认值不含括号注释"
fi
# 创建分支和更新分支必须都带上 -D：以前只有创建分支给，于是改了描述重新安装也不生效
assert_eq "两个分支都引用 QUEUE_INFO（创建 + 更新）" "2" "$(grep -c '\-D "\$QUEUE_INFO"' "$INSTALL_SH" | tr -d ' ')"
# 行为验证：dry-run 打印出来的 lpadmin 命令行里不应有括号
if bash "$INSTALL_SH" --dry-run 2>/dev/null | grep -- 'lpadmin -p' | grep -q '（'; then
    bad "dry-run 的 lpadmin 命令行里仍带括号描述"
else
    ok "dry-run 的 lpadmin 命令行里没有括号描述"
fi

# ---------------------------------------------------------------------------
say ""
say "=============================================================="
say " F. 结论"
say "=============================================================="
printf '  通过 %s / 失败 %s / 跳过 %s\n' "$PASS" "$FAIL" "$SKIP"
say "  原始日志：$WORK/logs"
say "  驱动日志：$DRIVER_LOG"
say "  spool 目录：$INCOMING"

[ "$FAIL" -eq 0 ] || exit 1
exit 0
