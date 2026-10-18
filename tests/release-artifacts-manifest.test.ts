import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_ASSETS_V1_4_0,
  RELEASE_ASSETS_V1_4_0_VERSION,
} from './fixtures/release-assets-v1.4.0.ts';

/**
 * 发布产物清单守卫的**正向 + 鉴别力自证**（v1.4.1，R-2）。
 *
 * ## 为什么必须做鉴别力自证
 *
 * 上一条守卫（`scripts/check-release-artifacts.mjs`）在 CI 的**发布作业**里跑，
 * 而发布作业只在**推 tag** 时执行 —— 也就是说
 * **单测阶段永远验证不到它是否真的能拦住东西**。
 * 于是这里用临时目录直接驱动那个脚本，把三种形态都跑一遍：
 *
 *   ① **本版应有的清单** → 必须通过；
 *   ② **清单 + 一个无关文件**（`first-screen.png`）→ 必须失败
 *      —— **这就是 v1.4.0 真实事故的原形**；
 *   ③ **清单少一个产物**（去掉一个 `.dmg`）→ 必须失败。
 *
 * ② 是关键：v1.4.0 那次是**人工比对**发现的，没有任何守卫拦它。
 * 本用例保证同样的东西再来一次**会被拦住**。
 *
 * ⚠️ 注入的必须是**缺陷原形**：这里用的文件名、数量、后缀
 * 都与 v1.4.0 那次事故逐项一致（22 → 23，多出 `first-screen.png`）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'check-release-artifacts.mjs');

/**
 * 允许清单来自**唯一的定义处** `scripts/release-asset-manifest.mjs`。
 *
 * ## 为什么这一点很重要（第一版与第二版分别错在哪）
 *
 * - **第一版**在本文件里**独立重写**了一份清单，只断言「它有 22 项」——
 *   那是**循环论证**：我写清单、我写用例，两者可以**自洽地一起错**，
 *   而且它证明不了「清单 = 真实发布过的清单」。
 * - **第二版**改成解析 `check-release-artifacts.mjs` 源码取清单（好了一些），
 *   但 v1.4.2 又踩了一次 v1.4.0 的坑，说明还需要**发布后**再校验一次；
 *   于是清单抽到 `release-asset-manifest.mjs` 作为**唯一来源**，
 *   同时供「上传前」与「发布后」两道校验使用。
 *
 * 本文件直接 import 那份唯一定义，并与**真实发布快照**双向比对。
 * 这样任何一处漂移都会立刻暴露。
 */
const manifest = await import('../scripts/release-asset-manifest.mjs');
const PAYLOAD_SUFFIXES: string[] = [...manifest.EXPECTED_PAYLOAD_SUFFIXES];
const METADATA: string[] = [...manifest.EXPECTED_METADATA];

const VERSION = '9.9.9'; // 用一个不存在的版本，确保测的是「清单逻辑」而不是真版本

const expectedNames = [...PAYLOAD_SUFFIXES.map((s) => `YanMusic-${VERSION}-${s}`), ...METADATA];

/** 建一个临时产物目录，写入给定的文件名（内容无所谓，只查名字）。 */
const makeDir = (names: string[]): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yan-release-artifacts-'));
  for (const n of names) writeFileSync(path.join(dir, n), 'x');
  return dir;
};

/** `execFileSync` 失败时抛出的错误形状（只取本用例用到的三个字段）。 */
type ExecFailure = { status?: number | null; stdout?: unknown; stderr?: unknown };

