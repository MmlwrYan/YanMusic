#!/usr/bin/env node
/**
 * 发布产物**清单守卫**（v1.4.1，R-2）。
 *
 * ## 它防什么（一次真实事故）
 *
 * v1.4.0 首次发布时，Release 里多出了**第 23 个附件** `first-screen.png`
 * （内容还是第一次冒烟失败的画面）。根因是新加的冒烟脚本把截图写进了**仓库内**的
 * `smoke-artifacts/`，而 `electron-builder` 的输出目录就是仓库里的 `release/`、
 * 产物上传用的是 `release/YanMusic-*` 家族 glob —— 工作区里凭空多出来的东西
 * 正好落进了扫描范围。
 *
 * **发现方式是人工比对产物清单（22 → 23）。当时没有任何自动化守卫拦它。**
 *
 * 那次已按「截图写到仓库之外」修掉了**根因**；本脚本补的是**最后一道网**：
 * 即使将来有别的什么东西掉进 `release/`，发布也会在**建 Release 之前**失败，
 * 而不是把无关文件推到用户面前。
 *
 * ## 判据（为什么是「精确清单」而不是「数量 == 22」）
 *
 * 只查数量是不够的：数量恰好对、但**换了一个文件**的情况同样危险。
 * 因此这里维护一份**精确允许清单**，逐项核对。
 *
 * ⚠️ **这不是「把 22 写死」**：清单里每一行都有明确的来源与理由（见下），
 * 而且**非 `.yml` 的产物必须带正确版本号** —— 版本号是从 `package.json` 读的，
 * 所以发新版时清单**不需要改**（除非产物集合真的变了，那时本来也该停下来看一眼）。
 *
 * 之所以连 `latest*.yml` 也逐个列出：它们是 electron-builder 的**自动更新元数据**，
 * 少一个就意味着某个平台的增量更新会失效 —— 这属于「发布不完整」，
 * 应当拦住而不是放行。（四条分别在 macOS 主线、macOS x64、Linux 主线、
 * Linux arm64 的构建里生成。）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-release-artifacts.mjs [目录]     # 默认 release-artifacts
 * ```
 *
 * 退出码 0 = 清单完全吻合；非 0 = 有缺失或多余，并打印差异。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** electron-builder 生成的自动更新元数据（逐个列出，见文件头注释）。 */
const EXPECTED_METADATA = [
  'latest.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'latest-mac.yml',
];

/**
 * 非元数据产物的匹配规则：`YanMusic-<版本>-<后缀>`。
 *
 * 后缀清单来自 `build.yml` 各腿的 `artifact_glob`。**刻意列全**：
 * 若某腿悄悄改了产物名，这里会红，而不是静默放行。
 */
const EXPECTED_PAYLOAD_SUFFIXES = [
  // macOS
  'mac-arm64.zip',
  'mac-x64.zip',
  'macOS-arm64.dmg',
  'macOS-x64.dmg',
  // Windows
  'Windows-Setup-arm64.exe',
  'Windows-Setup-x64.exe',
  // Linux
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

/** 读版本号：CLI 参数 > 环境变量（CI 的 GITHUB_REF_NAME）> package.json。 */
const resolveVersion = () => {
  const fromArg = process.argv.find((a) => a.startsWith('--version='));
  if (fromArg) return fromArg.slice('--version='.length).replace(/^v/, '');
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME.replace(/^v/, '');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
};

const dir = (() => {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  return path.resolve(ROOT, positional[0] || 'release-artifacts');
})();

const version = resolveVersion();

const fail = (lines) => {
  console.error('❌ 发布产物清单校验未通过');
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  console.error('  ⚠️ 发布产物必须恰好是下列清单。若本次**确实**新增/改名了产物，');
  console.error('     请同步更新 scripts/check-release-artifacts.mjs 的允许清单');
  console.error('     （并说明理由）—— 不要为了让发布通过而放宽判据。');
  process.exit(1);
};

if (!existsSync(dir)) {
  fail([`  产物目录不存在：${dir}`, '  （发布作业应在下载产物之后调用本脚本）']);
}

const actual = readdirSync(dir)
  .filter((name) => statSync(path.join(dir, name)).isFile())
  .sort();

const expectedPayload = EXPECTED_PAYLOAD_SUFFIXES.map((s) => `YanMusic-${version}-${s}`);
const expected = [...expectedPayload, ...EXPECTED_METADATA].sort();

const expectedSet = new Set(expected);
const actualSet = new Set(actual);

const missing = expected.filter((n) => !actualSet.has(n));
const unexpected = actual.filter((n) => !expectedSet.has(n));

if (missing.length || unexpected.length) {
  const lines = [`  期望 ${expected.length} 个，实际 ${actual.length} 个（版本 ${version}）`, ''];
  if (unexpected.length) {
    lines.push(`  ❌ 多出 ${unexpected.length} 个（**不属于发布产物**）：`);
    for (const n of unexpected) lines.push(`       + ${n}`);
    lines.push('');
  }
  if (missing.length) {
    lines.push(`  ❌ 缺少 ${missing.length} 个（发布不完整）：`);
    for (const n of missing) lines.push(`       - ${n}`);
    lines.push('');
  }
  if (!unexpected.length && !missing.length) {
    // 理论上到不了这里；保留以防将来改动破坏上面的逻辑
    lines.push('  （清单比对未发现差异，但数量不符 —— 说明判据本身有 bug）');
  }
  fail(lines);
}

console.log(`✅ 发布产物清单吻合：${actual.length} 个（版本 ${version}）`);
console.log(
  `   ${EXPECTED_PAYLOAD_SUFFIXES.length} 个平台产物 + ${EXPECTED_METADATA.length} 个自动更新元数据`,
);
