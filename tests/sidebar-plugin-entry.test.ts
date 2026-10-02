import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.3.0 可发现性守卫：**侧边栏必须有固定的「插件」入口**。
 *
 * ## 背景（维护者实测反馈）
 *
 * 原先「插件」**只以插件动态贡献的侧边栏分区形式出现**
 *（`pluginSidebarSections`，默认 `sectionOrder` 300，且**必须有已安装插件才会出现**）。
 * 结果是：新用户装了应用、用了一段时间，**完全没发现插件系统的存在**。
 *
 * v1.3.0 在侧边栏加了一个固定入口，位置紧随「听歌档案」（order 45 → 46）。
 * 本文件锁定它，防止后续重构把这一格又拿掉 —— 它没有其他任何测试会覆盖，
 * 而失去它不会报错、只会让插件系统重新变得不可发现（静默的功能倒退）。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  从 `navSections` 删掉 `id: 'plugins'` 那一项 → 用例 1、2 变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidebarRaw = readFileSync(path.join(repoRoot, 'src/renderer/layouts/Sidebar.vue'), 'utf8');

/**
 * 剥离注释后再解析。
 *
 * ⚠️ 必须剥离：新增的「插件」项在 `{` 之后带有多行说明注释，
 * 而项解析正则有 `\{\s*id:` 这样的「花括号后只能跟空白」假设 ——
 * 不剥注释就会漏掉带注释的项（本文件初版即因此误报「缺少插件入口」，由鉴别力验证抓出）。
 * 本批已多次踩在「注释干扰源码守卫」上，统一改用本手法。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '/* stripped */').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const sidebar = stripComments(sidebarRaw);

/** 取 `navSections` 里的内置项（含 id/title/path/order）。 */
const builtinEntries = (): Array<{ id: string; title: string; path: string; order: number }> => {
  const entries: Array<{ id: string; title: string; path: string; order: number }> = [];
  // 逐项匹配 `{ ... id: 'x', ... path: '...', ... order: N, ... }` 形态（字段顺序稳定）
  for (const m of sidebar.matchAll(
    /\{\s*id:\s*'([^']+)',\s*key:\s*'[^']+',\s*title:\s*'([^']+)',\s*path:\s*'([^']+)'[\s\S]{0,200}?order:\s*(\d+)/g,
  )) {
    entries.push({ id: m[1], title: m[2], path: m[3], order: Number(m[4]) });
  }
  return entries;
};

test('v1.3.0：侧边栏必须有固定的「插件」入口，指向插件管理页', () => {
  const entries = builtinEntries();
  assert.ok(entries.length >= 5, `解析到的内置导航项过少（${entries.length}）—— 守卫可能失效`);

  const pluginEntry = entries.find((item) => item.id === 'plugins');
  assert.ok(
    pluginEntry,
    '侧边栏缺少固定的「插件」入口 —— 「插件」将退回「仅由插件动态贡献」的状态，' +
      '而未安装插件的用户将完全看不到插件系统的存在（v1.3.0 已修的可发现性问题）',
  );
  assert.equal(pluginEntry.title, '插件', '该入口标题应为「插件」');
  assert.match(
    pluginEntry.path,
    /^\/main\/settings\/plugins$/,
    '该入口应指向既有的插件管理/市场页（复用页面，不重复实现）',
  );
});

test('v1.3.0：「插件」入口必须紧随「听歌档案」之后（维护者指定的位置）', () => {
  const entries = builtinEntries();
  const journal = entries.find((item) => item.id === 'journal');
  const plugins = entries.find((item) => item.id === 'plugins');

  assert.ok(journal, '未找到「听歌档案」入口');
  assert.ok(plugins, '未找到「插件」入口');
  assert.equal(journal.title, '听歌档案');
  assert.ok(
    plugins.order > journal.order,
    `「插件」order=${plugins.order} 应大于「听歌档案」order=${journal.order}（否则会排到它前面）`,
  );
  assert.ok(
    plugins.order - journal.order <= 5,
    `「插件」与「听歌档案」的 order 相差 ${plugins.order - journal.order}，` +
      '过大则不会相邻显示 —— 维护者要求的是「放在听歌档案下面便于访问」',
  );
  // 两者之间不应再插入其它内置项，否则「紧随其后」名不副实
  const between = entries.filter(
    (item) => item.order > journal.order && item.order < plugins.order,
  );
  assert.deepEqual(
    between.map((item) => item.id),
    [],
    '「听歌档案」与「插件」之间不应插入其它内置导航项',
  );
});

test('v1.3.0：插件入口使用的图标必须在内置图标表内（避免渲染成空白）', () => {
  // iconMap 是 `builtinIcon` 的取值来源（BuiltinSidebarIcon = keyof typeof iconMap），
  // 若新增图标名但没加进 iconMap，类型检查会拦；此处再从运行时角度锁一次映射存在。
  assert.match(sidebar, /\bplugin:\s*iconPlugin\b/, 'iconMap 中缺少 plugin → iconPlugin 的映射');
  assert.match(
    sidebar,
    /import\s*\{[\s\S]*?\biconPlugin\b[\s\S]*?\}\s*from\s*'@\/icons'/,
    'Sidebar 必须从 @/icons 导入 iconPlugin',
  );
});
