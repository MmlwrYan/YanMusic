/**
 * 多音源路由前缀与判定的**唯一实现**（v2.0.0）。
 *
 * ## 为什么把四份判定收成一份
 *
 * v1.5.0 时只有 `neteaseRoutes.ts` 与 `sodaRoutes.ts`，两份各写一遍
 * 「`/xxx` 或 `/xxx/...`」的判定，还能忍。到 v2.0.0 又要加酷我与 JOOX，
 * 就是四份同样的逻辑 —— 而它们共用**同一个分发器**
 * （`src/main/server.ts` 的 `handleApiRequest`）。
 *
 * 四份里改错一份的后果不是「那个音源失败」，而是**一个音源吃掉另一个**：
 * 匹配写宽的会把别人的端点劫持走，而两边都还「能返回点东西」，
 * 排查时极难看出来。故收敛成一份实现，由测试统一钉死
 * （`tests/music-source-routes.test.ts`）。
 *
 * ## 判定为什么不做前缀宽松匹配
 *
 * `/neteasefoo` **不能**命中 `/netease/`。否则将来酷狗侧新增任何以
 * `netease` 开头的路径都会被静默劫持 —— 这类 bug 的症状是「搜索没了」，
 * 而日志里一切正常。
 */

/** 网易云。 */
export const NETEASE_ROUTE_PREFIX = '/netease/';
/** 汽水（Soda）。 */
export const SODA_ROUTE_PREFIX = '/soda/';
/** 酷我（经 JJ Music 使用的聚合接口）。 */
export const KUWO_ROUTE_PREFIX = '/kuwo/';
/** JOOX（经 JJ Music 使用的聚合接口）。 */
export const JOOX_ROUTE_PREFIX = '/joox/';

/** 需要从酷狗路由里分流出去的音源。 */
export type RoutedSourceId = 'netease' | 'soda' | 'kuwo' | 'joox';

export interface RoutedSource {
  id: RoutedSourceId;
  /** 形如 `/kuwo/`，结尾必带斜杠。 */
  prefix: string;
}

export const ROUTED_SOURCES: readonly RoutedSource[] = [
  { id: 'netease', prefix: NETEASE_ROUTE_PREFIX },
  { id: 'soda', prefix: SODA_ROUTE_PREFIX },
  { id: 'kuwo', prefix: KUWO_ROUTE_PREFIX },
  { id: 'joox', prefix: JOOX_ROUTE_PREFIX },
];

/** 去掉 query，只留路径。 */
const pathnameOf = (url: string): string => (url ? url.split('?')[0] : '');

/**
 * 判断 URL 是否属于某个前缀。
 *
 * 接受两种形态：`/kuwo`（无尾斜杠的裸前缀）与 `/kuwo/...`。
 * 前缀本身按传入值处理，`/kuwo` 与 `/kuwo/` 都可用。
 */
export const isRouteOf = (url: string, prefix: string): boolean => {
  const pathname = pathnameOf(url);
  if (!pathname) return false;
  const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return pathname === bare || pathname.startsWith(`${bare}/`);
};

/**
 * 从 URL 取出端点名：`endpointOf('/kuwo/search', '/kuwo/')` → `'search'`。
 *
 * 用 `isRouteOf` 已经在前面挡过一次，这里只负责剥离；不抛错，
 * 因为「不属于该前缀」的输入按空端点处理，调用方会落到 404 分支。
 */
export const endpointOf = (url: string, prefix: string): string => {
  const pathname = pathnameOf(url);
  const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (pathname === bare) return '';
  if (!pathname.startsWith(`${bare}/`)) return '';
  return pathname.slice(bare.length + 1);
};

/* ------------------------------------------------------------------ *
 * 具名判定（v1.5.0 的旧导出，v2.0.0 起统一实现在这里）
 * ------------------------------------------------------------------ */

/**
 * 以下四个具名函数是 v1.5.0 `neteaseRoutes.ts` / `sodaRoutes.ts` 的原有 API。
 *
 * v2.0.0 把它们**移到本文件**而不是保留一层 re-export 转发，原因是
 * `node --test` 用 `--experimental-strip-types` 直接跑源码时，
 * 相对 import **必须带扩展名**，而本项目源码一律不带
 * （`import x from '../networkPolicy'` 是 vite 的解析方式）。
 * 只要中间多一层转发，被测试 import 的那个文件就会带上一个无法解析的
 * 相对 import，测试直接 ERR_MODULE_NOT_FOUND。
 *
 * ⇒ 判定的**唯一实现**在本文件，其它模块只调用，不再自己实现一遍。
 */

/** 判断 URL 是否属于网易云路由。 */
export const isNeteaseRoute = (url: string): boolean => isRouteOf(url, NETEASE_ROUTE_PREFIX);

/** 从 URL 取网易云端点名（`/netease/song/url` → `song/url`）。 */
export const neteaseEndpointOf = (url: string): string => endpointOf(url, NETEASE_ROUTE_PREFIX);

/** 判断 URL 是否属于 Soda 路由。 */
export const isSodaRoute = (url: string): boolean => isRouteOf(url, SODA_ROUTE_PREFIX);

/** 从 URL 取 Soda 端点名（`/soda/search` → `search`）。 */
export const sodaEndpointOf = (url: string): string => endpointOf(url, SODA_ROUTE_PREFIX);

/** 判断 URL 是否属于酷我路由。 */
export const isKuwoRoute = (url: string): boolean => isRouteOf(url, KUWO_ROUTE_PREFIX);

/** 判断 URL 是否属于 JOOX 路由。 */
export const isJooxRoute = (url: string): boolean => isRouteOf(url, JOOX_ROUTE_PREFIX);
