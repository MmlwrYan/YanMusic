/**
 * `/netease/*` 路由（v2.0.0）。
 *
 * ## 定位
 *
 * 本模块**不新起 HTTP 监听端口**，而是被 `src/main/server.ts` 的
 * `handleApiRequest()` 在**进入酷狗路由匹配之前**分流进来。
 * 因此它与酷狗共享同一条 IPC 链路、同一套就绪判据、同一个生命周期。
 *
 * ## 与酷狗路由的隔离（必须保持）
 *
 * 路由前缀固定为 `/netease/`，与酷狗的无前缀路由（`/search`、`/song/url`、
 * `/lyric` …）**不会混淆**。这条不变量有测试守卫：
 * `tests/netease-route-isolation.test.ts`。
 */

import {
  getNeteaseLyric,
  getNeteaseSongDetail,
  neteaseBitrateCandidates,
  resolveNeteaseAudioUrl,
  searchNeteaseSongs,
} from './api';
import { neteaseEndpointOf } from '../../shared/neteaseRoutes';
import type { ApiRequest, ApiResponse } from '../server';

/** 所有网易云路由共用的前缀（定义在 `shared/neteaseRoutes.ts`，便于被测试直接驱动）。 */
export { NETEASE_ROUTE_PREFIX, isNeteaseRoute } from '../../shared/neteaseRoutes';

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

const fail = (status: number, msg: string): ApiResponse => ({
  status,
  body: { code: status, msg, data: null },
});

/** 从 query 里取字符串，缺省返回 `undefined`（不返回空串，便于区分「没传」）。 */
const str = (value: unknown): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : String(value);

/** 取正整数，带默认值与上限（防止调用方传 `limit=1e9`）。 */
const int = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

/**
 * 处理一条网易云请求。
 *
 * `params` 与酷狗侧一样是 `unknown`（IPC 会保留数字等原始类型），
 * 因此这里统一做字符串化，避免下游拿到 `number` 时 `.trim()` 炸掉。
 */
export const handleNeteaseRequest = async (request: ApiRequest): Promise<ApiResponse> => {
  const pathname = request.url.split('?')[0];
  // 去掉前缀 → 得到端点名，如 '/netease/song/url' → 'song/url'
  const endpoint = neteaseEndpointOf(pathname);
  const params = (request.params ?? {}) as Record<string, unknown>;

  try {
    switch (endpoint) {
      case 'ping':
        return ok({ ok: true, source: 'netease' });

      case 'search': {
        const keywords = str(params.keywords) ?? str(params.s);
        if (!keywords) return fail(400, '缺少 keywords');
        const limit = int(params.limit, 30, 100);
        const offset = int(params.offset, 0, 100_000);
        return ok(await searchNeteaseSongs(keywords, limit, offset));
      }

      case 'song/detail': {
        const ids = str(params.ids);
        if (!ids) return fail(400, '缺少 ids');
        const list = ids
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length === 0) return fail(400, 'ids 为空');
        return ok({ songs: await getNeteaseSongDetail(list) });
      }

      case 'song/url': {
        const id = str(params.id);
        if (!id) return fail(400, '缺少 id');

        // 允许调用方显式指定 br（便于验证降级链）；否则按项目音质值推导。
        const explicitBr = Number.parseInt(String(params.br ?? ''), 10);
        const bitrates =
          Number.isFinite(explicitBr) && explicitBr > 0
            ? [explicitBr]
            : neteaseBitrateCandidates(str(params.quality));

        const resolved = await resolveNeteaseAudioUrl(id, bitrates);
        if (!resolved) {
          // 明确区分「接口挂了」与「这首不可播」：前者抛错变 502，后者是正常业务结果。
          return ok({ url: null, reason: 'no-playable-url', triedBitrates: bitrates });
        }
        return ok(resolved);
      }

      case 'lyric': {
        const id = str(params.id);
        if (!id) return fail(400, '缺少 id');
        return ok(await getNeteaseLyric(id));
      }

      default:
        return fail(404, `未知的网易云端点：${endpoint}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 502 而非 500：这是**上游**失败，不是本进程内部错误。
    return fail(502, message);
  }
};
