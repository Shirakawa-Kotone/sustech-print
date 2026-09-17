#!/bin/sh
#
# install.sh —— 安装南科大云打印 macOS CUPS 驱动（落盘版）
# ---------------------------------------------------------------------------
# 用法：
#   sudo ./install.sh              # 真正安装
#   ./install.sh --dry-run         # 只打印会执行的命令，不写任何文件（不需要 root）
#
# 做五件事（幂等，可重复执行）：
#   1. 把 backend 装到 /usr/libexec/cups/backend/sustech-print（root:wheel 0700）
#      并清理旧版本留下的中文名符号链接 —— 中文做不了 URI scheme，那链接没用
#   2. 预检队列名和 device-uri 的 scheme。两个都必须在 lpadmin 之前拦下来：
#      - 队列名不能含空白字符（lpadmin 拒绝，但报错信息写的是"只能包含可打印字符"）
#      - scheme 必须是纯 ASCII（lpadmin 对非法 URI 是"先把队列删掉再报错"，
#        用户已经因此丢过队列）
#   3. 把 PPD 装到 /Library/Printers/PPDs/Contents/Resources/
#   4. 建共享 spool 目录（backend 落盘、App 监听取件）：
#        /var/spool/sustech-print/            属主=<调用 sudo 的用户> 0750
#        /var/spool/sustech-print/incoming/   同上（App 监听这个目录）
#      这样 backend（root）能写、App（该用户）能读写和搬走文件，不用动 _lp 组。
#      另外预建 driver.log（0644）—— backend 的 umask 是 0077，由它首次创建会
#      得到 root:0600，用户看不了，可脚本最后正是让用户去看这个日志。
#   5. 建/更新 CUPS 队列「SUSTech_Printer」并启用
#
# 队列名和设备 URI 是两回事，别混：
#   队列名 = SUSTech_Printer   （用户在打印对话框里看到的；中文可以，**空白不行**）
#   scheme = sustech-print     （**必须纯 ASCII**，受 RFC 3986 约束）
#
# 不需要联网、不需要 Homebrew、不需要 Ghostscript。

set -eu

# 以脚本所在目录为基准，避免依赖调用者的 cwd
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

BACKEND_SRC="$SELF_DIR/sustech-print"
PPD_SRC="$SELF_DIR/sustech-print.ppd"

# 目标路径与队列名可用环境变量覆盖：
#   - --dry-run / 单元测试可以在不碰系统目录的前提下验证完整逻辑
#   - 便携部署可以装到别的 prefix
BACKEND_DIR="${SUSTECH_BACKEND_DIR:-/usr/libexec/cups/backend}"
PPD_DIR="${SUSTECH_PPD_DIR:-/Library/Printers/PPDs/Contents/Resources}"
PPD_DST="$PPD_DIR/sustech-print.ppd"

# 队列名和 device-uri 的 scheme 是**两件事**，不要混：
#   - 队列名（用户在打印对话框里看到的）：中文可以，**空白字符不行**
#   - scheme（告诉 CUPS 由哪个 backend 处理）：**必须纯 ASCII**
# 早先把两者都设成中文，lpadmin 直接拒绝：
#     lpadmin：错误的device-uri“南科大云打印:/sustech”。
# 因为 URI scheme 受 RFC 3986 约束（ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )）。
# 更坑的是：lpadmin 遇到非法 URI 会**先把队列删掉再报错**，所以下面还加了预检，
# 不能让用户的队列因为一个拼错的 URI 就没了。
#
# 后来想把队列名改成「SUSTech Printer」（带空格），又被 lpadmin 拒了：
#     lpadmin：打印机名称只能包含可打印字符。
# 这句报错是**误导**，真正的原因是空白字符（见下面 QUEUE 预检处的实测表）。
QUEUE="${SUSTECH_QUEUE:-SUSTech_Printer}"
BACKEND_NAME="${SUSTECH_BACKEND_NAME:-sustech-print}"
BACKEND_DST="$BACKEND_DIR/$BACKEND_NAME"
DEVICE_URI="${SUSTECH_DEVICE_URI:-$BACKEND_NAME:/sustech}"
# 旧版本建过一个中文名的 backend 符号链接。中文做不了 URI scheme，
# 那个链接永远用不上，这里只用于安装时把它清理掉。
LEGACY_BACKEND_ALIAS="${SUSTECH_BACKEND_ALIAS:-南科大云打印}"

