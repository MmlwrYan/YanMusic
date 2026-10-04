/**
 * 插件展示文案的品牌替换。
 *
 * 上游插件的清单里，`description` 等**面向用户**的字段写着 `EchoMusic`
 * （本项目基于它二次开发）。本组断言锁定三件事：
 * ① 展示文案里的 `EchoMusic` 单词被换掉；② **标识符不算单词**（仓库名不能被改）；
 * ③ 只处理展示文案，其余字段（repo / author / 出处）必须原样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PLUGIN_BRANDING_NAME, replaceEchoMusicBranding } from '../src/shared/plugin-branding.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

// ── 1. 基本替换 ────────────────────────────────────────────────────────────

test('replaceEchoMusicBranding：把展示文案里的 EchoMusic 换成 YanMusic', () => {
  // 真实取值（取自镜像仓库 apple-music-lyrics/manifest.json）。
  assert.equal(
    replaceEchoMusicBranding('使用 @applemusic-like-lyrics/core 渲染 EchoMusic 页面歌词。'),
    '使用 @applemusic-like-lyrics/core 渲染 YanMusic 页面歌词。',
  );
  assert.equal(replaceEchoMusicBranding('EchoMusic 插件开发示例'), 'YanMusic 插件开发示例');
  assert.equal(
    replaceEchoMusicBranding('将 EchoMusic 的应用设置、插件及插件数据备份到自己的 WebDAV 存储。'),
    '将 YanMusic 的应用设置、插件及插件数据备份到自己的 WebDAV 存储。',
  );
  // 一句话里出现多次也要全换。
  assert.equal(
    replaceEchoMusicBranding('EchoMusic 的插件，用于给 EchoMusic 加速。'),
    'YanMusic 的插件，用于给 YanMusic 加速。',
  );
});

test('replaceEchoMusicBranding：大小写收敛（全大写保持全大写）', () => {
  assert.equal(replaceEchoMusicBranding('echomusic'), PLUGIN_BRANDING_NAME);
  assert.equal(replaceEchoMusicBranding('ECHOMUSIC'), 'YANMUSIC');
  assert.equal(replaceEchoMusicBranding('EchoMusic'), 'YanMusic');
});

test('replaceEchoMusicBranding：不做子串替换 —— 标识符不能被改', () => {
  // `EchoMusicPlugins` 是**别人的仓库名**，改成 `YanMusicPlugins` 就成了另一个仓库。
  assert.equal(
    replaceEchoMusicBranding('https://github.com/hoowhoami/EchoMusicPlugins'),
    'https://github.com/hoowhoami/EchoMusicPlugins',
  );
  assert.equal(
    replaceEchoMusicBranding('EchoMusic-org/Lyrics-bridge'),
    'EchoMusic-org/Lyrics-bridge',
  );
  assert.equal(replaceEchoMusicBranding('echoMusicVersion'), 'echoMusicVersion');
  assert.equal(replaceEchoMusicBranding('EchoMusic_Plugin'), 'EchoMusic_Plugin');
  // 前后紧邻字母/数字/连字符/下划线一律不换；紧邻空格/标点才换。
  assert.equal(replaceEchoMusicBranding('（EchoMusic）'), `（${PLUGIN_BRANDING_NAME}）`);
  assert.equal(replaceEchoMusicBranding('EchoMusic。'), `${PLUGIN_BRANDING_NAME}。`);
});

test('replaceEchoMusicBranding：原样返回与空值', () => {
  assert.equal(replaceEchoMusicBranding('一个普通的插件说明'), '一个普通的插件说明');
  assert.equal(replaceEchoMusicBranding(''), '');
  assert.equal(replaceEchoMusicBranding(undefined), '');
  assert.equal(replaceEchoMusicBranding(null), '');
});

// ── 2. 生效点守卫（主进程侧依赖 electron，跑不了真行为） ────────────────────

/**
 * 怎样改会变红：把 `normalizeMarketplaceIndexPlugin` 里的
 * `replaceEchoMusicBranding(manifest.description)` 还原成 `String(manifest.description || '')`
 * → 本用例变红。
 */
test('生效点：市场插件的 description 确实过了品牌替换', () => {
  const source = read('src/main/plugins.ts');
  const start = source.indexOf('const normalizeMarketplaceIndexPlugin = ');
  assert.ok(start >= 0, '未找到 normalizeMarketplaceIndexPlugin');
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, '未定位到函数体结尾');
  const body = source.slice(start, end);

  assert.ok(
    body.includes('replaceEchoMusicBranding(manifest.description)'),
    '市场插件简介必须做品牌替换',
  );
  // 同一函数里 author / repo / homepage 必须**原样**透传，不能被顺手也改了。
  assert.ok(body.includes("String(manifest.author || '')"), 'author 是署名，不得改写');
});

test('生效点：已安装插件描述符的 description 也过了品牌替换', () => {
  const source = read('src/main/plugins/descriptor.ts');
  const start = source.indexOf('export const toDescriptor = ');
  assert.ok(start >= 0, '未找到 toDescriptor');
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, '未定位到函数体结尾');
  const body = source.slice(start, end);

  assert.ok(
    body.includes('replaceEchoMusicBranding(manifest.description)'),
    '已安装插件卡片的简介必须做品牌替换',
  );
  assert.ok(body.includes("String(manifest.author || '')"), 'author 不得改写');
});

test('生效点：插件窗口 ctx.manifest.description 同样替换，其余字段原样透传', () => {
  const source = read('src/plugin-window/main.ts');
  const start = source.indexOf('const buildContext = ');
  assert.ok(start >= 0, '未找到 buildContext');
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, '未定位到 buildContext 结尾');
  const body = source.slice(start, end);

  assert.ok(
    body.includes('...descriptor.manifest') &&
      body.includes('replaceEchoMusicBranding(descriptor.manifest.description)'),
    '插件窗口拿到的 manifest 应整体透传 + 仅替换 description',
  );
});

test('不得滥改：author 字段与法律文案里的 EchoMusic 保持原样', () => {
  const pluginsSource = read('src/main/plugins.ts');
  const descriptorSource = read('src/main/plugins/descriptor.ts');
  // 两个生效点都不得对 author 做替换。
  for (const [name, source] of [
    ['plugins.ts', pluginsSource],
    ['descriptor.ts', descriptorSource],
  ] as const) {
    assert.ok(
      !source.includes('replaceEchoMusicBranding(manifest.author'),
      `${name}：author 是署名，绝不能被品牌替换`,
    );
  }
  // 许可与致谢文案是**如实**的版权声明，必须保留 EchoMusic。
  const legal = read('src/renderer/constants/legal.ts');
  assert.ok(legal.includes('EchoMusic'), '许可文案中的上游署名必须保留');
});
