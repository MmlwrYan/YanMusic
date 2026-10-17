/**
 * `/soda/*` 路由与运行期单例（v1.5.0）。
 *
 * ## 定位
 *
 * 与 `src/main/netease/index.ts` 完全同构：**不新起 HTTP 端口**，
 * 而是被 `src/main/server.ts` 的 `handleApiRequest()` 在进入酷狗路由匹配之前分流。
 * 三个音源共用一条 IPC 链路、同一套生命周期。
 *
 * ## 默认关闭
 *
 * 本音源是**实验性**的，且依赖用户本地的第三方原生模块（`bdms.node`）。
 * 没有配置时 `configured === false`，`/soda/*` 一律返回 503 + 明确原因，
 * **绝不**影响酷狗/网易云。
 *
 * ## 配置来源：环境变量（而非设置项）
 *
 * 刻意**不**把 `bdms.node` 路径等塞进 pinia 设置：
 * 那是「本机绝对路径 + 第三方私有模块」，属于开发者级配置，
 * 放进用户可见的设置面板反而会诱导普通用户去折腾。
 * 用环境变量表达「默认关闭、需显式开启」最贴切，也便于不写进持久化。
 *
 * ```text
 * YANMUSIC_SODA_BDMS_PATH       bdms.node 的绝对路径（必需，未设置=音源关闭）
 * YANMUSIC_SODA_DEVICE_ID       游客设备指纹 deviceId（必需）
 * YANMUSIC_SODA_INSTALL_ID      游客设备指纹 installId（必需）
 * YANMUSIC_SODA_DEVICE_TOKEN    可选
 * YANMUSIC_SODA_USER_AGENT      可选，形如 LunaPC/3.7.0(buildid)
 * YANMUSIC_SODA_COOKIE          【实验性】用户自有 Cookie；设置后启用「账号模式」
 * ```
 */

import { SodaProvider, type SodaProviderConfig } from '../../providers/SodaProvider';
import { sodaEndpointOf } from '../../shared/sodaRoutes';
import type { ApiRequest, ApiResponse } from '../server';
import log from '../logger';

/** 运行期单例（懒创建：只有真正被请求时才去加载原生模块）。 */
let provider: SodaProvider | null = null;
let lastInitError: string | null = null;

/** 读取环境变量配置；缺关键项则返回 null（= 音源未开启）。 */
const readConfig = (): SodaProviderConfig | null => {
  const bdmsModulePath = (process.env.YANMUSIC_SODA_BDMS_PATH ?? '').trim();
  const deviceId = (process.env.YANMUSIC_SODA_DEVICE_ID ?? '').trim();
  const installId = (process.env.YANMUSIC_SODA_INSTALL_ID ?? '').trim();
  if (!bdmsModulePath || !deviceId || !installId) return null;

  const cookie = (process.env.YANMUSIC_SODA_COOKIE ?? '').trim();
  return {
    bdmsModulePath,
    deviceId,
    installId,
    deviceToken: (process.env.YANMUSIC_SODA_DEVICE_TOKEN ?? '').trim() || undefined,
    clientUserAgent: (process.env.YANMUSIC_SODA_USER_AGENT ?? '').trim() || undefined,
    // 空串视为「未登录」，不要传空字符串（会让签名把它算进 headers）
    cookie: cookie || undefined,
    logger: (message, detail) => log.info(`[soda] ${message}`, detail ?? ''),
  };
};

/** 首次调用时创建并初始化；初始化失败会被记住，不会反复重试打日志。 */
const ensureProvider = async (): Promise<
  { ok: true; provider: SodaProvider } | { ok: false; message: string }
> => {
  if (provider) return { ok: true, provider };
  if (lastInitError) return { ok: false, message: lastInitError };

  const config = readConfig();
  if (!config) {
    lastInitError = 'Soda 音源未启用：未设置 YANMUSIC_SODA_BDMS_PATH / DEVICE_ID / INSTALL_ID';
    return { ok: false, message: lastInitError };
  }

  const instance = new SodaProvider(config);
  try {
    await instance.init();
  } catch (error) {
    lastInitError = error instanceof Error ? error.message : String(error);
    log.warn('[soda] 初始化失败，音源不可用（不影响其它音源）', { error: lastInitError });
    return { ok: false, message: lastInitError };
  }

  provider = instance;
  return { ok: true, provider };
};

/** 仅用于测试/诊断：重置单例。 */
export const __resetSodaProviderForTests = (): void => {
  provider = null;
  lastInitError = null;
};

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

const fail = (status: number, msg: string, reason?: string): ApiResponse => ({
  status,
  body: { code: status, msg, reason: reason ?? null, data: null },
});

const str = (value: unknown): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : String(value);

/**
 * 处理一条 `/soda/*` 请求。
 *
 * 端点：
 * - `GET /soda/status`    → 音源是否可用（含未启用原因），供 UI 决定是否显示入口
 * - `GET /soda/search`    → `?keywords=`
 * - `GET /soda/play-url`  → `?trackId=&quality=`
 */
export const handleSodaRequest = async (request: ApiRequest): Promise<ApiResponse> => {
  const endpoint = sodaEndpointOf(request.url);
  const params = (request.params ?? {}) as Record<string, unknown>;

  // status 必须能在「未启用」时也正常回答 —— 否则 UI 无法区分
  // 「音源坏了」和「音源没开」。
  if (endpoint === 'status') {
    const config = readConfig();
    if (!config) {
      return ok({
        available: false,
        reason: 'not-configured',
        message: '未配置 bdms.node 路径或设备指纹',
      });
    }
    const ready = await ensureProvider();
    return ok({
      available: ready.ok,
      reason: ready.ok ? null : 'init-failed',
      message: ready.ok ? null : ready.message,
      /** 是否处于「用户自己的账号」模式（仅用于 UI 标注「试听 / 完整」） */
      accountMode: Boolean(config.cookie),
    });
  }

  const ready = await ensureProvider();
  if (!ready.ok) {
    // 503 而不是 500：这是「未启用」，不是内部错误
    return fail(503, ready.message, 'not-configured');
  }

  try {
    switch (endpoint) {
      case 'search': {
        const keywords = str(params.keywords) ?? str(params.q);
        if (!keywords) return fail(400, '缺少 keywords');
        const tracks = await ready.provider.search(keywords, str(params.type) ?? 'song');
        return ok({ tracks, total: tracks.length });
      }

      case 'play-url': {
        const trackId = str(params.trackId) ?? str(params.id);
        if (!trackId) return fail(400, '缺少 trackId');
        // 返回结构化结果：ok=false 时带 reason，前端据此区分
        // 「需要登录」与「真的没有」——不要退化成空字符串。
        const result = await ready.provider.getPlayUrl(trackId, str(params.quality) ?? 'standard');
        return ok(result);
      }

      default:
        return fail(404, `未知的 Soda 端点：${endpoint}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('[soda] 请求失败', { endpoint, message });
    // 502：上游失败，不是本进程内部错误
    return fail(502, message, 'upstream');
  }
};
