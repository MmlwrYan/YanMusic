/**
 * `/joox/*` 路由（v2.0.0）。
 *
 * 与 `src/main/kuwo/index.ts` 同构：不新起端口，被
 * `src/main/server.ts` 的 `handleApiRequest()` 分流。
 * 前缀隔离由 `tests/music-source-routes.test.ts` 守卫。
 */

import { JOOX_ROUTE_PREFIX, endpointOf } from '../../shared/musicSourceRoutes';
import { resolveJooxPlayUrl, searchJoox } from './api';
import type { ApiRequest, ApiResponse } from '../server';

export { JOOX_ROUTE_PREFIX };

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
 * 端点：
 * - `GET /joox/ping`
 * - `GET /joox/search?keywords=&limit=`
 * - `GET /joox/play-url?mid=&quality=`
 */
export const handleJooxRequest = async (request: ApiRequest): Promise<ApiResponse> => {
  const endpoint = endpointOf(request.url, JOOX_ROUTE_PREFIX);
  const params = (request.params ?? {}) as Record<string, unknown>;

  try {
    switch (endpoint) {
      case 'ping':
        return ok({ ok: true, source: 'joox' });

      case 'search': {
        const keywords = str(params.keywords) ?? str(params.q);
        if (!keywords) return fail(400, '缺少 keywords');
        return ok(await searchJoox(keywords, int(params.limit, 30, 60)));
      }

      case 'play-url': {
        // JOOX 用 mid 精确查询，不需要歌名/歌手 —— 这是相对原客户端的修正之一。
        const mid = str(params.mid) ?? str(params.songId) ?? str(params.id);
        if (!mid) return fail(400, '缺少 mid');
        return ok(await resolveJooxPlayUrl(mid, str(params.quality)));
      }

      default:
        return fail(404, `未知的 JOOX 端点：${endpoint || '(空)'}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(502, message, 'upstream');
  }
};
