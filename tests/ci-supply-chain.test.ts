import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * CI 供应链守卫（IMP-17）。
 *
 * 复现（修复前）：`.github/workflows/build.yml` 共 12 处 `uses:` 全部为可移动引用
 * （`@v4` / `@v2` / `@stable` 分支），上游移动 tag/分支即可在无感知的情况下替换
 * 构建期执行的代码 —— 这是 GitHub Actions 供应链攻击的常见入口。
 * 现已全部固定为 40 位 commit SHA 并保留 `# vX.Y.Z` 注释（便于人工核对与
 * Dependabot 后续按 SHA 升级）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

const workflowFiles = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
const sources = new Map(
  workflowFiles.map((name) => [name, readFileSync(path.join(workflowsDir, name), 'utf8')]),
);

interface UseRef {
  file: string;
  line: number;
  ref: string;
}

const collectUses = (): UseRef[] => {
  const refs: UseRef[] = [];
  for (const [file, text] of sources) {
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
      if (match) refs.push({ file, line: index + 1, ref: match[1] });
    });
  }
  return refs;
};

test('所有 uses: 必须固定到 40 位 commit SHA（不得使用可移动的 tag / 分支）', () => {
  const uses = collectUses();
  assert.ok(uses.length >= 10, `解析到的 uses 过少（${uses.length}），守卫可能失效`);
  const mutable = uses
    .filter((item) => !/@[0-9a-f]{40}$/.test(item.ref))
    .map((item) => `${item.file}:${item.line}  ${item.ref}`);
  assert.deepEqual(mutable, [], '存在未固定 SHA 的 Action 引用；上游移动 tag 即可替换构建期代码');
});

test('固定 SHA 的同时保留可读的版本注释', () => {
  const complaints: string[] = [];
  for (const item of collectUses()) {
    if (!/@[0-9a-f]{40}$/.test(item.ref)) continue;
    const line = sources.get(item.file)!.split(/\r?\n/)[item.line - 1];
    // 注释可以是 `# v4`（tag）也可以是 `# stable`（分支引用，如 dtolnay/rust-toolchain），
    // 因此只要求「# 后有非空内容」，不强制版本号形态。
    if (!/#\s*\S+/.test(line)) {
      complaints.push(`${item.file}:${item.line}  ${item.ref}（缺少 # <版本/分支> 注释）`);
    }
  }
  assert.deepEqual(complaints, [], '固定 SHA 后应保留版本注释，否则无法人工判断版本');
});

test('本地复合 Action（./path）不需要 SHA 固定', () => {
  const local = collectUses().filter((item) => item.ref.startsWith('./'));
  for (const item of local) {
    assert.ok(item.ref.startsWith('./'), '本地 action 引用应以 ./ 开头');
  }
});
