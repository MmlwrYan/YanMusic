import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 与守卫脚本里的允许清单保持一致（此处刻意**独立重写**一遍）。 */
const PAYLOAD_SUFFIXES = [
  'mac-arm64.zip',
  'mac-x64.zip',
  'macOS-arm64.dmg',
  'macOS-x64.dmg',
  'Windows-Setup-arm64.exe',
  'Windows-Setup-x64.exe',
  'linux-aarch64.pacman',
  'linux-aarch64.pkg.tar.zst',
  'linux-aarch64.rpm',
  'linux-amd64.deb',
  'linux-arm64.AppImage',
  'linux-arm64.deb',
  'linux-arm64.tar.gz',
  'linux-x64.pacman',
  'linux-x64.pkg.tar.zst',
  'linux-x64.tar.gz',
  'linux-x86_64.AppImage',
  'linux-x86_64.rpm',
];
const METADATA = ['latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-mac.yml'];

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
