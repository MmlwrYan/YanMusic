/**
 * 网易云路由前缀与判定（v2.0.0）。
 *
 * ## 为什么单独一个纯模块
 *
 * 判定逻辑被两处使用、且**必须被单元测试直接驱动**：
 * - `src/main/server.ts` 在进入酷狗路由匹配**之前**用它分流；
 * - `src/main/netease/index.ts` 用它。
 *
 * 但那一串模块最终会 `import { app } from 'electron'`，在 `node --test`
 * 下无法实例化（本仓库的既有做法见 `tests/ipc-channel-contract.test.ts`
 * 顶部注释）。因此把**纯判定**抽到这里 —— 与 `shared/plugin-capabilities.ts`、
 * `main/plugins/senderIdentity.ts` 同一思路：可被 node 直接 import 的零依赖函数，
 * 于是守卫测的是**真行为**而不是源码正则。
 *
 * ## 这条不变量的重要性
 *
 * 网易云与酷狗共用同一个分发器（`handleApiRequest`）。若前缀判定写坏，
 * 最坏的形态是**酷狗路由被网易云吃掉**（或反过来），
 * 表现为「整个搜索/取链都失效」——而且因为两条链路都还「能返回东西」，
 * 排查时很容易误判。故用测试钉死。
 */

/** 所有网易云路由共用的前缀。 */
export const NETEASE_ROUTE_PREFIX = '/netease/';

/**
 * 判断一个请求 URL 是否属于网易云路由。
 *
 * 刻意**不做**「以 `/netease` 开头就算」的宽松匹配：
 * `/neteasefoo` 必须**不**命中，否则将来酷狗侧新增任何以 netease 开头的
 * 路径都会被静默劫持。
 */
export const isNeteaseRoute = (url: string): boolean => {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return pathname === '/netease' || pathname.startsWith(NETEASE_ROUTE_PREFIX);
};

/** 从路由 URL 取出端点名（`/netease/song/url` → `song/url`）。 */
export const neteaseEndpointOf = (url: string): string =>
  url.split('?')[0].replace(/^\/netease\/?/, '');
