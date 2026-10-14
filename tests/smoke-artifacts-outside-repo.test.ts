import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 冒烟脚本的**留档目录必须落在仓库之外**（V4-05，v1.4.0）。
 *
 * ## 这条守卫来自一次真实事故
 *
 * v1.4.0 首次发布时，`smoke-gui.cjs` 把首屏截图写进仓库内的
 * `smoke-artifacts/first-screen.png`。`electron-builder` 的输出目录就是仓库里的
 * `release/`，而产物上传步骤的 glob 是 `release/YanMusic-*` 家族 ——
 * 结果那个 png **被当成 Release 产物发布了**：
 *
 *   · 该版本多了**第 23 个附件**（项目约定是 **22 个**）；
 *   · 它还是**第一次冒烟失败的画面**，与正式构建毫无关系；
 *   · 是**人工比对产物清单**时才发现的 —— 没有任何自动化守卫拦它。
 *
 * 事后处置：删掉那个附件（回到 22 个）+ 把截图改写到 `os.tmpdir()`
 * + 加这条守卫。**这就是「守卫要跟着事故走」的具体含义。**
 *
 * ## 守卫的做法
 *
 * 不是断言「文件里出现过 os.tmpdir」那种弱检查（同文件里 `tmpdir` 可能出现多次），
 * 而是锚定**写入路径的表达式的形状**：
 *   ① 截图路径必须由 `os.tmpdir()` 参与构造；
 *   ② 任何 `path.join(ROOT, ...)` 都不能用来构造截图目录 ——
 *      `ROOT` 就是仓库根，用它拼出来的东西必然落在工作区里。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokePath = path.join(repoRoot, 'scripts/smoke-gui.cjs');

test('V4-05：冒烟截图必须写在仓库之外（不得用 path.join(ROOT, …)）', () => {
  const source = readFileSync(smokePath, 'utf8');

  assert.ok(
    /const artifactDir = path\.join\(os\.tmpdir\(\)/.test(source),
    '截图目录必须由 `path.join(os.tmpdir(), …)` 构造 —— 写成仓库内目录会让它被 ' +
      'electron-builder 的产物 glob 扫到并**发布成 Release 附件**（v1.4.0 真实事故）。',
  );

  assert.ok(
    !/path\.join\(ROOT,\s*'smoke-artifacts'/.test(source),
    '不得再出现 `path.join(ROOT, "smoke-artifacts")` —— 那是导致 v1.4.0 ' +
      '多发一个 Release 附件的原始写法。',
  );

  // 写入语句必须用 artifactDir（而不是另拼一个仓库内路径）
  assert.ok(
    /writeFileSync\(\s*shotPath/.test(source) &&
      /const shotPath = path\.join\(artifactDir,/.test(source),
    '截图必须写入由 artifactDir 派生的路径',
  );
});

/**
 * CI 侧的对应守卫：上传步骤必须从**仓库之外**取截图。
 *
 * 脚本改了而工作流没改 → 截图永远上传不到，失败时又回到「只告诉你红了」。
 * 两边必须一起改，故一起守。
 */
test('V4-05：CI 上传步骤必须从仓库之外的路径取截图', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/build.yml'), 'utf8');
  const start = workflow.indexOf('Upload GUI smoke artifacts');
  assert.ok(start > 0, '工作流里应存在 `Upload GUI smoke artifacts` 步骤');
  const block = workflow.slice(start, start + 1400);

  assert.ok(
    block.includes('/tmp/yanmusic-smoke-artifacts'),
    'CI 必须从 `/tmp/yanmusic-smoke-artifacts`（即 Linux/macOS 上的 os.tmpdir()）取截图；' +
      '不得使用仓库内路径。',
  );
  assert.ok(
    !/path:\s*smoke-artifacts\/\s*$/m.test(block),
    '`path:` 不得是仓库内的 `smoke-artifacts/` —— 那正是 v1.4.0 事故的写法。',
  );
});
