import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { satisfies as semverSatisfies } from 'semver';

import {
  BARE_SEMVER_PATTERN,
  normalizePluginVersionRange,
  readPluginVersionRequirement,
  shouldEnforcePluginVersionRequirement,
} from '../src/shared/plugin-compatibility.ts';

/**
 * 插件「主程序版本要求」的判定规则（v1.3.3）。
 *
 * 背景：本项目由上游 EchoMusic 二次开发，插件清单里的旧键 `requires.echoMusicVersion`
 * 写的是 **EchoMusic 的 2.x 编号**（`>=2.2.6-beta.9` 之类），与本项目 1.x 编号**不可比**。
 * 修复前该键被直接拿去做 semver 比较 → 恒不满足 → 上游插件被判「版本不兼容」，
 * 而该判定同时是**安装与插件窗口打开的硬门禁**，不只是界面提示。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 本项目当前版本（宿主版本）。 */
const HOST_VERSION = '1.3.2';

/**
 * 实测取自镜像仓库的 14 个插件清单（2026-10-03）。
 *
 * 13 个插件带 `requires`，**全部**用的是旧键 `echoMusicVersion`；
 * 剩下 1 个（mv-enhancer）不设版本要求。逐条列全而不去重，
 * 是为了让「13 个插件全部受影响」这件事在断言里可数。
 */
const REAL_LEGACY_MANIFESTS: { plugin: string; requirement: string }[] = [
  { plugin: 'apple-music-lyrics', requirement: '>=2.2.9-beta.6' },
  { plugin: 'cover-fallback', requirement: '>=2.2.7-beta.9' },
  { plugin: 'echomusic-vinyl-rotation', requirement: '>=2.2.6-beta.9' },
  { plugin: 'example-plugin', requirement: '>=2.2.7-beta.9' },
  { plugin: 'lyric-info-scroll', requirement: '>=2.2.6-beta.9' },
  { plugin: 'openrgb', requirement: '>=2.3.2-beta.4' },
  { plugin: 'page-motion', requirement: '>=2.2.6-beta.19' },
  { plugin: 'playback-control-order', requirement: '>=2.3.2-beta.4' },
  { plugin: 'scroll-assistant', requirement: '>=2.2.6-beta.20' },
  { plugin: 'spectrum-visualizer', requirement: '>=2.3.2-beta.7' },
  { plugin: 'vertical-lyric-scroll', requirement: '>=2.2.7-beta.9' },
  { plugin: 'water-lyrics', requirement: '>=2.2.9-beta.6' },
  { plugin: 'webdav-backup', requirement: '>=2.3.1-beta.20' },
];

// ── 1. 读取规则 ────────────────────────────────────────────────────────

test('readPluginVersionRequirement：只有上游旧键时来源记为 echomusic', () => {
  const requirement = readPluginVersionRequirement({ echoMusicVersion: '>=2.2.9-beta.6' });
  assert.equal(requirement?.source, 'echomusic');
  assert.equal(requirement?.value, '>=2.2.9-beta.6');
});

test('readPluginVersionRequirement：只有自有键时来源记为 yanmusic', () => {
  const requirement = readPluginVersionRequirement({ yanmusicVersion: '>=1.3.0' });
  assert.equal(requirement?.source, 'yanmusic');
  assert.equal(requirement?.value, '>=1.3.0');
});

test('readPluginVersionRequirement：两键并存时自有键优先，旧键不参与', () => {
  const requirement = readPluginVersionRequirement({
    yanmusicVersion: '>=1.3.0',
    echoMusicVersion: '>=2.2.6-beta.9',
  });
  assert.equal(requirement?.source, 'yanmusic');
  assert.equal(requirement?.value, '>=1.3.0');
});

test('readPluginVersionRequirement：自有键为空/空白时回退旧键', () => {
  for (const blank of ['', '   ', '\t']) {
    const requirement = readPluginVersionRequirement({
      yanmusicVersion: blank,
      echoMusicVersion: '>=2.2.6-beta.9',
    });
    assert.equal(requirement?.source, 'echomusic', `yanmusicVersion=${JSON.stringify(blank)}`);
  }
});

test('readPluginVersionRequirement：无要求时返回 null（不设门槛）', () => {
  assert.equal(readPluginVersionRequirement(undefined), null);
  assert.equal(readPluginVersionRequirement(null), null);
  assert.equal(readPluginVersionRequirement('>=1.0.0'), null, 'requires 非对象');
  assert.equal(readPluginVersionRequirement({}), null);
  assert.equal(readPluginVersionRequirement({ echoMusicVersion: '' }), null);
  assert.equal(readPluginVersionRequirement({ echoMusicVersion: '  ' }), null);
});

// ── 2. 判定规则（本次修复的核心） ───────────────────────────────────────

test('shouldEnforcePluginVersionRequirement：旧键恒不参与比较', () => {
  // 这就是修复点本身。怎样改会变红：把实现改成 `() => true`
  // （即退回「无脑比较」的老行为）→ 本用例与下一组回归用例同时变红。
  assert.equal(shouldEnforcePluginVersionRequirement('echomusic'), false);
});

test('shouldEnforcePluginVersionRequirement：自有键照常参与比较', () => {
  assert.equal(shouldEnforcePluginVersionRequirement('yanmusic'), true);
});

