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
 * ## v2.0.0：同一个症状的**第三次**出现，这次查到了真根因
 *
 * 现象还是「Release 里多出第 23 个附件 `first-screen.png`」，而**上传前的两道
 * 校验都是绿的**。真根因不在冒烟脚本，而在**下载 artifact 的那一步**：
 *
 * - `actions/download-artifact` 在**不给 `pattern`** 时，会把本次运行的
 *   **全部** artifact 合并下来 —— 包括 `gui-smoke-*`（冒烟截图）。
 *   （v1.4.1 的注释曾断言「`merge-multiple` 只合并**非** `gui-smoke-*` 的
 *   artifact」，那是**错的**：`merge-multiple` 只决定「是否合并到同一目录」，
 *   并不筛选来源。）
 * - 那个 artifact 的内部结构是 `tmp/yanmusic-smoke-artifacts/first-screen.png`，
 *   合并后位于第 4 层；而本脚本当时 `readdirSync` **只看顶层**、CI 里的
 *   `find` 又带了 `-maxdepth 2` —— 两边都看不见它。
 * - 最后 `softprops/action-gh-release` 的 `release-artifacts/**` glob **是递归的**，
 *   于是它被上传，且以 basename 出现在附件列表里。
 *
 * 三处都已修：下载步骤加 `pattern: 'YanMusic-*'`、`find` 去掉 `-maxdepth`、
 * 本脚本改为**递归**枚举。教训写在这里：**带深度限制的判据 = 可以被绕过的判据。**
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_METADATA,
  EXPECTED_PAYLOAD_SUFFIXES,
  EXPECTED_TOTAL,
  compareAgainstManifest,
} from './release-asset-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 允许清单**不在这里**定义 —— 它与「发布后校验」共用
// `scripts/release-asset-manifest.mjs` 这一份唯一定义（见该文件头注释：
// v1.4.2 的教训是「上传前目录快照通过 ≠ 发布结果正确」，
// 两道校验必须比对**同一份清单**，否则会各自漂移）。

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
  console.error('     请同步更新 scripts/release-asset-manifest.mjs 的允许清单');
  console.error('     （并说明理由）—— 不要为了让发布通过而放宽判据。');
  process.exit(1);
};

if (!existsSync(dir)) {
  fail([`  产物目录不存在：${dir}`, '  （发布作业应在下载产物之后调用本脚本）']);
}

/**
 * 递归列出目录下**所有**文件的相对路径（用 `/` 分隔）。
 *
 * ⚠️ 这里**必须递归** —— v2.0.0 的第三次发布事故就是这么漏掉的：
 *
 * `actions/download-artifact` 在没有 `pattern` 时会把**本次运行的全部 artifact**
 * 合并下来，其中包含 `gui-smoke-*`（冒烟截图）。那个 artifact 的内部结构是
 * `tmp/yanmusic-smoke-artifacts/first-screen.png`，合并后落在
 * `release-artifacts/tmp/yanmusic-smoke-artifacts/first-screen.png`（第 4 层）。
 *
 * 而本脚本当时用的是 `readdirSync(dir)` **只看顶层**，CI 里的
 * `find release-artifacts -maxdepth 2` 同样看不到它 —— 于是两道「上传前」校验
 * 都是绿的，Release 里却又一次多出第 23 个附件。
 * **深度限制 = 可以被绕过的判据**，所以这里不再有深度限制。
 */
const walkFiles = (root, base = '') => {
  const out = [];
  for (const entry of readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
};

const actual = walkFiles(dir).sort();

// 与「发布后校验」共用同一份清单定义（避免两边各自维护而漂移）
const result = compareAgainstManifest(actual, version);

if (!result.ok) {
  const lines = [
    `  期望 ${EXPECTED_TOTAL} 个，实际 ${result.actual.length} 个（版本 ${version}）`,
    '',
  ];
  if (result.unexpected.length) {
    lines.push(`  ❌ 多出 ${result.unexpected.length} 个（**不属于发布产物**）：`);
    for (const n of result.unexpected) lines.push(`       + ${n}`);
    lines.push('');
  }
  if (result.missing.length) {
    lines.push(`  ❌ 缺少 ${result.missing.length} 个（发布不完整）：`);
    for (const n of result.missing) lines.push(`       - ${n}`);
    lines.push('');
  }
  fail(lines);
}

console.log(`✅ 发布产物清单吻合：${result.actual.length} 个（版本 ${version}）`);
console.log(
  `   ${EXPECTED_PAYLOAD_SUFFIXES.length} 个平台产物 + ${EXPECTED_METADATA.length} 个自动更新元数据`,
);
