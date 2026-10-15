/**
 * **v1.4.0 真实发布产物清单快照**（R-2 的外部基准）。
 *
 * ## 为什么需要一份「外部基准」
 *
 * `tests/release-artifacts-manifest.test.ts` 最初只断言「清单有 22 项」。
 * 这条断言**印证不了**「脚本里的清单 = 真实发布过的清单」——
 * 两者完全可能**自洽地一起错**（我写清单、我写用例，互相点头）。
 *
 * 本快照把**真实数据**固定下来，让用例改成**与它逐项对比**。
 *
 * ## 来源与快照纪律
 *
 * 来源：`gh release view v1.4.0 --json assets`（2026-10-15 取证，共 **22** 个附件），
 * 即 v1.4.0 发布后、**清理掉误入的 `first-screen.png` 之后**的状态。
 *
 * ⚠️ **这是历史快照，不要因为「发新版了」就改它** —— 它的价值恰恰在于**固定不变**。
 * 若新版产物集合与它不同，应**另开一份快照**，并在用例里说明
 * 「产物集合在哪个版本变了、为什么」。
 *
 * 对应的说明性副本见 `docs/agent/v1.4.1/fixtures/release-assets-v1.4.0.txt`
 * （该目录不入库，仅作本机留痕；**CI 用的是本文件**）。
 */

/** v1.4.0 真实附件名（升序）。 */
export const RELEASE_ASSETS_V1_4_0: readonly string[] = [
  'YanMusic-1.4.0-Windows-Setup-arm64.exe',
  'YanMusic-1.4.0-Windows-Setup-x64.exe',
  'YanMusic-1.4.0-linux-aarch64.pacman',
  'YanMusic-1.4.0-linux-aarch64.pkg.tar.zst',
  'YanMusic-1.4.0-linux-aarch64.rpm',
  'YanMusic-1.4.0-linux-amd64.deb',
  'YanMusic-1.4.0-linux-arm64.AppImage',
  'YanMusic-1.4.0-linux-arm64.deb',
  'YanMusic-1.4.0-linux-arm64.tar.gz',
  'YanMusic-1.4.0-linux-x64.pacman',
  'YanMusic-1.4.0-linux-x64.pkg.tar.zst',
  'YanMusic-1.4.0-linux-x64.tar.gz',
  'YanMusic-1.4.0-linux-x86_64.AppImage',
  'YanMusic-1.4.0-linux-x86_64.rpm',
  'YanMusic-1.4.0-mac-arm64.zip',
  'YanMusic-1.4.0-mac-x64.zip',
  'YanMusic-1.4.0-macOS-arm64.dmg',
  'YanMusic-1.4.0-macOS-x64.dmg',
  'latest-linux-arm64.yml',
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
];

/** v1.4.0 快照里出现的版本号（用于把真实名字映射成「后缀」做跨版本比较）。 */
export const RELEASE_ASSETS_V1_4_0_VERSION = '1.4.0';
