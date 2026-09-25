#!/usr/bin/env node
/**
 * IMP-08 复现脚本：原生层 `CString::new(...).unwrap()` 在收到含内部 NUL 的字符串时是否 panic。
 *
 * 复现目标（审计编号 IMP-08 / ROB-01）：
 *   native/yan-mpv-player/src/player.rs 的 set_property_string() 使用
 *   `CString::new(value).unwrap()`；若 value 含内部 NUL 字节，CString::new 返回 Err → unwrap panic。
 *   该 value 可源自渲染层传入的用户数据（如媒体标题 force-media-title）。
 *
 * 本脚本判定「panic 是否被 napi 边界捕获为 JS 异常」：
 *   - 若抛出 JS Error（且进程存活）→ panic 被捕获，风险降级为「可用性/错误处理」问题
 *   - 若进程异常退出（退出码非 0 且无 JS 异常）→ panic 逃逸到进程，风险为「主进程崩溃」
 *
 * 用法（仓库根目录）：
 *   node scripts/repro-native-nul-panic.cjs
 *
 * 退出码：0 = 已取得明确判定（脚本内打印结论）；1 = 环境不可用。
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADDON = path.join(ROOT, 'native', 'yan-mpv-player', 'yan-mpv-player.node');
const MPV_DIR = path.join(ROOT, 'build', 'mpv');

const main = () => {
  const addon = require(ADDON);
  console.log('[repro] addon loaded');

  const exportsList = Object.keys(addon).sort();
  console.log('[repro] addon exports =', exportsList.join(', '));

  const target = exportsList.find((name) => /^setMediaTitle$/i.test(name));
  if (!target) {
    console.log('[repro] RESULT: SKIP — 未找到 setMediaTitle 导出，无法复现');
    process.exit(1);
  }

  const fs = require('fs');
  const libName = fs
    .readdirSync(MPV_DIR)
    .find((name) => /^libmpv-2\.dll$|^mpv-2\.dll$/i.test(name));
  const libPath = path.join(MPV_DIR, libName);
  console.log('[repro] libmpv path =', libPath);

  const initResult = addon.initialize(libPath, undefined);
  console.log('[repro] initialize ->', JSON.stringify(initResult ?? null));

  // 正常值应成功
  try {
    addon[target]('normal-title');
    console.log('[repro] setMediaTitle("normal-title") -> OK (无异常)');
  } catch (error) {
    console.log('[repro] setMediaTitle("normal-title") -> THREW:', error && error.message);
  }

  // 含内部 NUL 的值
  let threw = null;
  try {
    addon[target]('nul\u0000injected');
    console.log('[repro] setMediaTitle("nul\\0injected") -> OK (无异常，未触发 panic 路径)');
  } catch (error) {
    threw = error;
    console.log('[repro] setMediaTitle("nul\\0injected") -> THREW:', error && error.message);
    console.log('[repro] error name =', error && error.name);
  }

  try {
    addon.destroy();
  } catch {
    /* ignore */
  }

  console.log(
    threw
      ? '\n[repro] RESULT: PANIC CAUGHT — 含 NUL 的输入被 napi 边界转换为 JS 异常（进程存活）'
      : '\n[repro] RESULT: NO PANIC OBSERVED — 未观察到 panic',
  );
  process.exit(0);
};

try {
  main();
} catch (error) {
  console.error('[repro] ERROR', error);
  process.exit(1);
}
