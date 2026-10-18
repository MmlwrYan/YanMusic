import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JOOX_ROUTE_PREFIX,
  KUWO_ROUTE_PREFIX,
  NETEASE_ROUTE_PREFIX,
  ROUTED_SOURCES,
  SODA_ROUTE_PREFIX,
  endpointOf,
  isJooxRoute,
  isKuwoRoute,
  isNeteaseRoute,
  isRouteOf,
  isSodaRoute,
  neteaseEndpointOf,
  sodaEndpointOf,
} from '../src/shared/musicSourceRoutes.ts';

/**
 * v2.0.0 · 五音源路由隔离守卫。
 *
 * ## 为什么这条必须守
 *
 * 五个音源（酷狗 + 四个第三方）**共用同一个分发器**：
 * `src/main/server.ts` 的 `handleApiRequest`。第三方向以各自前缀先分流，
 * 未命中才走酷狗的 `matchModule`。
 *
 * 若某个前缀判定写坏，最坏形态是**一个音源吃掉另一个**：
 * 比如 `/kuwo/` 的判定退化成「以 `/k` 开头就算」，或者两个前缀写成同一个。
 * 症状是某个音源「突然搜不到东西」，而两条链路都还「能返回点东西」，
 * 排查时极易误判成上游挂了。
 *
 * ## 为什么既有单源测试、又要这份
 *
 * `tests/netease-route-isolation.test.ts` 与 `tests/soda-route-isolation.test.ts`
 * 分别守自己的前缀；本文件守的是**它们之间的关系**——
 * 前缀互不重叠、互不吞并、端点剥离互不串味。这类问题单看一个源是发现不了的。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

/* ------------------------------------------------------------------ *
 * 第一段：前缀判定
 * ------------------------------------------------------------------ */

test('v2.0.0 ①：每个音源的前缀都命中自己，且不误伤酷狗的无前缀路由', () => {
  const cases: { prefix: string; hits: string[] }[] = [
    { prefix: NETEASE_ROUTE_PREFIX, hits: ['/netease', '/netease/ping', '/netease/song/url'] },
    { prefix: SODA_ROUTE_PREFIX, hits: ['/soda', '/soda/status', '/soda/play-url'] },
    { prefix: KUWO_ROUTE_PREFIX, hits: ['/kuwo', '/kuwo/ping', '/kuwo/play-url'] },
    { prefix: JOOX_ROUTE_PREFIX, hits: ['/joox', '/joox/ping', '/joox/search'] },
  ];

  for (const { prefix, hits } of cases) {
    for (const url of hits) {
      assert.equal(isRouteOf(url, prefix), true, `${prefix} 应命中 ${url}`);
    }
  }

  // 酷狗真实在用的无前缀路由 —— 任何一个被吃掉，整个搜索/取链就废了
  const kugouRoutes = ['/search', '/song/url', '/lyric', '/song/climax', '/privilege/lite'];
  for (const url of kugouRoutes) {
    for (const { prefix } of cases) {
      assert.equal(isRouteOf(url, prefix), false, `${prefix} 不应命中酷狗路由 ${url}`);
    }
  }
});

test('v2.0.0 ②：前缀不做宽松匹配 —— `/neteasefoo` 这类必须不命中', () => {
  const evil = [
    ['/neteasefoo', NETEASE_ROUTE_PREFIX],
    ['/sodaextra', SODA_ROUTE_PREFIX],
    ['/kuwoo', KUWO_ROUTE_PREFIX],
    ['/jooxx', JOOX_ROUTE_PREFIX],
  ] as const;

  for (const [url, prefix] of evil) {
    assert.equal(isRouteOf(url, prefix), false, `${prefix} 不应宽松命中 ${url}`);
  }

  // 对照：路径穿越形态（`/kuwo/../netease/search`）**按前缀规则确实会命中**。
  // 这不是漏洞 —— 真正的防护在于「该源的路由表里没有这个端点」，
  // 会落到 404；把路径规范化塞进前缀判定反而会引入新的不一致。
  // 这里显式记录该行为，避免将来有人把它当成 bug「修」掉。
  assert.equal(isRouteOf('/kuwo/../netease/search', KUWO_ROUTE_PREFIX), true);
});