# 队列的「描述」(-D) 和「位置」(-L)：macOS 在打印对话框 / 打印机列表里会显示它们。
# 描述以前写成「南科大云打印（虚拟打印机，提交到云端打印系统）」，那个括号注释会跟着
# 名字一起显示出来，显得啰嗦，所以去掉了括号部分。
# 两个分支（创建 / 更新）共用这两个变量，避免只改一处导致老队列不更新。
QUEUE_INFO="${SUSTECH_QUEUE_INFO:-南科大云打印}"
QUEUE_LOCATION="${SUSTECH_QUEUE_LOCATION:-SUSTech Cloud Print}"

# spool：backend 写、App 读。SUSTECH_SPOOL_ROOT 可覆盖（测试/便携部署）。
SPOOL_ROOT="${SUSTECH_SPOOL_ROOT:-/var/spool/sustech-print}"
SPOOL_INCOMING="$SPOOL_ROOT/incoming"

# 安装属主：默认 root:wheel；非 root 环境下（例如测试沙箱）可覆盖，
# 否则 `install -o root` 会被系统拒绝，导致真正要验证的步骤跑不到。
INSTALL_OWNER="${SUSTECH_INSTALL_OWNER:-root}"
INSTALL_GROUP="${SUSTECH_INSTALL_GROUP:-wheel}"

# spool 属主：默认给"调用 sudo 的那个用户"，这样 App 能读写。
# 拿不到 SUDO_USER（例如已经 sudo -i 进去、或测试沙箱）就退回 LOGNAME/USER，
# 再不行就退回 root。
spool_owner() {
    for _cand in "${SUDO_USER:-}" "${LOGNAME:-}" "${USER:-}"; do
        if [ -n "$_cand" ] && [ "$_cand" != "root" ]; then
            if id -u "$_cand" >/dev/null 2>&1; then
                printf '%s' "$_cand"
                return 0
            fi
        fi
    done
    printf 'root'
}
SPOOL_OWNER="${SUSTECH_SPOOL_OWNER:-$(spool_owner)}"
SPOOL_GROUP="${SUSTECH_SPOOL_GROUP:-staff}"

DRY_RUN=0
case "${1:-}" in
    --dry-run) DRY_RUN=1 ;;
    "") : ;;
    *)
        printf '未知参数：%s\n用法：%s [--dry-run]\n' "$1" "$0" >&2
        exit 2
        ;;
esac

msg() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '    [dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

# ---------------------------------------------------------------------------
# 0. 前置检查
# ---------------------------------------------------------------------------

[ -f "$BACKEND_SRC" ] || die "找不到 backend：$BACKEND_SRC"
[ -f "$PPD_SRC" ] || die "找不到 PPD：$PPD_SRC"

