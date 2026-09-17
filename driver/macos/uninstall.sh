#!/bin/sh
#
# uninstall.sh —— 卸载南科大云打印 macOS CUPS 驱动
# ---------------------------------------------------------------------------
# 用法：
#   sudo ./uninstall.sh                 # 真正卸载（保留 spool 里的文件）
#   sudo ./uninstall.sh --purge-spool   # 连 spool 目录一起删
#   ./uninstall.sh [--purge-spool] --dry-run   # 只打印命令（不需要 root）
#
# 幂等：重复执行不会报错。
#
# **默认保留 spool 目录里的文件** —— 那里可能还躺着没被 App 提交的作业，
# 卸载驱动不应该顺手把它们删掉。加 --purge-spool 才删。

set -eu

# 与 install.sh 保持一致的路径覆盖（测试 / 便携部署用）
BACKEND_DIR="${SUSTECH_BACKEND_DIR:-/usr/libexec/cups/backend}"
BACKEND_DST="$BACKEND_DIR/sustech-print"
BACKEND_ALIAS="${SUSTECH_BACKEND_ALIAS:-南科大云打印}"
PPD_DIR="${SUSTECH_PPD_DIR:-/Library/Printers/PPDs/Contents/Resources}"
PPD_DST="$PPD_DIR/sustech-print.ppd"
# 必须与 install.sh 的 QUEUE 默认值一致 —— 否则不带参数卸载会去删一个不存在的队列，
# 真正装好的 SUSTech_Printer 反而留在系统里（Windows 的卸载脚本踩过同一个坑）。
QUEUE="${SUSTECH_QUEUE:-SUSTech_Printer}"
SPOOL_ROOT="${SUSTECH_SPOOL_ROOT:-/var/spool/sustech-print}"
SPOOL_INCOMING="$SPOOL_ROOT/incoming"

DRY_RUN=0
PURGE_SPOOL=0
for _arg in "$@"; do
    case "$_arg" in
        --dry-run) DRY_RUN=1 ;;
        --purge-spool) PURGE_SPOOL=1 ;;
        *)
            printf '未知参数：%s\n用法：%s [--purge-spool] [--dry-run]\n' "$_arg" "$0" >&2
            exit 2
            ;;
    esac
done

msg() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '    [dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

NONROOT="${SUSTECH_ALLOW_NONROOT:-0}"
if [ "$NONROOT" = "1" ]; then
    case "$BACKEND_DIR$PPD_DIR$SPOOL_ROOT" in
        /usr/*|/Library/*|/var/*)
            die "SUSTECH_ALLOW_NONROOT=1 只允许配合 SUSTECH_BACKEND_DIR / SUSTECH_PPD_DIR / SUSTECH_SPOOL_ROOT 指向自定义目录" ;;
    esac
fi

if [ "$DRY_RUN" -eq 1 ]; then
    msg "（dry-run：不删任何东西，也不需要 root）"
elif [ "$NONROOT" = "1" ]; then
    msg "（SUSTECH_ALLOW_NONROOT=1：从自定义 prefix 卸载，不做 root 检查）"
else
    [ "$(id -u)" -eq 0 ] || die "请用 sudo 运行：sudo $0"
fi

# ---------------------------------------------------------------------------
# 1. 删除队列（先撤掉作业，避免残留作业一直重试）
# ---------------------------------------------------------------------------
#
# 沙箱测试必须能跳过这一步 —— 与 install.sh 的 SUSTECH_SKIP_QUEUE 对称。
#
# 为什么这条是**必须**的（真事故）：测试套件里只覆盖了 BACKEND_DIR / PPD_DIR /
# SPOOL_ROOT 三个前缀，没覆盖 QUEUE。早先 QUEUE 的默认值是一个中文名，
# 本机并不存在那个队列，于是 `lpstat -p` 判定不存在、走了"跳过"分支，
# 测试看起来一切正常 —— 直到有人把默认值改成真正装在机器上的
# `SUSTech_Printer`，沙箱测试立刻把**真实的打印队列删掉了**。
# 教训：测试套件自称"不改动系统"，就必须自己保证这一点，而不是靠巧合。
if [ "${SUSTECH_SKIP_QUEUE:-0}" = "1" ] && [ "$DRY_RUN" -eq 0 ]; then
    msg "==> SUSTECH_SKIP_QUEUE=1：跳过队列删除（沙箱/便携卸载）"
elif [ "$DRY_RUN" -eq 1 ]; then
    msg "==> 删除队列「${QUEUE}」（若存在）"
    run cancel -a "$QUEUE"
    run lpadmin -x "$QUEUE"
elif lpstat -p "$QUEUE" >/dev/null 2>&1; then
    msg "==> 删除队列「${QUEUE}」"
    cancel -a "$QUEUE" >/dev/null 2>&1 || true
    lpadmin -x "$QUEUE" || die "lpadmin 删除队列失败"
else
    msg "==> 队列「${QUEUE}」不存在，跳过"
fi

# ---------------------------------------------------------------------------
# 2. 删除 backend 与别名
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ] || [ -L "$BACKEND_DIR/$BACKEND_ALIAS" ] || [ -e "$BACKEND_DIR/$BACKEND_ALIAS" ]; then
    msg "==> 删除 backend 别名 $BACKEND_DIR/$BACKEND_ALIAS"
    run rm -f "$BACKEND_DIR/$BACKEND_ALIAS"
else
    msg "==> backend 别名不存在，跳过"
fi

if [ "$DRY_RUN" -eq 1 ] || [ -e "$BACKEND_DST" ]; then
    msg "==> 删除 backend $BACKEND_DST"
    run rm -f "$BACKEND_DST"
else
    msg "==> backend 不存在，跳过"
fi

# ---------------------------------------------------------------------------
# 3. 删除 PPD
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ] || [ -e "$PPD_DST" ]; then
    msg "==> 删除 PPD $PPD_DST"
    run rm -f "$PPD_DST"
else
    msg "==> PPD 不存在，跳过"
fi

# ---------------------------------------------------------------------------
# 4. spool 目录：默认保留，--purge-spool 才删
# ---------------------------------------------------------------------------

PENDING=""
if [ -d "$SPOOL_INCOMING" ]; then
    PENDING="$(find "$SPOOL_INCOMING" -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')"
fi

if [ "$PURGE_SPOOL" -eq 1 ]; then
    msg "==> 删除 spool 目录 ${SPOOL_ROOT}（--purge-spool）"
    run rm -rf "$SPOOL_ROOT"
else
    msg "==> 保留 spool 目录 ${SPOOL_ROOT}（可能还有未提交的作业）"
    if [ -n "$PENDING" ] && [ "$PENDING" != "0" ]; then
        msg "    ⚠ 里面还有 $PENDING 个文件没被 App 取走，请先启动 App 提交，或手动处理。"
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    msg ""
    msg "==> dry-run 结束：上面就是真正卸载时会执行的命令。"
    exit 0
fi

msg ""
msg "==> 卸载完成。"
if [ "$PURGE_SPOOL" -eq 0 ]; then
    msg "    spool 目录保留在：$SPOOL_ROOT"
    msg "    （里面可能还有未提交的作业；确认不需要后再手动删："
    msg "      sudo rm -rf $SPOOL_ROOT ）"
fi
msg "    客户端配置（令牌 / 登录状态）未受影响。"
