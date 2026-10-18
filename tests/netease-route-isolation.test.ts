import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NETEASE_ROUTE_PREFIX,
  isNeteaseRoute,
  neteaseEndpointOf,
} from '../src/shared/musicSourceRoutes.ts';

/**
 * v2.0.0 · 网易云路由与酷狗路由的**隔离守卫**（对应 plan 的 V-2）。
 *
 * ## 为什么这条必须守
 *
 * 网易云与酷狗**共用同一个分发器**：`src/main/server.ts` 的 `handleApiRequest`。
 * 网易云以 `/netease/*` 前缀**先分流**，未命中才走酷狗的 `matchModule`。
 *
 * 若前缀判定写坏，最坏形态是**一方吃掉另一方的路由**：
 * 酷狗的 `/search`、`/song/url`、`/lyric` 都是无前缀路径，
 * 一旦判定退化成「包含 netease 就算」或「前缀写成 `/`」，
 * 整个搜索/取链会失效 —— 而两条链路都还「能返回点东西」，极难排查。
 *
 * ## 为什么是「单元测试 + 源码结构断言」两段
 *
 * - `isNeteaseRoute` 是纯函数，放在 `src/shared/musicSourceRoutes.ts`，
 *   可以直接 import 并**真跑**（比源码正则可靠）；
 * - 但「分流必须在 `matchModule` 之前」这条**顺序**关系只存在于
 *   `server.ts` 的代码结构里，无法靠跑函数证明，故补一段静态断言。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

/* ------------------------------------------------------------------ *
 * 第一段：前缀判定的真实行为
 * ------------------------------------------------------------------ */

test('v2.0.0 ①：网易云前缀必须命中，且不误伤酷狗的常见无前缀路由', () => {
  // 必须命中的形态
  for (const hit of [
    '/netease',
    '/netease/',
    '/netease/ping',
    '/netease/search',
    '/netease/song/url',
    '/netease/check/music',
    '/netease/search?keywords=x&limit=30',
  ]) {
    assert.equal(isNeteaseRoute(hit), true, `应命中网易云路由：${hit}`);
  }

  // 必须**不**命中的形态 —— 这些是酷狗真实在用的路由
  for (const miss of [
    '/search',
    '/song/url',
    '/lyric',
    '/search/lyric',
    '/song/climax',
    '/',
    '',
    // ⚠️ 最容易写错的边界：不能因为「以 netease 开头」就命中
    '/neteasefoo',
    '/netEase/search',
    '/api/netease/search',
  ]) {
    assert.equal(isNeteaseRoute(miss), false, `不应命中网易云路由：${miss}`);
  }
});

test('v2.0.0 ②：前缀必须以 `/` 分隔，避免与相似前缀互相劫持', () => {
  assert.equal(NETEASE_ROUTE_PREFIX, '/netease/');
  // 反例自证：若前缀被改成 '/netease'（无尾斜杠）而不加等号判断，
  // '/neteasefoo' 就会被 `startsWith` 命中 —— 这正是本用例要防的退化。
  assert.equal(isNeteaseRoute('/neteasefoo'), false);
});

test('v2.0.0 ③：端点提取必须剥掉前缀且保留子路径', () => {
  assert.equal(neteaseEndpointOf('/netease/ping'), 'ping');
  assert.equal(neteaseEndpointOf('/netease/song/url'), 'song/url');
  assert.equal(neteaseEndpointOf('/netease/check/music'), 'check/music');
  // query 必须被丢掉，否则 switch 永远不匹配
  assert.equal(neteaseEndpointOf('/netease/search?keywords=a&limit=30'), 'search');
  // 裸前缀 → 空端点（分发层会走 default 分支返回 404）
  assert.equal(neteaseEndpointOf('/netease'), '');
  assert.equal(neteaseEndpointOf('/netease/'), '');
});

/* ------------------------------------------------------------------ *
 * 第二段：分流顺序（只存在于代码结构里，跑函数证明不了）
 * ------------------------------------------------------------------ */

const serverSource = readSource('src/main/server.ts');

test('v2.0.0 ④：网易云分流必须**早于**酷狗路由匹配（matchModule）', () => {
  const neteaseIndex = serverSource.indexOf('isNeteaseRoute(request.url)');
  const kugouMatch = serverSource.indexOf('matchModule(request.url)');

  assert.notEqual(neteaseIndex, -1, 'server.ts 必须调用 isNeteaseRoute 做分流');
  assert.notEqual(kugouMatch, -1, 'server.ts 必须仍然调用 matchModule 处理酷狗路由');
  assert.ok(
    neteaseIndex < kugouMatch,
    '网易云分流必须排在 matchModule 之前 —— 否则 `/netease/xxx` 会先被当成酷狗路由查表，' +
      '返回 404「Not Found」而不是网易云的结果',
  );
});

test('v2.0.0 ⑤：网易云分流不得被 `serverReady` 门禁挡住', () => {
  // 网易云不依赖酷狗模块表，因此它的分支必须在 `if (!serverReady ...)` 之前。
  // 否则「酷狗子模块缺失/未就绪」会连带让网易云完全不可用 —— 两条音源必须能独立降级。
  const guardIndex = serverSource.indexOf('if (!serverReady || !createRequestFn)');
  const neteaseIndex = serverSource.indexOf('isNeteaseRoute(request.url)');

  assert.notEqual(guardIndex, -1, 'server.ts 里应保留 serverReady 门禁（酷狗路径需要）');
  assert.ok(
    neteaseIndex < guardIndex,
    '网易云分流必须早于 serverReady 门禁 —— 两条音源必须能独立降级，' +
      '酷狗未就绪不应导致网易云也不可用',
  );
});
