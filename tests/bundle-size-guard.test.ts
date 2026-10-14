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

/**
 * V4-12（v1.4.0）：**基线必须等于当前实测值** —— 不许留下「2% 长期水位」。
 *
 * ## 这条守什么
 *
 * `ENTRY_TOLERANCE_RATIO` 的语义是「允许**单次**改动临时超出的幅度」，
 * 正确用法是**每次发版把 `ENTRY_BASELINE_BYTES` 校准到该版本实测值**。
 *
 * 不校准会怎样（本项就是因为这个才存在）：基线取自 v1.2.9 时实测已到 v1.3.7，
 * 那 2,192 B 的差**被容忍带吃掉** —— 表面上 `预算 − 当前体积` 还有 20,386 B，
 * **真正可用的余量只剩约 314 B**。
 *
 * ## 为什么断言的是「实测 ≤ 基线」而不是「余量够大」
 *
 * 这是本条守卫**第二版**才修正过来的关键点，值得记下来：
 *
 * 第一版断言「余量 ≥ 容忍带的 1/3」。它**放过了真正要抓的形态** ——
 * v1.4.0 发版时实测 1,133,086 B、基线（当时）1,131,118 B，
 * 即**实测已经超过基线**、容忍带被吃掉 1,968 B，而「余量 ≥ 1/3 容忍带」
 * 依然成立（20,654 ≥ 7,540），于是**守卫沉默**。
 *
 * 正确口径是直接看「实测 vs 基线」：
 * **基线既然定义为「当前已发布版本的实测值」，实测就不该超过它。**
 * 一旦超过，说明基线过时了 —— 必须在本版重新校准。
 *
 * 用 `<=` 而非 `==`：`ENTRY_BASELINE_BYTES` 由发版时手工校准，
 * 而本用例可能在发版流程中间的任何时刻被跑到。`<=` 表达
 * 「基线不得落后于实测」这个不变式；等号由发版流程保证。
 */
test('V4-12：基线不得落后于实测（落后即说明该重新校准）', (t) => {
  const result = checkBundleSize();
  if (!result.present) {
    t.skip('dist/index.html 不存在（未构建）—— 本项**未校验**，不代表通过');
    return;
  }

  assert.ok(
    result.totalBytes <= ENTRY_BASELINE_BYTES,
    `首屏实测 ${result.totalBytes} B **已超过基线** ${ENTRY_BASELINE_BYTES} B` +
      `（超出 ${result.totalBytes - ENTRY_BASELINE_BYTES} B）。\n` +
      `基线的定义是「当前已发布版本的实测值」，所以它必须在本版重新校准为 ` +
      `${result.totalBytes} B（scripts/check-bundle-size.mjs 的 ENTRY_BASELINE_BYTES）。\n` +
      `⚠️ 这条陷阱很隐蔽：checkBundleSize() 仍会报「在预算内」（它比的是 ` +
      `基线 × 1.02），只有把「实测 vs 基线」单独看才看得出来 —— ` +
      `而被吃掉的那部分容忍带，正是下个版本「以为还很宽松」的来源。`,
  );
});

/**
 * 补充口径：容忍带必须**仍然基本可用**（不能被消耗到贴边）。
 *
 * 与上一条合起来才完整：
 *   · 上一条防「基线落后于实测」（**过时**）；
 *   · 这一条防「实测贴着预算走」（**余量耗光**），哪怕基线是新的。
 *
 * 阈值取容忍带的 1/3：留一点同版内后续小改动的空间，
 * 避免发版当天反复来回校准。
 */
test('V4-12：首屏余量必须仍有容忍带的三分之一', (t) => {
  const result = checkBundleSize();
  if (!result.present) {
    t.skip('dist/index.html 不存在（未构建）—— 本项**未校验**，不代表通过');
    return;
  }

  const toleranceBytes = result.budgetBytes - ENTRY_BASELINE_BYTES;
  assert.ok(
    toleranceBytes > 0,
    `容忍带必须为正：预算 ${result.budgetBytes} 应大于基线 ${ENTRY_BASELINE_BYTES}`,
  );

  const headroom = result.budgetBytes - result.totalBytes;
  const minimum = Math.floor(toleranceBytes / 3);
  const kib = (n: number) => (n / 1024).toFixed(1);

  assert.ok(
    headroom >= minimum,
    `首屏余量只剩 ${headroom} B (${kib(headroom)} KiB)，而容忍带有 ` +
      `${toleranceBytes} B (${kib(toleranceBytes)} KiB)；要求至少保留 1/3` +
      `（${minimum} B）。若基线已经是最新的，说明本版真的把余量用掉了 —— ` +
      `下个版本必须先腾挪（见 docs/agent 里的首屏腾挪取证）再加功能。`,
  );
});
