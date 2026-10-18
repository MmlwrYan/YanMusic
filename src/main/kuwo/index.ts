/**
 * `/kuwo/*` 路由（v2.0.0）。
 *
 * ## 定位
 *
 * 与 `src/main/netease/index.ts`、`src/main/soda/index.ts` 同构：
 * **不新起 HTTP 端口**，被 `src/main/server.ts` 的 `handleApiRequest()`
 * 在进入酷狗路由匹配之前分流。四个音源共用一条 IPC 链路与同一套生命周期。
 *
 * ## 前缀隔离
 *
 * 固定 `/kuwo/`，由 `tests/music-source-routes.test.ts` 守卫。
 */

import { KUWO_ROUTE_PREFIX, endpointOf } from '../../shared/musicSourceRoutes';
import { resolveKuwoPlayUrl, searchKuwo } from './api';
import type { ApiRequest, ApiResponse } from '../server';

export { KUWO_ROUTE_PREFIX };

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

const fail = (status: number, msg: string, reason?: string): ApiResponse => ({
  status,
  body: { code: status, msg, reason: reason ?? null, data: null },
});

const str = (value: unknown): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : String(value);

const int = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

/**
 * 处理一条酷我请求。
 *
 * 端点：
 * - `GET /kuwo/ping`
 * - `GET /kuwo/search?keywords=&limit=&page=`
 * - `GET /kuwo/play-url?title=&artist=&rid=`
 */
export const handleKuwoRequest = async (request: ApiRequest): Promise<ApiResponse> => {
  const endpoint = endpointOf(request.url, KUWO_ROUTE_PREFIX);
  const params = (request.params ?? {}) as Record<string, unknown>;

  try {
    switch (endpoint) {
      case 'ping':
        return ok({ ok: true, source: 'kuwo' });

      case 'search': {
        const keywords = str(params.keywords) ?? str(params.q);
        if (!keywords) return fail(400, '缺少 keywords');
        const limit = int(params.limit, 30, 60);
        const page = int(params.page, 1, 100);
        const result = await searchKuwo(keywords, limit, page);
        return ok(result);
      }

      case 'play-url': {
        // 取链需要「歌名 + 歌手」重查（详见 kuwo/api.ts 的流程说明），
        // 因此必填的是 title，而不是曲目 id —— rid 只用于**校验身份**。
        const title = str(params.title);
        if (!title) return fail(400, '缺少 title');
        const result = await resolveKuwoPlayUrl({
          title,
          artist: str(params.artist) ?? '',
          kuwoRid: str(params.rid) ?? str(params.songId) ?? '',
        });
        // 取链失败是**正常业务结果**，用 200 返回结构化原因，
        // 让渲染层区分「这首不能放」与「接口挂了」（后者走下面的 catch → 502）。
        return ok(result);
      }

      default:
        return fail(404, `未知的酷我端点：${endpoint || '(空)'}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(502, message, 'upstream');
  }
};