test('v2.0.0 ③：五个前缀两两不相等、互不包含', () => {
  const prefixes = ROUTED_SOURCES.map((s) => s.prefix);
  const unique = new Set(prefixes);
  assert.equal(unique.size, prefixes.length, '存在重复的路由前缀');

  // 任意两个前缀之间不能互为前缀（否则短的那个会吃掉长的）
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a === b) continue;
      assert.equal(a.startsWith(b), false, `${a} 不应以 ${b} 开头`);
    }
  }
});

test('v2.0.0 ④：端点剥离不串味（`/kuwo/search` 不会剥成 `/search`）', () => {
  assert.equal(endpointOf('/kuwo/search', KUWO_ROUTE_PREFIX), 'search');
  assert.equal(endpointOf('/joox/play-url', JOOX_ROUTE_PREFIX), 'play-url');
  assert.equal(endpointOf('/netease/song/url', NETEASE_ROUTE_PREFIX), 'song/url');
  assert.equal(endpointOf('/soda/status', SODA_ROUTE_PREFIX), 'status');
  // 裸前缀 → 空端点（调用方落到 404，而不是拿整个路径当端点）
  assert.equal(endpointOf('/kuwo', KUWO_ROUTE_PREFIX), '');
  assert.equal(endpointOf('/kuwo?x=1', KUWO_ROUTE_PREFIX), '');
  // 不属于该前缀 → 空端点，绝不把别的音源的路径当自己的
  assert.equal(endpointOf('/netease/search', KUWO_ROUTE_PREFIX), '');
});

/* ------------------------------------------------------------------ *
 * 第二段：兼容层（旧导出必须仍然指向同一实现）
 * ------------------------------------------------------------------ */

test('v2.0.0 ⑤：具名判定（旧 API）与通用实现行为一致', () => {
  const samples = ['/netease/search', '/neteasefoo', '/soda/status', '/sodaextra', '/search', ''];
  for (const url of samples) {
    assert.equal(isNeteaseRoute(url), isRouteOf(url, NETEASE_ROUTE_PREFIX), `netease: ${url}`);
    assert.equal(isSodaRoute(url), isRouteOf(url, SODA_ROUTE_PREFIX), `soda: ${url}`);
    assert.equal(isKuwoRoute(url), isRouteOf(url, KUWO_ROUTE_PREFIX), `kuwo: ${url}`);
    assert.equal(isJooxRoute(url), isRouteOf(url, JOOX_ROUTE_PREFIX), `joox: ${url}`);
  }
  assert.equal(neteaseEndpointOf('/netease/song/url'), 'song/url');
  assert.equal(sodaEndpointOf('/soda/search'), 'search');
});

test('v2.0.0 ⑤b：旧的两个路由模块已删除 —— 判定只剩一份实现', () => {
  // v2.0.0 之前 `shared/neteaseRoutes.ts` 与 `shared/sodaRoutes.ts` 各有一份
  // 相同逻辑。收敛后必须**真的删掉**，否则下次有人从旧文件 import 就复活了重复。
  for (const legacy of ['src/shared/neteaseRoutes.ts', 'src/shared/sodaRoutes.ts']) {
    assert.equal(
      existsSync(path.join(repoRoot, legacy)),
      false,
      `${legacy} 应已删除（判定统一在 shared/musicSourceRoutes.ts）`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 第三段：分发顺序（静态结构断言）
 * ------------------------------------------------------------------ */

test('v2.0.0 ⑥：`server.ts` 必须在 matchModule 之前分流出四个第三方音源', () => {
  const source = readSource('src/main/server.ts');
  const body = source.slice(source.indexOf('export const handleApiRequest'));

  const matchIndex = body.indexOf('matchModule(');
  assert.ok(matchIndex > 0, 'server.ts 里应有 matchModule 调用');

  for (const marker of [
    'handleNeteaseRequest',
    'handleSodaRequest',
    'handleKuwoRequest',
    'handleJooxRequest',
  ]) {
    const index = body.indexOf(marker);
    assert.ok(index > 0, `server.ts 未分流出 ${marker}`);
    assert.ok(
      index < matchIndex,
      `${marker} 的调用必须早于 matchModule —— 否则酷狗路由会先匹配、第三方源永远轮不到`,
    );
  }
});
