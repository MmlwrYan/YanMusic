import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, sliceDeclaration as sliceDeclarationRaw } from './helpers/sourceText.ts';

/**
 * 「有条目因来源仓库不可达被跳过」这条信息**必须贯通到界面**（v1.3.6）。
 *
 * ## 背景（维护者实测反馈）
 *
 * 官方插件源的索引里有 39 条，其中 **15 条托管在第三方 GitHub 仓库**
 *（来源仓库没有许可证，本插件源按法律风险**刻意不镜像**，只保留索引指向）。
 * 国内网络拉不动 GitHub，于是这 15 条的 `manifest` 逐条失败、被丢弃 ——
 * **界面只显示 24 条，却没有任何解释**（v1.3.5 及之前的表现）。
 * 用户无法区分「插件源坏了 / 插件被下架 / 网络问题」。
 *
 * ## 为什么这条链路需要守卫
 *
 * 主进程**本来就算出了这个数字**（`normalizeMarketplaceIndexPlugins` 的 `failedCount`），
 * 但它一路被丢弃：
 *   ① `getMarketplaceCache` 是**重建**对象，没显式带出的字段会被静默丢掉；
 *   ② 缓存回放路径（默认路径，不联网）只读缓存，字段不落盘就永远看不到；
 *   ③ 渲染层从未读取过它。
 * 这类「算出来了但没接通」的缺陷**不会报错、不会有测试变红**，只会让功能静默失效 ——
 * 与 v1.3.4 的 `failedCount` 完全同型。故用本文件把**每一环**钉住。
 *
 * ⚠️ 鉴别力验证（本文件必须能红；均已实测）：
 *  ① 从 `getMarketplaceCache` 的返回值里删掉 `skippedEntryCount` → 「缓存重建」用例变红；
 *  ② 把它写成 `?? 0` → 「不得抹平 undefined」用例变红；
 *  ③ 从 `listPluginMarketplace` 的任一 return 里删掉 → 「出口」用例变红；
 *  ④ 从 `usePluginMarketplace.ts` 删掉 `marketplaceSkippedNotice` → 渲染层用例变红；
 *  ⑤ 从 `PluginManagement.vue` 删掉模板引用 → 界面用例变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 剥离器与切片器统一取自 `tests/helpers/sourceText.ts` —— **必须**用它：
// `src/main/plugins.ts` 里的 Accept 头 `'application/json,text/plain,*/*'` 同时含
// `/*` 与 `*/`，朴素的块注释正则会从那里一路吃到 360 行之后，把本文件要检查的三个
// 函数整段删掉，导致守卫误报「未找到声明」（v1.3.6 实测踩到）。
const readStripped = (relativePath: string) =>
  stripComments(readFileSync(path.join(repoRoot, relativePath), 'utf8'));

const sliceDeclaration = (source: string, marker: string) =>
  sliceDeclarationRaw(source, marker, assert.ok);

const sharedPlugins = readStripped('src/shared/plugins.ts');
const mainPlugins = readStripped('src/main/plugins.ts');
const rendererMarketplace = readStripped('src/renderer/views/plugins/usePluginMarketplace.ts');
const pluginManagement = readStripped('src/renderer/views/PluginManagement.vue');
const pluginManagementCss = readStripped('src/renderer/views/plugins/pluginManagement.css');

test('v1.3.6：共享类型必须声明 skippedEntryCount（两个分支都要有）', () => {
  const resultType = sliceDeclaration(sharedPlugins, 'export type PluginMarketplaceListResult');
  const hits = resultType.match(/skippedEntryCount\?/g) ?? [];
  assert.equal(
    hits.length,
    2,
    `PluginMarketplaceListResult 的 ok:true / ok:false 两个分支都应带 skippedEntryCount，` +
      `实际匹配到 ${hits.length} 处 —— 少一个分支就会在该分支下丢字段`,
  );
  assert.match(
    sharedPlugins,
    /export type PluginMarketplaceSkippedEntryCount\s*=\s*number\s*\|\s*undefined/,
    '必须显式声明「undefined = 未知」的类型，否则实现者会顺手用 ?? 0 抹平它',
  );
});

