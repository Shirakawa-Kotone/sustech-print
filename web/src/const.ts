/**
 * 跨进程共享的常量 —— 改这里，别在别处硬编码。
 *
 * 这里只放"必须在多个文件里逐字一致"的字符串，因为这类字符串一旦不同步，
 * 用户就会看到"界面说 A、系统里叫 B"的困惑（本项目已经踩过两次）。
 * driver/macos/test/run-tests.sh 里有一致性断言，会逐字比对：
 *   web/src/const.ts  ↔  lib/paths.mjs
 *                     ↔  driver/macos/install.sh
 *                     ↔  driver/windows/install-printer.ps1
 */

/**
 * 虚拟打印机的名字，用户在 Word / 浏览器里点「打印」时看到的就是它。
 *
 * 为什么是下划线而不是空格：CUPS 的 lpadmin **拒绝 C 语言意义上的空白字符**
 * （空格 / TAB / LF），但报错信息写成"打印机名称只能包含可打印字符"，
 * 极具误导性。macOS 上没有任何办法把空格塞进队列名（试过 IPP 之外的歪路，
 * 且全角空格这类"看起来像空格"的字符会让 `lp -d` 无法输入，不能要）。
 * Windows 允许空格，但两边统一用一个名字，才不会出现文档/界面/系统三份名字。
 */
export const PRINTER_NAME = "SUSTech_Printer";
