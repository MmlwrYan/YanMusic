import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 全渲染层「未定义 CSS 令牌」守卫。
 *
 * 背景（1.2.1 审计新发现）：`MusicJournal.vue` 曾在浅色主题下不可读，根因是引用了全仓
 * 从未定义的 `--text-primary` / `--accent`，`var()` 回退到为深色背景写死的近白色。
 * 逐点修好之后做全仓扫描，发现**同类问题共 18 处引用 / 5 个令牌 / 7 个文件**：
 *   - `--border-main`（3 处，**无回退**）→ 整条 `border: ... var(--border-main)` 声明失效，复选框边框消失
 *   - `--color-red-500`（3 处，**无回退**）→ 声明失效，颜色不生效
 *   - `--primary`（2 处，**无回退**）→ 声明失效
 *   - `--color-danger`（9 处，有回退 `#ef4444`）→ 恒定硬编码红，脱离主题令牌
 *   - `--color-error`（1 处，有回退）→ 同上
 *
 * 本守卫把「引用即必须可解析」固化为断言，避免同类问题再次混入。
 * 三类合法例外（缺一不可，否则会误报）：
 *   1. **运行时注入**：由 TS/模板通过 `setProperty('--x')` 或 `:style="{ '--x': ... }"` 设置；
 *   2. **库约定**：`--reka-*` / `--un-*` / `--radix-*` 等由第三方组件运行时提供；
 *   3. **设计性覆盖点**：`style.css` 中 `--accent-gradient-*` 这类「外部可选覆盖 + 自带回退」的钩子。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = path.join(repoRoot, 'src', 'renderer');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(vue|css|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const files = walk(rendererRoot);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const corpus = [...sources.values()].join('\n');

/** CSS 中 `--x:` 出现即视为已定义。 */
const definedTokens = new Set([...corpus.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

/** 运行时注入：setProperty / 对象键 / 内联 style 字符串。 */
const runtimeInjected = new Set<string>();
for (const pattern of [
  /setProperty\(\s*['"`](--[a-z0-9-]+)['"`]/gi,
  /['"`](--[a-z0-9-]+)['"`]\s*:/gi,
  /style="[^"]*?(--[a-z0-9-]+)\s*:/gi,
]) {
  for (const match of corpus.matchAll(pattern)) runtimeInjected.add(match[1]);
}

/** 设计性覆盖点：`style.css` 中自带回退、供外部（布局/插件）可选覆盖的钩子。 */
const INTENTIONAL_OVERRIDE_HOOKS = new Set([
  '--accent-gradient-height',
  '--accent-gradient-opacity',
  '--accent-gradient-angle',
  '--accent-gradient-color-rgb',
  '--accent-gradient-mid-position',
  '--accent-gradient-peak-opacity',
  '--accent-gradient-mid-opacity',
  '--accent-gradient-peak-opacity-dark',
  '--accent-gradient-mid-opacity-dark',
]);

const LIBRARY_PREFIXES = ['--reka-', '--un-', '--radix-', '--v-', '--tw-'];

const isResolvable = (token: string): boolean =>
  definedTokens.has(token) ||
  runtimeInjected.has(token) ||
  INTENTIONAL_OVERRIDE_HOOKS.has(token) ||
  LIBRARY_PREFIXES.some((prefix) => token.startsWith(prefix));

interface UnresolvedRef {
  token: string;
  file: string;
  line: number;
  hasFallback: boolean;
}

const collectUnresolved = (): UnresolvedRef[] => {
  const found: UnresolvedRef[] = [];
  for (const [file, text] of sources) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,[^)]*)?\)/gi)) {
        const token = match[1];
        if (isResolvable(token)) continue;
        found.push({
          token,
          file: relative,
          line: index + 1,
          hasFallback: Boolean(match[2] && match[2].trim() !== ','),
        });
      }
    });
  }
  return found;
};

test('渲染层不得引用未定义的 CSS 令牌（allowlist 之外）', () => {
  const unresolved = collectUnresolved();
  const summary = [...new Set(unresolved.map((item) => item.token))]
    .sort()
    .map(
      (token) =>
        `${token} ×${unresolved.filter((item) => item.token === token).length}` +
        `（示例 ${unresolved.find((item) => item.token === token)!.file}:${
          unresolved.find((item) => item.token === token)!.line
        }）`,
    );
  assert.deepEqual(
    summary,
    [],
    '存在引用未定义 CSS 令牌的声明；var() 会回退到硬编码值或整条声明失效',
  );
});

test('其中「无回退」的引用必须为零（无回退时整条声明直接失效）', () => {
  const noFallback = collectUnresolved().filter((item) => !item.hasFallback);
  assert.deepEqual(
    noFallback.map((item) => `${item.token}  ${item.file}:${item.line}`),
    [],
    '无回退的未定义令牌会让整条 CSS 声明失效（例如边框/颜色完全不生效）',
  );
});

test('危险色统一走 --state-danger（不要在视图里自造 --color-danger / --color-error / --color-red-500）', () => {
  const offenders: string[] = [];
  for (const [file, text] of sources) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    text.split(/\r?\n/).forEach((line, index) => {
      if (/--color-danger\b|--color-error\b|--color-red-500\b/.test(line)) {
        offenders.push(`${relative}:${index + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], '危险色应使用 --state-danger（style.css 中已定义）');
});

test('主题令牌体系自检：--state-danger 与 --control-border 必须存在（本守卫依赖它们）', () => {
  for (const token of ['--state-danger', '--control-border', '--text-main', '--border-subtle']) {
    assert.ok(definedTokens.has(token), `style.css 缺少 ${token}`);
  }
});