test('v1.3.6：getMarketplaceCache 是重建对象，必须显式带出 skippedEntryCount', () => {
  // 这是本文件**最核心**的一条：不显式带出就会被静默丢弃，
  // 而默认的缓存回放路径恰恰只读这里 —— 字段一丢，界面永远拿不到这个数字。
  const body = sliceDeclaration(mainPlugins, 'const getMarketplaceCache = ');
  // ⚠️ 必须**行首锚定**：本函数里还有一个三元表达式 `... ? cache.skippedEntryCount : undefined`，
  //    宽松的 `skippedEntryCount\s*:` 会被那个冒号满足，从而对「键被改名/删掉」毫无鉴别力
  //    （初版即如此，由鉴别力验证抓出 —— 注入后测试仍然全绿）。
  assert.match(
    body,
    /^\s*skippedEntryCount\s*:/m,
    'getMarketplaceCache 的返回值里缺少 skippedEntryCount 键 —— 该函数重建对象，' +
      '未列出的字段会被静默丢弃（v1.3.4 的 failedCount 即如此失效）',
  );
  assert.match(
    body,
    /typeof\s+cache\.skippedEntryCount\s*===\s*'number'/,
    '必须以 typeof 判定后再带出，才能保留 undefined =「未知」语义',
  );
});

test('v1.3.6：不得把「未知」抹平成 0（undefined 与 0 语义不同）', () => {
  const body = sliceDeclaration(mainPlugins, 'const getMarketplaceCache = ');
  assert.doesNotMatch(
    body,
    /skippedEntryCount[\s\S]{0,80}?\?\?\s*0/,
    '不得写成 `?? 0`：旧缓存里没有该字段，其语义是「未知」而非「没有条目被跳过」。' +
      '抹平会让界面在数据缺失时谎称一切正常',
  );
});

test('v1.3.6：主进程必须把 failedCount 落盘到缓存并回传', () => {
  const fetchCatalog = sliceDeclaration(mainPlugins, 'const fetchMarketplaceSourceCatalog = ');
  assert.match(
    fetchCatalog,
    /skippedEntryCount:\s*result\.failedCount/,
    'fetchMarketplaceSourceCatalog 应把逐条拉取失败的 failedCount 作为 skippedEntryCount 上报',
  );

  const refreshCatalog = sliceDeclaration(mainPlugins, 'const refreshMarketplaceCatalog = ');
  assert.match(
    refreshCatalog,
    /skippedEntryCount\s*\+=\s*item\.skippedEntryCount/,
    'refreshMarketplaceCatalog 必须汇总各源的 skippedEntryCount',
  );
  assert.match(
    refreshCatalog,
    /skippedEntryCount,?\s*\n\s*\};/,
    '汇总结果必须写进落盘的 cache 对象（否则冷启动后无法解释）',
  );
});

test('v1.3.6：listPluginMarketplace 的两个 return 都必须回传该计数', () => {
  const body = sliceDeclaration(mainPlugins, 'export const listPluginMarketplace = ');
  const hits = body.match(/skippedEntryCount:\s*cache\.skippedEntryCount/g) ?? [];
  assert.equal(
    hits.length,
    2,
    `listPluginMarketplace 的 ok:true / ok:false 两个 return 都应回传 ` +
      `skippedEntryCount（实际 ${hits.length} 处）—— 少一处则失败分支下界面拿不到解释`,
  );
});

test('v1.3.6：渲染层必须读取该字段，并在「未知」时保持静默', () => {
  assert.match(
    rendererMarketplace,
    /marketplaceSkippedEntryCount\.value\s*=\s*result\?\.skippedEntryCount/,
    '渲染层未从 IPC 结果读取 skippedEntryCount —— 主进程算得再对也白搭',
  );
  const notice = sliceDeclaration(rendererMarketplace, 'const marketplaceSkippedNotice = computed');
  assert.match(
    notice,
    /typeof\s+skipped\s*!==\s*'number'\s*\|\|\s*skipped\s*<=\s*0/,
    'marketplaceSkippedNotice 必须同时挡掉「未知」（undefined）与「0」，' + '否则旧缓存下会误报',
  );
  assert.match(
    rendererMarketplace,
    /\n\s*marketplaceSkippedNotice,/,
    '该 computed 必须从 composable 导出，否则视图无法渲染',
  );
});

test('v1.3.6：插件管理页必须常驻渲染这条说明（不能只弹一次 toast）', () => {
  assert.match(
    pluginManagement,
    /marketplaceSkippedNotice/,
    'PluginManagement.vue 未使用 marketplaceSkippedNotice',
  );
  assert.match(
    pluginManagement,
    /v-if="marketplaceSkippedNotice"[\s\S]{0,120}?marketplace-skipped-notice/,
    '说明必须由 v-if 常驻渲染，并带上 marketplace-skipped-notice 类名（toast 会消失，' +
      '而「条数比预期少」是持续状态，用户下次进入本页仍需看到解释）',
  );
  assert.match(
    pluginManagementCss,
    /\.marketplace-skipped-notice\s*\{/,
    'pluginManagement.css 缺少 .marketplace-skipped-notice 样式（会渲染成无样式的裸文本）',
  );
});
