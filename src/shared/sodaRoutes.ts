/**
 * Soda 音源路由前缀与判定（v1.5.0）。
 *
 * ## 为什么单独一个纯模块
 *
 * 与 `shared/neteaseRoutes.ts` 同一思路：判定逻辑必须能被 `node --test`
 * **直接驱动**（真跑函数），而不是靠源码正则。
 * 而 `src/main/soda/**` 最终会 import electron，在纯 Node 下无法实例化。
 *
 * ## 这条不变量的重要性
 *
 * 三个音源（酷狗 / 网易云 / Soda）**共用同一个分发器**
 * （`src/main/server.ts` 的 `handleApiRequest`）。
 * 前缀若写坏，最坏形态是一方**吃掉**另一方，而两边都还「能返回点东西」，
 * 排查时极易误判。故用测试钉死（`tests/soda-route-isolation.test.ts`）。
 */

/** 所有 Soda 路由共用的前缀。 */
export const SODA_ROUTE_PREFIX = '/soda/';

/**
 * 判断一个请求 URL 是否属于 Soda 路由。
 *
 * 同样**不做**「以 `/soda` 开头就算」的宽松匹配：`/sodaextra` 必须不命中。
 */
export const isSodaRoute = (url: string): boolean => {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return pathname === '/soda' || pathname.startsWith(SODA_ROUTE_PREFIX);
};

/** 从路由 URL 取出端点名（`/soda/search` → `search`）。 */
export const sodaEndpointOf = (url: string): string => url.split('?')[0].replace(/^\/soda\/?/, '');
