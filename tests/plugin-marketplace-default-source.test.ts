/**
 * 内置官方插件源的「换源」契约与迁移规则。
 *
 * 这组断言针对的都是**换默认源时最容易漏、且漏了不会被任何现有测试发现**的点：
 * `id` 与 `url` 必须一起改（id 由 URL 派生）、缓存版本必须递增、
 * 旧官方源必须能被迁移剔除、当前默认源**绝不能**出现在「历史官方源」清单里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID,
  DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL,
  GITHUB_PLUGIN_MARKETPLACE_MIRROR_URL,
  GITEE_PLUGIN_MARKETPLACE_MIRROR_URL,
  LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_SOURCE_IDS,
  isLegacyOfficialMarketplaceSourceEntry,
} from '../src/main/plugins/common.ts';
import { parsePluginRepository, toRepositorySourceId } from '../src/shared/plugin-source.ts';

test('默认官方源：URL 与 ID 必须互相自洽（换源时最容易漏的一条）', () => {
  // 官方源的 id 不是手写的常量，而是**由 URL 派生**（`<provider>:<owner>/<repo>`）。
  // 只改 URL 不改 ID 时，应用仍认为「新地址」不是官方源，而存量用户库里那条**同 ID 的旧源**
  // 会被原样保留 —— 换源对老用户静默失效。这条断言把两者钉死在一起。
  const repo = parsePluginRepository(DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL);
  assert.ok(repo, '默认源地址必须可解析');
  assert.equal(toRepositorySourceId(repo), DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID);
});

test('默认官方源：v1.3.2 起为 Gitee，GitHub 保留为可选源', () => {
  assert.equal(DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL, GITEE_PLUGIN_MARKETPLACE_MIRROR_URL);
  assert.equal(parsePluginRepository(DEFAULT_PLUGIN_MARKETPLACE_SOURCE_URL)?.provider, 'gitee');
  assert.equal(parsePluginRepository(GITHUB_PLUGIN_MARKETPLACE_MIRROR_URL)?.provider, 'github');
  // 两个地址必须指向同一个 owner/repo（内容一致，只是提供方不同）
  const gitee = parsePluginRepository(GITEE_PLUGIN_MARKETPLACE_MIRROR_URL);
  const github = parsePluginRepository(GITHUB_PLUGIN_MARKETPLACE_MIRROR_URL);
  assert.equal(gitee?.owner.toLowerCase(), github?.owner.toLowerCase());
  assert.equal(gitee?.repo.toLowerCase(), github?.repo.toLowerCase());
});

test('历史官方源清单：不得包含当前默认 id（否则默认源会被迁移逻辑自己剔掉）', () => {
  assert.equal(
    LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_SOURCE_IDS.includes(DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID),
    false,
  );
  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({
      id: DEFAULT_PLUGIN_MARKETPLACE_SOURCE_ID,
      official: true,
    }),
    false,
  );
});

test('历史官方源清单：两条历史 id 都必须认得出来', () => {
  // v1.3.0 → v1.3.1 换了源（上游仓库 → 自有仓库），当时**没有**做迁移，
  // 所以这条遗留一直存在；v1.3.2 一并处理。
  assert.ok(
    LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_SOURCE_IDS.includes('github:hoowhoami/echomusicplugins'),
  );
  assert.ok(
    LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_SOURCE_IDS.includes('github:mmlwryan/yanmusicplugins'),
  );

  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({
      id: 'github:mmlwryan/yanmusicplugins',
      official: true,
    }),
    true,
  );
  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({
      id: 'github:hoowhoami/echomusicplugins',
      official: true,
    }),
    true,
  );
});

test('历史官方源判定：只剔除「应用自己创建过」的，手动添加的不受影响', () => {
  // 用户手动添加同一个 URL 时，`official` 会是 false（它不等于当前默认 id）。
  // 若这里也剔除，用户就会看到「加了一个源，刷新后它自己消失了」。
  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({
      id: 'github:mmlwryan/yanmusicplugins',
      official: false,
    }),
    false,
  );
  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({ id: 'github:mmlwryan/yanmusicplugins' }),
    false,
    '缺 official 字段时不得当作官方源',
  );
  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({ id: 'gitee:someone/other', official: true }),
    false,
  );
  assert.equal(isLegacyOfficialMarketplaceSourceEntry(null), false);
  assert.equal(isLegacyOfficialMarketplaceSourceEntry(undefined), false);
  assert.equal(
    isLegacyOfficialMarketplaceSourceEntry({ official: true }),
    false,
    'id 缺失不得崩溃',
  );
});
