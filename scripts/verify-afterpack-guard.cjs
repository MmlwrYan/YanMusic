#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * IMP-06 验证脚本：afterPack 钩子在缺少关键资源时必须让构建失败。
 *
 * 复现目标（审计编号 IMP-06）：
 *   build/afterPack.js 原先对「缺原生模块 / 缺 libmpv / 缺 server」只打印 WARN，
 *   函数不抛错，于是 CI 会产出「能安装但无法播放」的包且构建状态为绿。
 *
 * 验证方式：直接 require 该钩子，用两个伪造的 electron-builder context 调用它：
 *   A. 空 resources 目录  → 期望抛错，且错误信息包含三类关键缺失
 *   B. 完整 resources 目录 → 期望不抛错
 *
 * 用法（仓库根目录）：
 *   node scripts/verify-afterpack-guard.cjs
 *
 * 退出码：0 = 两项判定均符合预期；1 = 判定不符或环境异常。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const afterPack = require(path.join(ROOT, 'build', 'afterPack.js')).default;

const NATIVE_MODULES = [
  'yan-media-controls',
  'yan-mpv-player',
  'yan-storage',
  'yan-spectrum-capture',
];

const makeContext = (appOutDir, projectDir) => ({
  electronPlatformName: 'win32',
  arch: 1,
  appOutDir,
  packager: {
    projectDir,
    appInfo: { productFilename: 'YanMusic' },
  },
});

const quiet = async (fn) => {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
};

const main = async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yanmusic-afterpack-'));
  let pass = true;

  // ── 场景 A：关键资源全缺 → 必须抛错 ─────────────────────────────────────
  const emptyOut = path.join(sandbox, 'empty', 'win-unpacked');
  fs.mkdirSync(path.join(emptyOut, 'resources'), { recursive: true });
  let threw = null;
  // afterPack 是 async 函数：抛错表现为 Promise rejection，必须 await 才能捕获。
  await quiet(async () => {
    try {
      await afterPack(makeContext(emptyOut, path.join(sandbox, 'no-such-project')));
    } catch (error) {
      threw = error;
    }
  });

  console.log('=== 场景 A：缺少全部关键资源 ===');
  if (threw) {
    console.log('[A] 抛错（符合预期）:', String(threw.message).split('\n')[0]);
    const message = String(threw.message);
    const expected = ['缺少原生模块', 'resources/mpv', 'resources/server'];
    for (const needle of expected) {
      const hit = message.includes(needle);
      console.log(`[A] 错误信息包含「${needle}」= ${hit}`);
      if (!hit) pass = false;
    }
  } else {
    console.log('[A] 未抛错 —— 不符合预期（构建会静默产出坏包）');
    pass = false;
  }

  // ── 场景 B：关键资源齐备 → 不得抛错 ─────────────────────────────────────
  const fullOut = path.join(sandbox, 'full', 'win-unpacked');
  const fullResources = path.join(fullOut, 'resources');
  fs.mkdirSync(path.join(fullResources, 'native'), { recursive: true });
  fs.mkdirSync(path.join(fullResources, 'mpv'), { recursive: true });
  fs.mkdirSync(path.join(fullResources, 'server', 'module'), { recursive: true });
  fs.mkdirSync(path.join(fullResources, 'server', 'util'), { recursive: true });
  fs.mkdirSync(path.join(fullResources, 'icons'), { recursive: true });
  for (const name of NATIVE_MODULES) {
    fs.writeFileSync(path.join(fullResources, 'native', `${name}.node`), 'stub');
  }
  fs.writeFileSync(path.join(fullResources, 'mpv', 'libmpv-2.dll'), 'stub');
  fs.writeFileSync(path.join(fullResources, 'server', 'module', 'song_url.js'), '// stub');
  fs.writeFileSync(path.join(fullResources, 'server', 'util', 'request.js'), '// stub');
  fs.writeFileSync(path.join(fullResources, 'icons', 'icon.png'), 'stub');

  let threwB = null;
  await quiet(async () => {
    try {
      await afterPack(makeContext(fullOut, path.join(sandbox, 'no-such-project')));
    } catch (error) {
      threwB = error;
    }
  });

  console.log('\n=== 场景 B：关键资源齐备 ===');
  if (threwB) {
    console.log('[B] 抛错 —— 不符合预期:', threwB.message);
    pass = false;
  } else {
    console.log('[B] 未抛错（符合预期）');
  }

  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(
    pass
      ? '\n[verify] RESULT: PASS — afterPack 关键缺失会中止构建，资源齐备时不误报'
      : '\n[verify] RESULT: FAIL — 判定不符预期',
  );
  process.exit(pass ? 0 : 1);
};

main().catch((error) => {
  console.error('[verify] ERROR', error);
  process.exit(1);
});
