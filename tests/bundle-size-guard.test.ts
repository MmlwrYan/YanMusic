import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkBundleSize,
  ENTRY_BASELINE_BYTES,
  ENTRY_TOLERANCE_RATIO,
} from '../scripts/check-bundle-size.mjs';

/**
 * S-5：首屏入口资源体积守卫（v1.3.0）。
 *
 * **它防什么**：只防「回退」—— 把大依赖引入入口链、或把本该懒加载的模块拽回首屏，
 * 这类改动在 code review 里看不出来（往往只是一行 import），但直接拖慢冷启动。
 *
 * **为什么在这里 `skip` 而不是 `fail`**：CI 的步骤顺序是
 * `Run unit tests`(:511) → `Build desktop app`(:531)，单测跑的时候**产物还不存在**。
 * 因此无产物时**必须显式 skip 并标注「未校验」**，而不是静默通过 —— 静默通过会让
 * 这个守卫在 CI 里变成安慰剂。发布前的真正把关由 `scripts/verify.ps1` 在
 * `vite build` 之后调用同一逻辑的 CLI 完成（那里没有产物就是失败）。
 *
 * **怎样改会变红**：
 * ① 把 `ENTRY_BASELINE_BYTES` 调低到小于当前体积 → 变红；
 * ② 把容忍带设为负数/0 并让体积略增（或往 `dist/index.html` 手动塞一个大文件引用）→ 变红。
 */
test('S-5：首屏入口资源体积不得超过基线 +2%（无产物时跳过并标注未校验）', (t) => {
  const result = checkBundleSize();

  if (!result.present) {
    t.skip('dist/index.html 不存在（未构建）—— 本项**未校验**，不代表通过');
    return;
  }

  assert.ok(
    result.entryCount > 0,
    '解析 dist/index.html 得到 0 个入口资源 —— 说明产物结构变了，守卫口径需要更新（而不是当作通过）',
  );

  assert.deepEqual(
    result.missing,
    [],
    `入口引用的资源在磁盘上不存在（构建异常）：\n${result.missing.join('\n')}`,
  );

  const kib = (n: number) => (n / 1024).toFixed(1);
  assert.ok(
    result.ok,
    `首屏入口体积 ${result.totalBytes} B (${kib(result.totalBytes)} KiB) ` +
      `超出预算 ${result.budgetBytes} B (${kib(result.budgetBytes)} KiB)` +
      ` [基线 ${ENTRY_BASELINE_BYTES} B + ${(ENTRY_TOLERANCE_RATIO * 100).toFixed(0)}%]。` +
      `请检查是否有大依赖被引入入口链，或本应懒加载的模块被拽回首屏。`,
  );
});

/**
 * S-5 的鉴别力自证：把基线调到「必然超出」的水平，守卫必须判定不通过。
 *
 * 这条不依赖真实产物（用一个临时 root 造一个假的 dist/index.html）——
 * 因为 CI 里没有产物，若只靠上一条用例，鉴别力验证就永远做不了。
 */
test('S-5：鉴别力自证 —— 基线被调低时必须判定为超预算', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-bundle-guard-'));
  try {
    const distDir = path.join(tmpRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    // 造一个 1000 字节的“入口资源”
    fs.writeFileSync(path.join(distDir, 'app.js'), 'x'.repeat(1000));
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<html><head><script src="./app.js"></script></head></html>',
    );

    const hugeBudget = checkBundleSize({ root: tmpRoot, baselineBytes: 1_000_000 });
    assert.equal(hugeBudget.ok, true, '预算充足时应通过（确认这个用例本身有效）');

    const tinyBudget = checkBundleSize({ root: tmpRoot, baselineBytes: 100, tolerance: 0.02 });
    assert.equal(
      tinyBudget.ok,
      false,
      '预算被调低到 100B 时必须判定为超预算 —— 否则守卫没有鉴别力',
    );
    assert.equal(tinyBudget.totalBytes, 1000);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
