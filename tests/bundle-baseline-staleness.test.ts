import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkBundleSize, ENTRY_TOLERANCE_RATIO } from '../scripts/check-bundle-size.mjs';

/**
 * V4-12 的**鉴别力自证**：基线过时（容忍带已被历史增长吃掉）时必须判定为「该校准了」。
 *
 * 上一条用例只有真实产物存在时才跑，CI 里永远 skip —— 那样它的鉴别力就永远
 * 得不到验证。这里用一个**临时产物**复现「基线过时」的确切形态：
 * 实测体积 ≈ 基线（即容忍带几乎全被吃掉），判据必须变红。
 *
 * 这也正是 v1.4.0 校准前的真实状态：基线取自 v1.2.9，而实测已到 v1.3.7，
 * 差的 2,192 B 恰好落在 2% 容忍带（22,579 B）里 —— 于是**真正可用的余量只剩约 314 B**。
 */

/** 复刻 bundle-size-guard.test.ts 里那条判据的核心算式（临时 root 版）。 */
const headroomVerdict = (root: string, baselineBytes: number) => {
  const result = checkBundleSize({ root, baselineBytes, tolerance: ENTRY_TOLERANCE_RATIO });
  const toleranceBytes = result.budgetBytes - baselineBytes;
  const headroom = result.budgetBytes - result.totalBytes;
  return { ok: headroom >= Math.floor(toleranceBytes / 3), headroom, toleranceBytes, result };
};

const makeRoot = (entryBytes: number) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-baseline-stale-'));
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'app.js'), 'x'.repeat(entryBytes));
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<html><head><script src="./app.js"></script></head></html>',
  );
  return root;
};

test('V4-12：基线过时（容忍带已被吃掉）时必须判为「该校准了」', () => {
  // 实测 1000 B，基线也按 1000 B —— 容忍带 20 B 中已用掉 0，余量 20 B ≥ 6 B，应通过
  const freshRoot = makeRoot(1000);
  try {
    const fresh = headroomVerdict(freshRoot, 1000);
    assert.equal(fresh.ok, true, '基线刚校准过（等于实测）时应通过 —— 确认这条判据本身有效');
    assert.equal(fresh.headroom, 20);
  } finally {
    fs.rmSync(freshRoot, { recursive: true, force: true });
  }

  // 实测 1020 B 而基线仍是 1000 B：容忍带 20 B 已被吃掉 100%，余量 0 → 必须变红
  const staleRoot = makeRoot(1020);
  try {
    const stale = headroomVerdict(staleRoot, 1000);
    assert.equal(
      stale.ok,
      false,
      '容忍带被历史增长吃掉后必须判为「基线该重新校准」—— 否则这条守卫没有鉴别力',
    );
    assert.equal(stale.headroom, 0);
  } finally {
    fs.rmSync(staleRoot, { recursive: true, force: true });
  }
});

/**
 * 反向的第二形态：实测**超过**预算（真正的回退）—— 那是 S-5 那条用例的职责，
 * 这里只确认两种失败在数值上可区分，避免把「该校准」与「真回退」混为一谈。
 */
test('V4-12：「该校准」与「真回退」是两种不同判定', () => {
  const root = makeRoot(1100); // 超出 1000 + 2% = 1020 的预算
  try {
    const verdict = headroomVerdict(root, 1000);
    assert.equal(verdict.result.ok, false, '超预算时 checkBundleSize 本身应报 ok=false');
    assert.equal(verdict.headroom < 0, true, '余量为负 = 真回退（与「正好用光容忍带」不同）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