test('自有键未被一起放过：高版本要求仍判不满足', () => {
  const requirement = readPluginVersionRequirement({ yanmusicVersion: '>=9.9.9' });
  assert.equal(requirement?.source, 'yanmusic');
  assert.equal(shouldEnforcePluginVersionRequirement(requirement!.source), true);

  const { range, error } = normalizePluginVersionRange(requirement!.value);
  assert.equal(error, '');
  assert.equal(
    semverSatisfies(HOST_VERSION, range, { includePrerelease: true }),
    false,
    '自有键写的高版本仍应判为不满足 —— 别再改坏了',
  );
});

// ── 3. 真实清单回归（缺陷实证 + 修复效果） ──────────────────────────────

test('实证：旧键的值拿本项目版本比，13 个插件全部不满足（这就是被拦的原因）', () => {
  assert.equal(REAL_LEGACY_MANIFESTS.length, 13, '样本应为 13 个插件');

  for (const { plugin, requirement } of REAL_LEGACY_MANIFESTS) {
    const { range, error } = normalizePluginVersionRange(requirement);
    assert.equal(error, '', `${plugin} 的 ${requirement} 应能规范化为合法范围`);
    assert.equal(
      semverSatisfies(HOST_VERSION, range, { includePrerelease: true }),
      false,
      `${plugin}：${HOST_VERSION} 不满足 ${range}`,
    );
  }
});

test('回归：13 个真实插件改按来源判定后全部放行', () => {
  const blocked = REAL_LEGACY_MANIFESTS.filter(({ requirement }) => {
    const parsed = readPluginVersionRequirement({ echoMusicVersion: requirement });
    assert.equal(parsed?.source, 'echomusic', `${requirement} 应识别为旧键`);
    return shouldEnforcePluginVersionRequirement(parsed!.source);
  });

  assert.deepEqual(blocked, [], '不应再有任何插件因旧键被拦下');
});

// ── 4. 范围规范化 ──────────────────────────────────────────────────────

test('normalizePluginVersionRange：裸版本号按 >= 处理', () => {
  assert.deepEqual(normalizePluginVersionRange('1.3.3'), { range: '>=1.3.3', error: '' });
  assert.deepEqual(normalizePluginVersionRange('v1.3.3'), { range: '>=1.3.3', error: '' });
  assert.deepEqual(normalizePluginVersionRange('1.3'), { range: '>=1.3.0', error: '' });
  assert.deepEqual(normalizePluginVersionRange('  1.3.3  '), { range: '>=1.3.3', error: '' });
});

test('normalizePluginVersionRange：范围表达式原样交给 semver', () => {
  assert.equal(normalizePluginVersionRange('>=2.2.6-beta.9').error, '');
  assert.equal(normalizePluginVersionRange('>=2.2.6-beta.9').range, '>=2.2.6-beta.9');
  assert.equal(normalizePluginVersionRange('^1.2.0 || >=1.3.0').error, '');
});

test('normalizePluginVersionRange：空值与非法值', () => {
  assert.deepEqual(normalizePluginVersionRange(''), { range: '', error: '' });
  assert.deepEqual(normalizePluginVersionRange(undefined), { range: '', error: '' });
  assert.ok(normalizePluginVersionRange('不是版本号').error, '非法值应报错');
  assert.ok(normalizePluginVersionRange('>=').error, '残缺范围应报错');
});

test('BARE_SEMVER_PATTERN：只认裸版本号，不认带运算符的范围', () => {
  assert.equal(BARE_SEMVER_PATTERN.test('1.3.3'), true);
  assert.equal(BARE_SEMVER_PATTERN.test('v2.2.6-beta.9'), true);
  assert.equal(BARE_SEMVER_PATTERN.test('>=1.3.3'), false);
  assert.equal(BARE_SEMVER_PATTERN.test('^1.2.0'), false);
});

// ── 5. 生效点守卫（descriptor.ts 依赖 electron，跑不了真行为） ──────────

/**
 * 怎样改会变红：把 `getyanmusicCompatibility` 里的
 * `shouldEnforcePluginVersionRequirement(requirement.source)` 判断删掉，
 * 退回「拿到要求就硬比」→ 本用例变红（前面的行为用例测不到这一步，
 * 因为 descriptor.ts 顶部 `import { app } from 'electron'`，在 node 下加载不了）。
 *
 * ⚠️ 断言必须限定在**函数体内**：该标识符在本文件的
 * `validateyanmusicVersionRequirement`（格式校验）里也会出现，
 * 只断言「字符串存在」的话，把 `getyanmusicCompatibility` 里的判断短掉它**仍然是绿的**
 * —— 这一条是实测踩出来的（第一版守卫就是这么写的，变异验证没红）。
 */
test('生效点：getyanmusicCompatibility 内确实按来源分派', () => {
  const source = read('src/main/plugins/descriptor.ts');

  const start = source.indexOf('export const getyanmusicCompatibility');
  assert.ok(start >= 0, '未找到 getyanmusicCompatibility');
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, '未定位到 getyanmusicCompatibility 函数体结尾');
  const body = source.slice(start, end);

  assert.ok(
    body.includes('shouldEnforcePluginVersionRequirement(requirement.source)'),
    '版本判定必须按来源分派，不能对所有键无脑比较',
  );
  assert.ok(
    body.includes('readPluginVersionRequirement(manifest.requires)'),
    '应使用 shared 模块读取版本要求',
  );
  assert.ok(
    !source.includes('normalizeyanmusicVersionRequirement'),
    '旧的内联实现应已删除（逻辑已收进 shared/plugin-compatibility）',
  );
});