/** 跑守卫脚本，返回 { code, stdout, stderr }。 */
const runGuard = (dir: string): { code: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync(process.execPath, [script, dir, `--version=${VERSION}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as ExecFailure;
    return {
      code: e.status ?? 1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
    };
  }
};

/**
 * **本文件最重要的一条用例**：把发布脚本里的允许清单，与
 * 「**v1.4.0 真实发布过的 22 个附件**」逐项对比。
 *
 * 没有这一条，前面那条「22 项 → 通过」就是**循环论证**：
 * 我自己写清单、自己写用例，互相点头，而**真实发布**可能是另一回事。
 *
 * 做法：把快照里的真实文件名按版本号拆成「后缀」，与脚本里提取出的
 * 两组清单做**双向**比较（真实 ⊆ 清单 且 清单 ⊆ 真实）。
 */
test('R-2 ⓪ 【外部基准】允许清单必须与 v1.4.0 真实发布的 22 个附件逐项一致', () => {
  const snapshot = [...RELEASE_ASSETS_V1_4_0];

  // 快照本身的自洽性
  assert.equal(snapshot.length, 22, `v1.4.0 真实附件应为 22 个，快照里是 ${snapshot.length}`);
  assert.equal(new Set(snapshot).size, 22, '快照里不应有重复项');

  const prefix = `YanMusic-${RELEASE_ASSETS_V1_4_0_VERSION}-`;
  const snapshotPayload = snapshot
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length));
  const snapshotMetadata = snapshot.filter((n) => !n.startsWith(prefix));

  assert.equal(
    snapshotPayload.length,
    18,
    `真实平台产物应为 18 个，实际 ${snapshotPayload.length}`,
  );
  assert.equal(snapshotMetadata.length, 4, `真实元数据应为 4 个，实际 ${snapshotMetadata.length}`);

  // 双向比较：任何一边多/少都会被点名
  const compare = (label: string, real: string[], shipped: string[]) => {
    const realSet = new Set(real);
    const shippedSet = new Set(shipped);
    const missing = real.filter((x) => !shippedSet.has(x)); // 真实有、脚本缺
    const extra = shipped.filter((x) => !realSet.has(x)); // 脚本有、真实无
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${label} 与真实发布不一致：\n` +
        `  真实发布有、脚本清单缺: ${missing.join(', ') || '(无)'}\n` +
        `  脚本清单有、真实发布无: ${extra.join(', ') || '(无)'}\n` +
        `  ⚠️ 若这是**有意**的产物集合变更，请另开一份快照并说明原因；` +
        `不要把真实快照改成「迁就脚本」的样子。`,
    );
  };

  compare('平台产物后缀', snapshotPayload, PAYLOAD_SUFFIXES);
  compare('自动更新元数据', snapshotMetadata, METADATA);

  // 后缀不重复（重复会让「数量 == 22」在真实场景下悄悄失真）
  assert.equal(new Set(PAYLOAD_SUFFIXES).size, PAYLOAD_SUFFIXES.length, '允许清单里不应有重复后缀');
});

