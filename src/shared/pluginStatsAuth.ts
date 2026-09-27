/**
 * 插件市场统计接口的鉴权与限流规则（M-7）。
 *
 * 背景：`cloudflare/plugin-marketplace-worker/worker.js` 的写入端点
 * `/v1/plugins/events` 原先**完全无鉴权**且 `access-control-allow-origin: *`,
 * 任何人可 POST 任意 `sourceId`/`pluginId` 任意增减计数，而计数直接决定
 * `computeScore = installs*3 + todayInstalls*5 - failures*2`，
 * 即插件排行榜可被任意刷高/刷低。
 *
 * 本模块只放**纯函数**（无 Electron / 无 Cloudflare 依赖），
 * 由主进程侧客户端与测试共同引用；Worker 侧因是纯 JS 运行环境，
 * 按同一口径内联等价实现（见 worker.js 顶部 `M7-AUTH` 段落），
 * 由 `tests/plugin-stats-auth.test.ts` 保证两侧口径一致。
 */

/** 写入端点（events）要求的请求头名。 */
export const PLUGIN_STATS_KEY_HEADER = 'x-yanmusic-key';

/** 主进程读取密钥的环境变量名（构建期注入，与统计 URL 变量同风格）。 */
export const PLUGIN_STATS_KEY_ENV = 'yanmusic_PLUGIN_STATS_API_KEY';

/** 写入端点每 IP 的限流窗口（毫秒）与窗口内上限。 */
export const PLUGIN_STATS_WRITE_WINDOW_MS = 60_000;
export const PLUGIN_STATS_WRITE_MAX_PER_WINDOW = 60;

/**
 * 比较两个字符串是否相等（**常时比较**，避免通过响应时间侧信道逐字节爆破密钥）。
 *
 * 用累加 XOR 而非 `===`：`===` 会在首个不同字节处提前返回，
 * 攻击者据响应时间差可逐位推断密钥。此处长度不等直接返回 false
 * （长度本身不是秘密，密钥长度固定）。
 */
export const safeEqual = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/**
 * 判定一次写入请求是否放行。
 *
 * 策略：**fail closed**。服务端未配置密钥（`expected` 为空）时**一律拒绝**写入，
 * 而不是放行——否则一次「忘记配置 secret」的部署就等于把写入口重新敞开，
 * 与修复前无异。读取端点不经过本函数。
 */
export const isWriteAuthorized = (provided: unknown, expected: unknown): boolean => {
  const want = String(expected ?? '');
  if (!want) return false;
  const got = String(provided ?? '').trim();
  if (!got) return false;
  return safeEqual(got, want);
};

/** 限流计数器：ip -> { count, windowStart }。 */
export type RateLimitEntry = { count: number; windowStart: number };

/**
 * 固定窗口限流。返回 `{ allowed, entry }`，调用方负责把 `entry` 写回存储。
 * 导入 `now` 便于测试；窗口滚动时计数归 1。
 */
export const checkRateLimit = (
  entry: RateLimitEntry | undefined,
  now: number,
): { allowed: boolean; entry: RateLimitEntry } => {
  if (!entry || now - entry.windowStart >= PLUGIN_STATS_WRITE_WINDOW_MS) {
    return { allowed: true, entry: { count: 1, windowStart: now } };
  }
  const count = entry.count + 1;
  return {
    allowed: count <= PLUGIN_STATS_WRITE_MAX_PER_WINDOW,
    entry: { count, windowStart: entry.windowStart },
  };
};

/**
 * 从请求头对象中取出密钥。
 * 头名大小写不敏感（遵循 HTTP 语义，也兼容 Cloudflare `Headers` 的取值方式）。
 */
export const readStatsKeyFromHeaders = (headers: unknown): string => {
  if (!headers) return '';
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => string | null }).get(
      PLUGIN_STATS_KEY_HEADER,
    );
    return String(value ?? '').trim();
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === PLUGIN_STATS_KEY_HEADER) return String(value ?? '').trim();
    }
  }
  return '';
};
