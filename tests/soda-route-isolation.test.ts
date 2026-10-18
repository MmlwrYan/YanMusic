import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SODA_ROUTE_PREFIX, sodaEndpointOf } from '../src/shared/musicSourceRoutes.ts';
import { isNeteaseRoute, isSodaRoute } from '../src/shared/musicSourceRoutes.ts';

/**
 * v1.5.0 · Soda 路由与另两个音源的**隔离守卫**。
 *
 * ## 为什么必须有
 *
 * 酷狗（无前缀）、网易云（`/netease/`）、Soda（`/soda/`）**共用同一个分发器**
 * —— `src/main/server.ts` 的 `handleApiRequest`。
 * 前缀判定写坏的最坏形态是**一方吃掉另一方**：
 * 三边都还「能返回点东西」，排查时极易误判成「音源挂了」。
 *
 * 所以这里不只测 Soda 自己，还**交叉验证三者互不命中**。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

/* ------------------------------------------------------------------ *
 * 第一段：前缀判定的真实行为
 * ------------------------------------------------------------------ */

test('v1.5.0-S15：Soda 前缀必须命中，且不误伤酷狗/网易云的路由', () => {
  for (const hit of [
    '/soda',
    '/soda/',
    '/soda/status',
    '/soda/search',
    '/soda/play-url',
    '/soda/search?keywords=x',
  ]) {
    assert.equal(isSodaRoute(hit), true, `应命中 Soda 路由：${hit}`);
  }

  for (const miss of [
    '/search',
    '/song/url',
    '/lyric',
    // ⚠️ 最容易写错的边界：不能因为「以 soda 开头」就命中
    '/sodaextra',
    '/Soda/search',
    '/api/soda/search',
  ]) {
    assert.equal(isSodaRoute(miss), false, `不应命中 Soda 路由：${miss}`);
  }
});

test('v1.5.0-S16：三音源前缀必须**互不重叠**（交叉验证）', () => {
  // Soda 不命中网易云与酷狗
  assert.equal(isNeteaseRoute('/soda/search'), false, 'Soda 路径不得被网易云吃掉');
  // 网易云不命中 Soda
  assert.equal(isSodaRoute('/netease/song/url'), false, '网易云路径不得被 Soda 吃掉');
  // 酷狗的典型无前缀路由，两边都不得命中
  for (const kugou of ['/search', '/song/url', '/lyric', '/song/climax']) {
    assert.equal(isSodaRoute(kugou), false, `酷狗路由 ${kugou} 不得被 Soda 命中`);
    assert.equal(isNeteaseRoute(kugou), false, `酷狗路由 ${kugou} 不得被网易云命中`);
  }
});

test('v1.5.0-S17：前缀必须以 `/` 分隔，避免与相似前缀互相劫持', () => {
  assert.equal(SODA_ROUTE_PREFIX, '/soda/');
  // 反例自证：若前缀退化为 '/soda'（无尾斜杠）且漏掉等号判断，
  // '/sodaextra' 就会被 startsWith 命中 —— 这正是本用例要防的退化。
  assert.equal(isSodaRoute('/sodaextra'), false);
});

test('v1.5.0-S18：端点提取必须剥掉前缀、保留子路径、丢掉 query', () => {
  assert.equal(sodaEndpointOf('/soda/status'), 'status');
  assert.equal(sodaEndpointOf('/soda/play-url'), 'play-url');
  assert.equal(sodaEndpointOf('/soda/search?keywords=a&b=1'), 'search');
  assert.equal(sodaEndpointOf('/soda'), '');
  assert.equal(sodaEndpointOf('/soda/'), '');
});

/* ------------------------------------------------------------------ *
 * 第二段：分流顺序（只存在于代码结构里）
 * ------------------------------------------------------------------ */

const serverSource = readSource('src/main/server.ts');

test('v1.5.0-S19：Soda 分流必须**早于**酷狗路由匹配与服务就绪门禁', () => {
  const sodaIndex = serverSource.indexOf('isSodaRoute(request.url)');
  const kugouMatch = serverSource.indexOf('matchModule(request.url)');
  const readyGuard = serverSource.indexOf('if (!serverReady || !createRequestFn)');

  assert.notEqual(sodaIndex, -1, 'server.ts 必须调用 isSodaRoute 分流');
  assert.notEqual(kugouMatch, -1, '仍必须调用 matchModule 处理酷狗路由');
  assert.notEqual(readyGuard, -1, '仍必须保留 serverReady 门禁（酷狗需要）');

  assert.ok(
    sodaIndex < kugouMatch,
    'Soda 分流必须在 matchModule 之前 —— 否则 `/soda/xxx` 会先被当成酷狗路由查表，' +
      '返回 404 而不是 Soda 的结果',
  );
  assert.ok(
    sodaIndex < readyGuard,
    'Soda 分流必须在 serverReady 门禁之前 —— 三音源必须能**独立降级**，' +
      '酷狗子模块未就绪不应导致 Soda 也不可用',
  );
});

test('v1.5.0-S20：Soda 模块不得在顶层 import 中加载原生模块（否则主进程启动即崩）', () => {
  const sodaSource = readSource('src/main/soda/index.ts');
  // 关键约束：bdms.node 的 require 必须在 init() 内部懒执行。
  // 若有人把它挪到模块顶层，路径未配置时主进程会在启动阶段直接崩。
  assert.equal(/^import\s+bdms/m.test(sodaSource), false, '不得顶层 import 原生模块');
  assert.match(
    sodaSource,
    /new SodaProvider\(/,
    '应在 ensureProvider 内部**懒创建** SodaProvider（首次请求时才加载原生模块）',
  );
});