# 允许非 root 在"自定义 prefix"下安装（只用于测试沙箱/便携部署）。
# 如果目标是系统路径，则必须 root。
NONROOT="${SUSTECH_ALLOW_NONROOT:-0}"
if [ "$NONROOT" = "1" ]; then
    case "$BACKEND_DIR$PPD_DIR$SPOOL_ROOT" in
        /usr/*|/Library/*|/var/*)
            die "SUSTECH_ALLOW_NONROOT=1 只允许配合 SUSTECH_BACKEND_DIR / SUSTECH_PPD_DIR / SUSTECH_SPOOL_ROOT 指向自定义目录" ;;
    esac
fi

if [ "$DRY_RUN" -eq 1 ]; then
    msg "（dry-run：不写任何文件，也不需要 root）"
elif [ "$NONROOT" = "1" ]; then
    msg "（SUSTECH_ALLOW_NONROOT=1：安装到自定义 prefix，不做 root 检查）"
else
    [ "$(id -u)" -eq 0 ] || die "请用 sudo 运行：sudo $0"
fi

for t in lpadmin lpstat cupsctl; do
    command -v "$t" >/dev/null 2>&1 || die "系统缺少 ${t}，无法继续"
done

msg "==> 检查 PPD 合法性"
if command -v cupstestppd >/dev/null 2>&1; then
    if ! cupstestppd -q "$PPD_SRC" >/dev/null 2>&1; then
        cupstestppd "$PPD_SRC" >&2 || true
        die "PPD 未通过 cupstestppd 校验，已中止"
    fi
    msg "    PPD 校验通过"
fi

# 队列名预检。
# lpadmin **拒绝 C 语言意义上的空白字符**（空格 / TAB / LF / VT / FF / CR），
# 但报错信息写成"打印机名称只能包含可打印字符"，极具误导性：
#     lpadmin：打印机名称只能包含可打印字符。
# 实测（macOS 26）：
#     SUSTech Printer      ✗ ASCII 空格 → 被拒
#     $'SUSTech\tPrinter'  ✗ TAB        → 被拒
#     $'SUSTech\nPrinter'  ✗ LF         → 被拒
#     南科大云打印          ✓ 中文没问题
#     SUSTech_Printer      ✓
#     SUSTech　Printer     ✓ 全角空格居然也行（但别用：命令行里没法正常输入）
# 所以名字里只能用下划线/连字符这类无空白的分隔符。
# 和 scheme 一样必须在碰 lpadmin 之前拦下来，报错要直接告诉用户怎么改。
[ -n "$QUEUE" ] || die "队列名不能为空（SUSTECH_QUEUE）。"
if printf '%s' "$QUEUE" | LC_ALL=C grep -q '[[:space:]]'; then
    die "队列名「${QUEUE}」含空白字符（空格 / TAB 等），lpadmin 一定会拒绝，
     而它给出的报错是「打印机名称只能包含可打印字符。」—— 这句话是误导，
     真正的原因是空白字符。请用下划线或连字符代替空格：
         SUSTECH_QUEUE=SUSTech_Printer sudo bash install.sh
     注意：中文队列名是允许的，只有空白字符不行。"
fi

# ---------------------------------------------------------------------------
# 1. 安装 backend
# ---------------------------------------------------------------------------

msg "==> 安装 backend 到 $BACKEND_DST"
run mkdir -p "$BACKEND_DIR"
run install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0700 "$BACKEND_SRC" "$BACKEND_DST"

# 清理旧版本留下的中文 backend 别名（它做不了 scheme，永远用不上）
if [ -n "$LEGACY_BACKEND_ALIAS" ] && [ "$LEGACY_BACKEND_ALIAS" != "$BACKEND_NAME" ]; then
    if [ -e "$BACKEND_DIR/$LEGACY_BACKEND_ALIAS" ] || [ -L "$BACKEND_DIR/$LEGACY_BACKEND_ALIAS" ]; then
        msg "    清理无用的中文 backend 别名：$LEGACY_BACKEND_ALIAS"
        run rm -f "$BACKEND_DIR/$LEGACY_BACKEND_ALIAS"
    fi
fi

# 预检 device-uri 的 scheme。
# 必须在碰 lpadmin 之前拦下来：lpadmin 对非法 URI 的处理是"先把队列删掉再报错"，
# 用户已经因此丢过一次队列了。这里的报错要直接告诉他怎么修。
scheme="${DEVICE_URI%%:*}"
case "$scheme" in
    *[!A-Za-z0-9+.-]*)
        die "device-uri 的 scheme「${scheme}」含非 ASCII 字符，lpadmin 会拒绝。
     URI scheme 受 RFC 3986 约束，只允许 字母/数字/+/-/. ，且必须以字母开头。
     用 SUSTECH_BACKEND_NAME 指定一个纯 ASCII 名字（例如 sustech-print）。
     注意：队列名 SUSTECH_QUEUE 可以照旧用中文。" ;;
esac
case "$scheme" in
    [A-Za-z]*) : ;;
    *) die "device-uri 的 scheme「${scheme}」必须以字母开头。" ;;
esac
if [ ! -e "$BACKEND_DIR/$BACKEND_NAME" ] && [ ! -L "$BACKEND_DIR/$BACKEND_NAME" ] && [ "$DRY_RUN" -eq 0 ]; then
    die "backend「${BACKEND_NAME}」不在 ${BACKEND_DIR}，device-uri 会找不到它。"
fi

# ---------------------------------------------------------------------------
# 2. 安装 PPD
# ---------------------------------------------------------------------------

msg "==> 安装 PPD 到 $PPD_DST"
run mkdir -p "$PPD_DIR"
run install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0644 "$PPD_SRC" "$PPD_DST"

# ---------------------------------------------------------------------------
# 3. 共享 spool 目录
# ---------------------------------------------------------------------------
#
# mode 0750：backend（root）能写；App（SPOOL_OWNER）能读写；
# 其他本地用户既不能列目录也不能读文件。

msg "==> 创建 spool 目录：${SPOOL_ROOT}（属主 ${SPOOL_OWNER}:${SPOOL_GROUP}，0750）"
# 用 install -d 把属主和权限一次定好，避免"先建成 0755 再 chmod"的窗口期。
# 目标已存在时 install -d 也会把属主/权限改过来（这正是幂等需要的）。
# 注意根目录要**单独**再 install 一次：install -d 只为"最后一级"应用 -m，
# 中间自动创建出来的目录会拿到默认的 0755（实测踩到）。
run install -d -m 0750 -o "$SPOOL_OWNER" -g "$SPOOL_GROUP" "$SPOOL_ROOT"
run install -d -m 0750 -o "$SPOOL_OWNER" -g "$SPOOL_GROUP" "$SPOOL_INCOMING"

# 预建驱动日志（属主=spool 属主，0644）。
# 为什么必须由安装脚本预建：backend 以 root 运行，而 CUPS 给 backend 的 umask 是
# 0077，所以由它首次创建 driver.log 会得到 root:0600 —— 用户根本读不了。
# 可是脚本最后恰恰让用户"出问题看 driver.log"（实测踩到：Permission denied）。
# backend 里也加了兜底 chmod，这里再保证"第一次出问题之前它就已经可读"。
# 日志只含作业元信息（标题/大小/结果），不含凭据；父目录 0750 也挡住了外人。
msg "==> 预建驱动日志：${SPOOL_ROOT}/driver.log（属主 ${SPOOL_OWNER}:${SPOOL_GROUP}，0644）"
if [ -e "$SPOOL_ROOT/driver.log" ]; then
    # 已存在就只修权限，**不要**截断 —— 重复安装不该抹掉历史日志
    run chmod 0644 "$SPOOL_ROOT/driver.log"
else
    run install -o "$SPOOL_OWNER" -g "$SPOOL_GROUP" -m 0644 /dev/null "$SPOOL_ROOT/driver.log"
fi

# ---------------------------------------------------------------------------
# 4. 建/更新队列（幂等）
# ---------------------------------------------------------------------------

# 沙箱测试可以只验证"文件装好了"，跳过需要 root 的队列创建
if [ "${SUSTECH_SKIP_QUEUE:-0}" = "1" ] && [ "$DRY_RUN" -eq 0 ]; then
    msg "==> SUSTECH_SKIP_QUEUE=1：跳过队列创建（需要 root 的那一步）"
elif [ "$DRY_RUN" -eq 0 ] && lpstat -p "$QUEUE" >/dev/null 2>&1; then
    msg "==> 队列「${QUEUE}」已存在，更新其 PPD、设备 URI 与描述"
    # 描述/位置也要一起更新：否则改了 QUEUE_INFO 之后重新安装不会生效
    # （以前这两项只在"创建"分支里给，更新分支漏了 —— 于是老队列永远停在旧描述上）
    run lpadmin -p "$QUEUE" -P "$PPD_DST" -v "$DEVICE_URI" \
        -D "$QUEUE_INFO" -L "$QUEUE_LOCATION" \
        -o printer-is-shared=false \
        || die "lpadmin 更新队列失败"
else
    msg "==> 创建队列「${QUEUE}」"
    run lpadmin -p "$QUEUE" \
        -D "$QUEUE_INFO" \
        -L "$QUEUE_LOCATION" \
        -v "$DEVICE_URI" \
        -P "$PPD_DST" \
        -o printer-is-shared=false \
        -o printer-error-policy=retry-job \
        -E \
        || die "lpadmin 创建队列失败"
fi

# 确保启用且接受作业
if [ "${SUSTECH_SKIP_QUEUE:-0}" = "1" ] && [ "$DRY_RUN" -eq 0 ]; then
    msg "==> SUSTECH_SKIP_QUEUE=1：跳过队列启用/接受作业"
else
    run lpadmin -p "$QUEUE" -E
    run cupsenable "$QUEUE"
    run cupsaccept "$QUEUE"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    msg ""
    msg "==> dry-run 结束：上面就是真正安装时会执行的命令。"
    exit 0
fi

if [ "${SUSTECH_SKIP_QUEUE:-0}" = "1" ]; then
    msg ""
    msg "==> 完成（已跳过队列创建）。"
    msg "    spool 目录：${SPOOL_INCOMING}（属主 ${SPOOL_OWNER}:${SPOOL_GROUP}）"
    exit 0
fi

msg ""
msg "==> 完成。当前队列状态："
lpstat -p "$QUEUE" -l 2>&1 | sed 's/^/    /' || true
lpstat -v "$QUEUE" 2>&1 | sed 's/^/    /' || true

msg ""
msg "spool 目录（App 监听的就是它）："
msg "  $SPOOL_INCOMING"
msg "驱动日志："
msg "  $SPOOL_ROOT/driver.log"
msg ""
msg "下一步："
msg "  1. 打开「南科大云打印」客户端并登录"
msg "  2. 在任意应用里选择打印机「${QUEUE}」，点打印"
msg "  3. 作业会先出现在 ${SPOOL_INCOMING}，由 App 自动取走上传"
msg "  4. 出问题看：$SPOOL_ROOT/driver.log 和 /var/log/cups/error_log"
