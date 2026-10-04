/**
 * 插件展示文案的品牌替换。
 *
 * 上游插件的清单里，`description` 与 `author` 等**面向用户**的字段写着 `EchoMusic`
 * （本项目基于它二次开发）。本组断言锁定四件事：
 * ① 展示文案里的 `EchoMusic` 单词被换掉；② **标识符不算单词**（仓库名不能被改）；
 * ③ `author` 也要换 —— 实测 10/14 个条目的 author 就是 `EchoMusic`（上游项目名
 *    被填进了作者位），而 `吴彦祖` / `Codex Sol` / `小栀` 等真人昵称天然不受影响；
 * ④ 替换必须做在**输出边界**（缓存回放也过）—— 只做在 index 归一化处对存量缓存无效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PLUGIN_BRANDING_NAME, replaceEchoMusicBranding } from '../src/shared/plugin-branding.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 截出某个具名函数的函数体（`export const fn = ` / `const fn = ` → 其后第一个 `\n};`）。 */
const functionBody = (source: string, decl: string) => {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `未找到 ${decl}`);
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, `未定位到 ${decl} 的函数体结尾`);
  return source.slice(start, end);
};

/**
 * 数一段代码里某个**精确片段**出现的次数。
 *
 * ⚠️ 为什么不用 `body.includes(...)`：同一函数内可能**多处**写同名标识符
 * （例：`toDescriptor` 的顶层 `author` 与 `manifest.author` 各一处）。
 * 只改其中一处时 `includes` 仍是 `true` —— 守卫会**假绿**。
 * v1.3.4 的变异测试实测踩到过这个盲区，故此处按「精确片段出现次数」断言。
 */
const countOf = (text: string, needle: string) => text.split(needle).length - 1;

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

test('replaceEchoMusicBranding：真人作者昵称不被波及（实测样本）', () => {
  // 取自真实清单：这 3 个 author 是真人 / 昵称，不含品牌词，必须原样。
  for (const name of ['吴彦祖', 'Codex Sol', '小栀']) {
    assert.equal(replaceEchoMusicBranding(name), name);
  }
  // 而 `EchoMusic` 这个 author（上游项目名占位）要被换掉。
  assert.equal(replaceEchoMusicBranding('EchoMusic'), 'YanMusic');
});

// ── 2. 生效点守卫（主进程侧依赖 electron，跑不了真行为） ────────────────────

/**
 * 怎样改会变红：把 `normalizeMarketplaceIndexPlugin` 里对 description / author 的
 * 替换还原成 `String(manifest.x || '')` → 本用例变红。
 */
test('生效点：市场索引归一化替换 description 与 author', () => {
  const body = functionBody(
    read('src/main/plugins.ts'),
    'const normalizeMarketplaceIndexPlugin = ',
  );

  assert.ok(
    countOf(body, 'description: replaceEchoMusicBranding(manifest.description)') >= 1,
    '市场插件简介必须做品牌替换',
  );
  assert.ok(
    countOf(body, 'author: replaceEchoMusicBranding(manifest.author)') >= 1,
    '市场插件 author 也必须做品牌替换（实测 10/14 条目取值就是 EchoMusic）',
  );
});

/**
 * ⚠️ 这条是 v1.3.4 漏掉的根因守卫。
 * **怎样改会变红**：把 `hydrateMarketplacePlugins` 返回处的
 * `replaceEchoMusicBranding(plugin.description)` / `(plugin.author)` 去掉
 * → 本用例变红。而「只在 normalizeMarketplaceIndexPlugin 里替换」**不会**让它变红 ——
 * 那正是 v1.3.4 的缺陷形态：存量缓存回放绕过了归一化，界面上仍显示 EchoMusic。
 */
test('生效点：市场列表输出边界（缓存回放）也做替换', () => {
  const body = functionBody(read('src/main/plugins.ts'), 'const hydrateMarketplacePlugins = ');

  assert.ok(
    countOf(body, 'description: replaceEchoMusicBranding(plugin.description)') === 1,
    '输出边界必须替换 description —— 否则缓存回放路径会漏（存量用户看不到修复）',
  );
  assert.ok(
    countOf(body, 'author: replaceEchoMusicBranding(plugin.author)') === 1,
    '输出边界必须替换 author —— 否则缓存回放路径会漏',
  );
  assert.ok(
    countOf(body, 'description: replaceEchoMusicBranding(plugin.manifest?.description)') === 1,
    '输出边界的 manifest.description 也要替换',
  );
  assert.ok(
    countOf(body, 'author: replaceEchoMusicBranding(plugin.manifest?.author)') === 1,
    '输出边界的 manifest.author 也要替换',
  );
});

test('生效点：已安装插件描述符替换 description 与 author', () => {
  const body = functionBody(read('src/main/plugins/descriptor.ts'), 'export const toDescriptor = ');

  // ⚠️ 这里必须用精确片段 + 次数，不能只 `includes` —— 见 `countOf` 注释。
  assert.ok(
    countOf(body, 'description: replaceEchoMusicBranding(manifest.description)') === 2,
    '顶层 description 与 manifest.description 两处都要替换',
  );
  assert.ok(
    countOf(body, 'author: replaceEchoMusicBranding(manifest.author)') === 2,
    '顶层 author 与 manifest.author 两处都要替换（卡片直接渲染 manifest.author）',
  );
  // 不得残留未经替换的原样写法。
  assert.equal(
    countOf(body, "author: String(manifest.author || '')"),
    0,
    '不得残留原样透传的 author',
  );
  assert.equal(
    countOf(body, "description: String(manifest.description || '')"),
    0,
    '不得残留原样透传的 description',
  );
});

test('生效点：插件窗口 ctx.manifest 也替换 description 与 author', () => {
  const body = functionBody(read('src/plugin-window/main.ts'), 'const buildContext = ');

  assert.ok(body.includes('...descriptor.manifest'), '插件窗口的 manifest 应整体透传');
  assert.ok(
    countOf(body, 'description: replaceEchoMusicBranding(descriptor.manifest.description)') === 1,
    '插件窗口的 description 要替换',
  );
  assert.ok(
    countOf(body, 'author: replaceEchoMusicBranding(descriptor.manifest.author)') === 1,
    '插件窗口的 author 要替换',
  );
});

// ── 3. 不得越界的字段 ──────────────────────────────────────────────────────

test('不得滥改：标识类字段与法律文案里的 EchoMusic 保持原样', () => {
  const pluginsSource = read('src/main/plugins.ts');
  const descriptorSource = read('src/main/plugins/descriptor.ts');

  // repo / homepage / downloadUrl / checksum 一律不得做品牌替换（那是真实地址与校验值）。
  for (const [name, source] of [
    ['plugins.ts', pluginsSource],
    ['descriptor.ts', descriptorSource],
  ] as const) {
    for (const field of ['repo', 'homepage', 'downloadUrl', 'checksum', 'sourceUrl']) {
      assert.ok(
        !source.includes(`replaceEchoMusicBranding(${field}`) &&
          !source.includes(`replaceEchoMusicBranding(manifest.${field}`) &&
          !source.includes(`replaceEchoMusicBranding(plugin.${field}`),
        `${name}：${field} 是标识/校验类字段，不得被品牌替换`,
      );
    }
  }

  // 许可与致谢文案是**如实**的版权声明，必须保留 EchoMusic。
  const legal = read('src/renderer/constants/legal.ts');
  assert.ok(legal.includes('EchoMusic'), '许可文案中的上游署名必须保留');
});