test('R-2 ① 本版应有的 22 个产物 → 守卫必须通过', () => {
  assert.equal(
    expectedNames.length,
    22,
    `允许清单本身必须恰好 22 项，实际 ${expectedNames.length}`,
  );
  const dir = makeDir(expectedNames);
  try {
    const r = runGuard(dir);
    assert.equal(r.code, 0, `应通过，却退出了 ${r.code}：\n${r.stderr}`);
    assert.match(r.stdout, /发布产物清单吻合：22 个/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-2 ② 【事故原形】多出一个 first-screen.png → 守卫必须变红', () => {
  // v1.4.0 真实事故：22 个正确产物 + 一个混进来的冒烟截图 = 23
  const dir = makeDir([...expectedNames, 'first-screen.png']);
  try {
    const r = runGuard(dir);
    assert.notEqual(
      r.code,
      0,
      '多出无关文件时必须失败 —— 这正是 v1.4.0 发布事故（第 23 个附件 ' +
        'first-screen.png）的形态，当时没有任何守卫拦住它',
    );
    assert.match(r.stderr, /不属于发布产物/, '应明确指出「多出的文件不属于发布产物」');
    assert.match(r.stderr, /\+ first-screen\.png/, '应点名多出的文件');
    assert.match(r.stderr, /期望 22 个，实际 23 个/, '应给出数量差异');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-2 ③ 少一个产物（发布不完整）→ 守卫必须变红', () => {
  const withoutOne = expectedNames.filter((n) => n !== `YanMusic-${VERSION}-macOS-arm64.dmg`);
  assert.equal(withoutOne.length, 21, '构造用例应恰好少 1 个');
  const dir = makeDir(withoutOne);
  try {
    const r = runGuard(dir);
    assert.notEqual(r.code, 0, '缺产物时必须失败（少一个 .dmg 意味着该平台不可用）');
    assert.match(r.stderr, /发布不完整/);
    assert.match(r.stderr, /- YanMusic-9\.9\.9-macOS-arm64\.dmg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 产物目录不存在时应明确报错，而不是静默通过（「没有产物」不等于「清单正确」）。 */
test('R-2 ④ 产物目录不存在 → 必须失败并说明原因', () => {
  const missing = path.join(os.tmpdir(), 'yan-release-artifacts-does-not-exist-12345');
  rmSync(missing, { recursive: true, force: true });
  const r = runGuard(missing);
  assert.notEqual(r.code, 0, '目录不存在时必须失败 —— 否则发布作业拿不到产物也会「通过」');
  assert.match(r.stderr, /产物目录不存在/);
});

/** 版本号来自package.json / 环境变量时也应当工作（CI 里是 GITHUB_REF_NAME）。 */
test('R-2 ⑤ 版本号从 GITHUB_REF_NAME 读取（含前导 v）', () => {
  const names = [...PAYLOAD_SUFFIXES.map((s) => `YanMusic-${VERSION}-${s}`), ...METADATA];
  const dir = makeDir(names);
  try {
    const stdout = execFileSync(process.execPath, [script, dir], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: `v${VERSION}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(stdout, new RegExp(`版本 ${VERSION}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * **v2.0.0 真实事故**：无关文件藏在**子目录**里，藏在第 4 层。
 *
 * 形态与 ② 只差一个「深度」：`actions/download-artifact` 在没有 `pattern` 时
 * 会把 `gui-smoke-*` 一并合并下来，其内部结构是
 * `tmp/yanmusic-smoke-artifacts/first-screen.png`，落在 `release-artifacts/` 的第 4 层。
 *
 * 当时守卫用的是 `readdirSync`（只看顶层），于是它**静默放行**，
 * Release 里第三次多出第 23 个附件 —— 因为 `action-gh-release` 的
 * `release-artifacts/**` 是**递归** glob。
 *
 * 这条用例钉住「判据不能带深度限制」。
 */
test('R-2 ⑥ 【v2.0.0 事故原形】无关文件藏在子目录 → 守卫同样必须变红', () => {
  const dir = makeDir(expectedNames);
  const nested = path.join(dir, 'tmp', 'yanmusic-smoke-artifacts');
  try {
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'first-screen.png'), 'x');

    const r = runGuard(dir);
    assert.notEqual(
      r.code,
      0,
      '子目录里的无关文件也必须让守卫失败 —— 顶层扫描 + 深度限制是**可以被绕过**的判据，' +
        '而 upload 用的 glob 是递归的',
    );
    assert.match(
      r.stderr,
      /tmp\/yanmusic-smoke-artifacts\/first-screen\.png/,
      '应点名**带相对路径**的多余文件（只报 basename 会让人以为它就在顶层）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 发布作业的下载步骤必须**按前缀过滤** artifact。
 *
 * 这是 v2.0.0 查清的真根因：`merge-multiple` **不筛来源**，
 * 不给 `pattern` 就会把 `gui-smoke-*` 一起合并下来。
 * 只在脚本里加深度检查是治症状，这里从入口钉住。
 */
test('R-2 ⑦ 发布作业下载 artifact 时必须带 `pattern`，且不含 gui-smoke', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'build.yml'), 'utf8');

  // 取出「Download all build artifacts」这一个 step 的正文（到下一个 `- name:` 为止）
  const start = workflow.indexOf('- name: Download all build artifacts');
  assert.notEqual(start, -1, 'build.yml 里应存在「Download all build artifacts」步骤');
  const rest = workflow.slice(start);
  const end = rest.indexOf('\n      - name:', 1);
  const step = end === -1 ? rest : rest.slice(0, end);

  assert.match(
    step,
    /pattern:\s*'?YanMusic-\*'?/,
    '必须在下载步骤里显式给出 `pattern: YanMusic-*` —— 否则 gui-smoke-* 会被一并合并，' +
      '而 merge-multiple 并不筛来源（v2.0.0 的第三次「第 23 个附件」就是这么来的）',
  );
  assert.doesNotMatch(
    step,
    /pattern:.*gui-smoke/,
    '不应靠「排除 gui-smoke」这种逐项黑名单：将来多加一种 artifact 就又漏了，用白名单前缀',
  );
  assert.doesNotMatch(
    step,
    /find release-artifacts -maxdepth/,
    '清单日志不应再带 -maxdepth：上一次事故的文件就藏在第 4 层',
  );
});
