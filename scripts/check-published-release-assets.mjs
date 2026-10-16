#!/usr/bin/env node
/**
 * **发布后**校验：Release 上真实存在的附件必须与允许清单一致（v1.4.2 / R-2 加固）。
 *
 * ## 为什么在「上传前校验」之外还要这一步
 *
 * v1.4.2 自己又踩了一次 v1.4.0 的坑：
 *
 * ```text
 * 发布作业 · Check release artifact manifest  →  ✅ 发布产物清单吻合：22 个
 * 发布作业 · Create Release                   →  ⬆️ Uploading first-screen.png...
 * Release 实际附件                            →  23 个（多出 first-screen.png）
 * ```
 *
 * 也就是说 **「上传前目录快照通过」并不等于「发布结果正确」**。
 * 本次没有查清那个 png 是在哪一瞬间进入上传集合的 ——
 * 与其在没有完整证据的情况下断言机制，不如**把判据放在真正要保证的东西上**：
 * **Release 上最后到底有哪些附件**。
 *
 * 这一步在**发布作业里、Create Release 之后**执行，因此是 CI 强制的（不是靠人记得跑）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-published-release-assets.mjs v1.4.2
 * ```
 *
 * 需要 `gh` 已认证（CI 里由 `GH_TOKEN` 提供）。
 */

import { execFileSync } from 'node:child_process';
import {
  EXPECTED_METADATA,
  EXPECTED_PAYLOAD_SUFFIXES,
  EXPECTED_TOTAL,
  compareAgainstManifest,
} from './release-asset-manifest.mjs';

const tag = (process.argv[2] || process.env.GITHUB_REF_NAME || '').trim();
if (!tag) {
  console.error('用法: node scripts/check-published-release-assets.mjs <tag，例如 v1.4.2>');
  process.exit(1);
}
const version = tag.replace(/^v/, '');

let assetNames;
try {
  const raw = execFileSync('gh', ['release', 'view', tag, '--json', 'assets'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assetNames = JSON.parse(raw).assets.map((a) => a.name);
} catch (error) {
  console.error(
    `❌ 无法读取 Release ${tag} 的附件列表：${String(error.stderr || error.message).slice(0, 400)}`,
  );
  process.exit(1);
}

const result = compareAgainstManifest(assetNames, version);

if (!result.ok) {
  console.error(`❌ 发布后校验未通过：Release ${tag} 的附件与允许清单不一致`);
  console.error('');
  console.error(
    `  期望 ${EXPECTED_TOTAL} 个（${EXPECTED_PAYLOAD_SUFFIXES.length} 平台产物 + ${EXPECTED_METADATA.length} 元数据），实际 ${result.actual.length} 个`,
  );
  console.error('');
  if (result.unexpected.length) {
    console.error(`  ❌ 多出 ${result.unexpected.length} 个（**不属于发布产物**）：`);
    for (const n of result.unexpected) console.error(`       + ${n}`);
    console.error('');
  }
  if (result.missing.length) {
    console.error(`  ❌ 缺少 ${result.missing.length} 个（发布不完整）：`);
    for (const n of result.missing) console.error(`       - ${n}`);
    console.error('');
  }
  console.error('  ⚠️ 处置：删掉多余附件（`gh release delete-asset <tag> <name> --yes`），');
  console.error(
    '     或——若产物集合**确实**变了——同步更新 scripts/release-asset-manifest.mjs 并说明理由。',
  );
  console.error('     不要为了让这一步通过而放宽判据。');
  process.exit(1);
}

console.log(
  `✅ 发布后校验通过：Release ${tag} 的附件恰好 ${result.actual.length} 个，与允许清单逐项一致`,
);
