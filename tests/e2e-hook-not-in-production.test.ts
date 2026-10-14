import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * E2E 钩子**不得进入正式产物**（V4-07，v1.4.0）。
 *
 * ## 背景
 *
 * `src/renderer/e2eHook.ts` 给桌面歌词回归测试提供最小测试钩子
 * （`window.__YANMUSIC_E2E__`）。它必须满足两个约束：
 *
 *   ① **设了 `VITE_YANMUSIC_E2E=1` 时必须真的在产物里** ——
 *      否则钩子装不上，冒烟会以一个误导性的「钩子不可用」失败
 *      （本项第一次实现就栽在这里：当时还写了 `import.meta.env.DEV` 条件，
 *       而冒烟跑的是生产构建，`DEV` 恒为 false，整段被静态消除）；
 *   ② **没设时必须完全不在产物里** —— 它是一个可以驱动播放器状态的入口，
 *      绝不能出现在发布给用户的包里。
 *
 * 这两条都是**构建产物**的性质，用源码正则断言不算验证，所以这里真的跑构建。
 * 为控制耗时，构建在 `dist-e2e-guard/` 下进行（用完即删，不污染 `dist/`）。
 *
 * ⚠️ 需要 `vite` 可用与约 20–40 秒构建时间；CI 的单测阶段没有产物，
 * 因此**只在能跑构建时执行**，否则显式 skip 并标注未校验。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'dist-e2e-guard');

const canBuild = existsSync(path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'));

const runBuild = (withFlag: boolean) => {
  const env = { ...process.env };
  if (withFlag) env.VITE_YANMUSIC_E2E = '1';
  else delete env.VITE_YANMUSIC_E2E;
  delete env.ELECTRON_RUN_AS_NODE;

  execFileSync(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'build',
      '--outDir',
      outDir,
      '--emptyOutDir',
      // 只构建渲染层产物即可，跳过 electron 打包插件带来的额外工作
      '--mode',
      'production',
    ],
    { cwd: repoRoot, env, stdio: 'pipe', timeout: 300000 },
  );
};

/** 在产物目录里找是否出现某个字符串。 */
const grepBuilt = (needle: string): boolean => {
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
        continue;
      }
      if (!/\.(js|mjs|cjs|html)$/i.test(entry.name)) continue;
      if (readFileSync(full, 'utf8').includes(needle)) return true;
    }
    return false;
  };
  return walk(outDir);
};

test('V4-07：E2E 钩子 —— 设了开关必须在产物里，没设必须不在', (t) => {
  if (!canBuild) {
    t.skip('vite 不可用，无法验证构建产物 —— 本项**未校验**，不代表通过');
    return;
  }
  if (process.env.CI === 'true' && !process.env.VITE_YANMUSIC_E2E_ALLOW_BUILD) {
    // 单测阶段没有产物也不该在这里额外跑一次构建；显式 skip 并标注未校验
    t.skip('CI 单测阶段不额外跑构建 —— 本项**未校验**，不代表通过');
    return;
  }

  try {
    // ① 带开关：钩子必须存在
    runBuild(true);
    assert.ok(
      grepBuilt('__YANMUSIC_E2E__'),
      '设了 VITE_YANMUSIC_E2E=1 却没在产物里找到钩子 —— ' +
        '说明它被静态消除了（例如又加了 import.meta.env.DEV 之类的条件），' +
        '冒烟会以一个误导性的「钩子不可用」失败',
    );

    // ② 不带开关：钩子必须彻底消失
    runBuild(false);
    assert.ok(
      !grepBuilt('__YANMUSIC_E2E__'),
      '未设 VITE_YANMUSIC_E2E 时产物里仍有 __YANMUSIC_E2E__ —— ' +
        '它是能驱动播放器状态的入口，绝不能出现在发布给用户的包里',
    );
    assert.ok(!grepBuilt('playTone'), '未设开关时产物里仍有 playTone —— E2E 钩子未被完全静态消除');
  } finally {
    // 清理：这个目录只是守卫用的临时产物，不应留在工作区
    try {
      execFileSync(
        process.execPath,
        ['-e', `require('fs').rmSync(${JSON.stringify(outDir)},{recursive:true,force:true})`],
        {
          stdio: 'ignore',
        },
      );
    } catch {
      /* 清不掉也不影响断言结果 */
    }
  }
});
