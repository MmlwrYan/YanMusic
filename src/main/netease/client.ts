/**
 * 网易云 API 的主进程 HTTP 客户端（v2.0.0）。
 *
 * ## 为什么是「主进程内的一个模块」而不是一个内嵌代理服务
 *
 * 任务书原本设想「用 Fastify 起一个仅监听 127.0.0.1 随机端口的代理服务」。
 * 读代码后确认**不需要**：`src/main/server.ts:229` 的 `handleApiRequest()`
 * 已经是一个**主进程内的 API 分发器**（`initApiServer()` 在 `app.ts:8` 起，
 * 经 IPC 暴露给渲染进程的 `request.get(...)`），它本来就把
 * 「Cookie 注入、请求头、响应回传」收在主进程侧。
 * 因此本模块只是**多挂一路路由**，不新增监听端口、不新增进程。
 *
 * ## 为什么不用 `server/util/request.js` 的 `createRequest`
 *
 * 那个是**酷狗专用**的：它硬编码了酷狗签名（`signKey`/`signature*`）、
 * `appid`/`clientver`、设备指纹与 `gateway.kugou.com`。
 * 拿来发网易云请求会带上酷狗签名和默认 cookie，是**错误的复用**。
 *
 * ## 网络出口与 Cookie
 *
 * 走 `networkFetch()`（`src/main/networkPolicy.ts:159`）—— 它基于
 * `APP_NETWORK_SESSION_PARTITION`（`networkPolicy.ts:14`）这个**受管分区**，
 * 于是本模块自动获得：
 * - 应用统一的代理策略（含代理认证、热更新）；
 * - Chromium 管理的 **cookie jar**（持久、按域隔离）。
 *
 * ⇒ **不自己写 cookie 存储**。自己存容易写出「写到日志里」「跨域串味」
 * 两类问题；交给 Chromium 既更稳，也和 `networkPolicy.ts:99` 的酷狗分区同一思路。
 */

import { networkFetch } from '../networkPolicy';
import log from '../logger';

/** 网易云 Web/桌面端接口基址。 */
const NETEASE_API_BASE = 'https://music.163.com';

/**
 * 防盗链头。
 *
 * 网易云外链对 `Referer`/`User-Agent` 敏感：缺 `Referer` 时常见
 * 「取链返回了 URL，但真正拉流时 403」。
 * 这类失败**不像网络错误那样显眼**，所以这里固定注入，而不是留给调用方。
 */
const COMMON_HEADERS: Record<string, string> = {
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

/**
 * 客户端可调用的网易云端点。
 *
 * ⚠️ 这些路径**全部经过实测**，不要按「看起来更 RESTful」改名：
 * 网易云对写错的端点返回 **HTTP 200 + `code: 404`**（不是 HTTP 404），
 * 于是改名后的症状是「静默搜不到 / 静默不可播」，极难排查。
 * 实测对照表见 `src/main/netease/api.ts` 顶部。
 */
export type NeteaseEndpoint =
  'ping' | 'search/get' | 'song/detail' | 'song/enhance/player/url' | 'song/lyric';

export interface NeteaseRequest {
  endpoint: NeteaseEndpoint;
  params?: Record<string, unknown>;
}

/** 默认请求超时（毫秒）。网易云偶发慢响应，给得比酷狗宽松一些。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 把 `params` 转成 query string。
 *
 * 只接受标量：数组按网易云惯例用逗号连接（如 `ids=1,2,3`），
 * 对象直接忽略（网易云没有需要嵌套结构的 GET 端点）。
 */
const buildQuery = (params: Record<string, unknown> = {}): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const joined = value.filter((v) => v !== undefined && v !== null).join(',');
      if (joined) search.set(key, joined);
      continue;
    }
    if (typeof value === 'object') continue;
    search.set(key, String(value));
  }
  return search.toString();
};

/**
 * 发一次网易云 GET 请求，返回**已解析的 JSON**。
 *
 * 失败语义（刻意区分，便于上层给出可诊断的提示）：
 * - 网络层失败 / 超时 → 抛错，由调用方转成 `502`；
 * - HTTP 非 2xx → 抛错并带上状态码；
 * - 2xx 但响应体不是 JSON → 抛错（网易云异常时会返回 HTML 错误页，
 *   如果静默当成空对象，上层会表现为「搜不到东西」而不是「接口挂了」）。
 */
export const callNetease = async <T = unknown>(
  { endpoint, params }: NeteaseRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> => {
  const query = buildQuery(params);
  const url = `${NETEASE_API_BASE}/api/${endpoint}${query ? `?${query}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await networkFetch(url, {
      method: 'GET',
      headers: COMMON_HEADERS,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`网易云接口 ${endpoint} 返回 HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `网易云接口 ${endpoint} 返回的不是 JSON（长度 ${text.length}，` +
          `开头 ${JSON.stringify(text.slice(0, 80))}）—— 通常是接口已变更或被拦截`,
      );
    }
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    log.warn(`[netease] 请求失败 endpoint=${endpoint}`, isAbort ? `超时（${timeoutMs}ms）` : error);
    throw isAbort ? new Error(`网易云接口 ${endpoint} 超时（${timeoutMs}ms）`) : error;
  } finally {
    clearTimeout(timer);
  }
};
