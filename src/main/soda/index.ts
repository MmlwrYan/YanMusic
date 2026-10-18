/**
 * `/soda/*` 路由与运行期单例（v1.5.0，v2.0.0 起支持自动探测）。
 *
 * ## 定位
 *
 * 与 `src/main/netease/index.ts` 完全同构：**不新起 HTTP 端口**，
 * 而是被 `src/main/server.ts` 的 `handleApiRequest()` 在进入酷狗路由匹配之前分流。
 * 所有音源共用一条 IPC 链路、同一套生命周期。
 *
 * ## 配置来源的优先级（v2.0.0 变更）
 *
 * 1. **环境变量**（显式覆盖，便于调试与非常规安装位置）；
 * 2. **自动探测**（`./discovery`）：从本机已安装的汽水客户端里找到
 *    `bdms.node` 与设备指纹，用户无需配置任何东西。
 *
 * v1.5.0 只有第 1 条，结果是「明明装了客户端，音源却一直是关的」。
 *
 * ```text
 * YANMUSIC_SODA_BDMS_PATH       bdms.node 的绝对路径（可选，覆盖自动探测）
 * YANMUSIC_SODA_DEVICE_ID       设备指纹 deviceId（可选）
 * YANMUSIC_SODA_INSTALL_ID      设备指纹 installId（可选）
 * YANMUSIC_SODA_DEVICE_TOKEN    可选
 * YANMUSIC_SODA_USER_AGENT      可选，形如 LunaPC/3.7.0(buildid)
 * YANMUSIC_SODA_COOKIE          【实验性】用户自有 Cookie；设置后启用「账号模式」
 * ```
 *
 * ## 当前状态（如实记录）
 *
 * 签名链路（`bdms.generateHttpSignatureHeaders` → `X-Neptune` 头）**实测可用**：
 * 本机 `3.7.0` 的 `bdms.node` 是 **Node-API 模块**，在 Node 22 与 Electron 下
 * 都能直接加载。但上游 `GET /luna/pc/search/{type}` 在**无客户端完整运行环境**时
 * 恒定返回 `{"extra":{"empty_search":1}}`（参数被忽略，连裸 URL 也一样），
 * 因此本版的汽水音源**可能拿不到搜索结果**。
 * 详见 `docs/agent/v2.0.0/26-source-expansion-results-2026-10-18.md`。
 * 未打通的部分不影响其它音源：它的失败被限制在 `/soda/*` 之内。
 */

import { SodaProvider, type SodaProviderConfig } from '../../providers/SodaProvider';
import { sodaEndpointOf } from '../../shared/musicSourceRoutes';
import { discoverSodaClient, maskDeviceId } from './discovery';
import type { ApiRequest, ApiResponse } from '../server';
import log from '../logger';

/** 运行期单例（懒创建：只有真正被请求时才去加载原生模块）。 */
let provider: SodaProvider | null = null;
let lastInitError: string | null = null;
/** 自动探测的结论只算一次 —— 每次请求都扫盘代价太大，且结论不会变。 */
let discoveryCache: ReturnType<typeof discoverSodaClient> | null = null;

const getDiscovery = (): ReturnType<typeof discoverSodaClient> => {
  if (!discoveryCache) {
    discoveryCache = discoverSodaClient();
    if (discoveryCache.bdmsModulePath || discoveryCache.identity) {
      log.info('[soda] 已从本机客户端自动探测到配置', {
        bdms: discoveryCache.bdmsModulePath ?? '(未找到)',
        deviceIdTail: maskDeviceId(discoveryCache.identity?.deviceId),
      });
    }
  }
  return discoveryCache;
};

export type SodaConfigResult =
  | { ok: true; config: SodaProviderConfig; source: 'env' | 'discovered' }
  | { ok: false; reason: 'not-installed' | 'incomplete'; message: string };

/**
 * 读取配置：环境变量优先，缺失则自动探测。
 *
 * 返回结构化的失败原因（而不是 null）—— UI 需要区分
 * 「没装汽水客户端」与「装了但缺某个文件」，否则用户只知道
 * 「音源不可用」，无从下手。
 */
export const readSodaConfig = (): SodaConfigResult => {
  const envBdms = (process.env.YANMUSIC_SODA_BDMS_PATH ?? '').trim();
  const envDeviceId = (process.env.YANMUSIC_SODA_DEVICE_ID ?? '').trim();
  const envInstallId = (process.env.YANMUSIC_SODA_INSTALL_ID ?? '').trim();
  const cookie = (process.env.YANMUSIC_SODA_COOKIE ?? '').trim();
  const extra = {
    deviceToken: (process.env.YANMUSIC_SODA_DEVICE_TOKEN ?? '').trim() || undefined,
    clientUserAgent: (process.env.YANMUSIC_SODA_USER_AGENT ?? '').trim() || undefined,
    // 空串视为「未登录」，不要传空字符串（会让签名把它算进 headers）
    cookie: cookie || undefined,
    logger: (message: string, detail?: unknown) => log.info(`[soda] ${message}`, detail ?? ''),
  };

  if (envBdms && envDeviceId && envInstallId) {
    return {
      ok: true,
      source: 'env',
      config: {
        bdmsModulePath: envBdms,
        deviceId: envDeviceId,
        installId: envInstallId,
        cdid: (process.env.YANMUSIC_SODA_CDID ?? '').trim() || undefined,
        ...extra,
      },
    };
  }

  const found = getDiscovery();
  if (!found.bdmsModulePath && !found.identity) {
    return {
      ok: false,
      reason: 'not-installed',
      message: '未在本机找到汽水音乐客户端（可设置 YANMUSIC_SODA_BDMS_PATH 等环境变量手动指定）',
    };
  }
  if (!found.bdmsModulePath) {
    return {
      ok: false,
      reason: 'incomplete',
      message: `已找到汽水客户端的数据目录，但未找到签名模块 bdms.node（已探测 ${found.searched.length} 处）`,
    };
  }
  if (!found.identity) {
    return {
      ok: false,
      reason: 'incomplete',
      message: '已找到 bdms.node，但未能读取设备指纹 DeviceV1（请先启动一次汽水客户端）',
    };
  }

  return {
    ok: true,
    source: 'discovered',
    config: {
      bdmsModulePath: found.bdmsModulePath,
      deviceId: found.identity.deviceId,
      installId: found.identity.installId,
      cdid: found.identity.cdid || undefined,
      ...extra,
    },
  };
};

/** 首次调用时创建并初始化；初始化失败会被记住，不会反复重试打日志。 */
const ensureProvider = async (): Promise<
  { ok: true; provider: SodaProvider } | { ok: false; message: string }
> => {
  if (provider) return { ok: true, provider };
  if (lastInitError) return { ok: false, message: lastInitError };

  const resolved = readSodaConfig();
  if (!resolved.ok) {
    lastInitError = resolved.message;
    return { ok: false, message: lastInitError };
  }

  const instance = new SodaProvider(resolved.config);
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

/** 仅用于测试/诊断：重置单例与探测缓存。 */
export const __resetSodaProviderForTests = (): void => {
  provider = null;
  lastInitError = null;
  discoveryCache = null;
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
    const resolved = readSodaConfig();
    if (!resolved.ok) {
      return ok({
        available: false,
        reason: resolved.reason,
        message: resolved.message,
        /** 配置来自哪里：`env` = 环境变量，`discovered` = 自动探测，`null` = 未配置 */
        configSource: null,
        accountMode: false,
      });
    }
    const ready = await ensureProvider();
    return ok({
      available: ready.ok,
      reason: ready.ok ? null : 'init-failed',
      message: ready.ok ? null : ready.message,
      configSource: resolved.source,
      /** 是否处于「用户自己的账号」模式（仅用于 UI 标注「试听 / 完整」） */
      accountMode: Boolean(resolved.config.cookie),
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
