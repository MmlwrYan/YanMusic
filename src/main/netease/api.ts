/**
 * 网易云端点封装（v2.0.0）。
 *
 * ## ⚠️ 本文件的端点与参数**全部来自实测**，不是猜的
 *
 * 网易云这套 legacy `/api/*` 接口有一个**很坑的共同特征**：
 * 端点不存在时**不返回 HTTP 404**，而是 **HTTP 200 + body 里 `code: 404`**。
 * 只看状态码会把「端点写错」误判成「没搜到 / 这首不可播」，
 * 于是排查方向会整个跑偏。
 *
 * 实测记录（2026-10-16，脚本见 `.workbuddy/tmp/probe-*.mjs`）：
 *
 * | 我最初写的 | 实测结果 | 实际可用 |
 * |---|---|---|
 * | `/api/search` | HTTP 200，`code:404` | **`/api/search/get`**（`result.songs` / `songCount` / `hasMore`） |
 * | `/api/song/url?id=&level=` | HTTP 200，`code:404` | **`/api/song/enhance/player/url`**，参数是 `ids=[id]` + **`br`**（不是 `level`） |
 * | `/api/lyric?id=` | HTTP 200，`code:404` | **`/api/song/lyric`**（`id` + `lv/kv/tv`） |
 * | `/api/check/music` | HTTP 200，`code:404` | **无可用替代 → 已移除该端点** |
 *
 * ## 音质：`br` 而不是 `level`，且服务端会**降级**
 *
 * `song/enhance/player/url` 只认 `br`。实测 `br=999000`（要无损）
 * 匿名请求返回的是 **`br=320000` / `level: "exhigh"`** ——
 * 服务端按账号能力自行降级。这正对应任务书「不做 VIP 绕过、只取公开可播资源」。
 *
 * 因此取链策略是：**按 br 从高到低依次请求，第一个返回非空 URL 即用**。
 * 这也让「降级链真的会降级」成为可实测的行为（而非假设）。
 *
 * ## 字段归一化在主进程
 *
 * 见 `./map`（零依赖纯函数）与 `docs/agent/v2.0.0/24-netease-source-plan-2026-10-15.md` §7。
 */

import { callNetease } from './client';
import { mapNeteaseSongs, type NeteaseSong } from './map';

export { mapNeteaseSong, mapNeteaseSongs, type NeteaseSong } from './map';

/* ------------------------------------------------------------------ *
 * 音质
 * ------------------------------------------------------------------ */

/**
 * 请求用的码率档位（由高到低即候选顺序）。
 *
 * 与项目 `AudioQualityValue`（`src/renderer/types.ts:6`：
 * `'128' | '320' | 'flac' | 'high' | 'super'`）的对照见 plan §4。
 */
export const NETEASE_BITRATE_HIRES = 999_000;
export const NETEASE_BITRATE_LOSSLESS = 900_000;
export const NETEASE_BITRATE_EXHIGH = 320_000;
export const NETEASE_BITRATE_HIGHER = 192_000;
export const NETEASE_BITRATE_STANDARD = 128_000;

/** 把项目音质值映射为「由高到低」的 br 候选序列。 */
export const neteaseBitrateCandidates = (quality: string | undefined): number[] => {
  switch (quality) {
    case 'super':
    case 'high':
      return [
        NETEASE_BITRATE_HIRES,
        NETEASE_BITRATE_LOSSLESS,
        NETEASE_BITRATE_EXHIGH,
        NETEASE_BITRATE_HIGHER,
        NETEASE_BITRATE_STANDARD,
      ];
    case 'flac':
      return [
        NETEASE_BITRATE_LOSSLESS,
        NETEASE_BITRATE_EXHIGH,
        NETEASE_BITRATE_HIGHER,
        NETEASE_BITRATE_STANDARD,
      ];
    case '320':
      return [NETEASE_BITRATE_EXHIGH, NETEASE_BITRATE_HIGHER, NETEASE_BITRATE_STANDARD];
    default:
      // '128' / 未知 / 兼容模式：只要标准音质，不浪费请求
      return [NETEASE_BITRATE_STANDARD];
  }
};

/* ------------------------------------------------------------------ *
 * 业务错误：HTTP 200 + body.code !== 200
 * ------------------------------------------------------------------ */

interface NeteaseEnvelope {
  code?: number;
  message?: string;
}

/**
 * 校验 body 里的业务码。
 *
 * **这是本文件最重要的一处防御**：网易云把「端点不存在」「参数不对」
 * 都表达成 HTTP 200 + `code: 404/400`。不做这层检查，
 * 调用方只会看到「空列表」「无链接」，而真正的原因（端点/参数错了）
 * 被完全掩盖。
 */
const assertBusinessOk = (payload: NeteaseEnvelope | null, what: string): void => {
  const code = payload?.code;
  if (typeof code !== 'number' || code === 200) return;
  throw new Error(
    `网易云「${what}」返回业务码 ${code}` +
      (payload?.message ? `（${payload.message}）` : '') +
      ' —— 注意 HTTP 状态码是成功的，错误只在 body 里',
  );
};

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

export interface NeteaseSearchResult {
  songs: NeteaseSong[];
  total: number;
  hasMore: boolean;
}

/** 搜索歌曲。`type=1` = 单曲。端点实测为 `/api/search/get`。 */
export const searchNeteaseSongs = async (
  keywords: string,
  limit = 30,
  offset = 0,
): Promise<NeteaseSearchResult> => {
  const payload = await callNetease<
    NeteaseEnvelope & {
      result?: { songs?: unknown[]; songCount?: number; hasMore?: boolean };
    }
  >({
    endpoint: 'search/get',
    params: { s: keywords, type: 1, limit, offset },
  });

  assertBusinessOk(payload, '搜索');

  const result = payload?.result ?? {};
  const songs = mapNeteaseSongs(result.songs);
  const total = typeof result.songCount === 'number' ? result.songCount : songs.length;

  return {
    songs,
    total,
    hasMore: typeof result.hasMore === 'boolean' ? result.hasMore : offset + songs.length < total,
  };
};

/**
 * 批量取歌曲详情。
 *
 * ⚠️ 实测发现：`song/detail` 返回的 `ar` 是**空数组**、`al.picUrl` 也缺失，
 * 元数据明显比 `search/get` 贫瘠。因此**列表展示必须依赖搜索端点返回的字段**，
 * 本函数只作为「按 id 补一首」的兜底，不要指望它补出歌手/封面。
 */
export const getNeteaseSongDetail = async (ids: (string | number)[]): Promise<NeteaseSong[]> => {
  if (ids.length === 0) return [];
  const payload = await callNetease<NeteaseEnvelope & { songs?: unknown[] }>({
    endpoint: 'song/detail',
    params: { ids: `[${ids.join(',')}]` },
  });
  assertBusinessOk(payload, '歌曲详情');
  return mapNeteaseSongs(payload?.songs);
};

/* ------------------------------------------------------------------ *
 * 取播放链
 * ------------------------------------------------------------------ */

export interface NeteaseAudioUrl {
  url: string;
  /** 绝对过期时间（毫秒时间戳）；上游给了 `expi` 才有值。 */
  expireAt?: number;
  /** 服务端**实际**返回的档位（可能低于请求档位 —— 这是正常的降级）。 */
  br?: number;
  level?: string;
  type?: string;
  fee?: number;
}

interface RawSongUrlItem {
  id?: number | string;
  url?: string | null;
  br?: number;
  size?: number;
  type?: string;
  level?: string;
  /** **剩余秒数**（实测 1200），不是绝对时间戳 */
  expi?: number;
  fee?: number;
  code?: number;
  freeTrialInfo?: unknown;
}

/**
 * 取播放链：按 br 从高到低试，**第一个返回非空 URL 即用**。
 *
 * 判据必须是「URL 非空」而不是「请求成功」：匿名/无版权时
 * 网易云返回的是 `url: null`（甚至 `code: 404`），**不是 HTTP 错误**。
 */
export const resolveNeteaseAudioUrl = async (
  id: string | number,
  bitrates: number[],
): Promise<NeteaseAudioUrl | null> => {
  let lastError: Error | null = null;

  for (const br of bitrates) {
    let payload: (NeteaseEnvelope & { data?: RawSongUrlItem[] }) | null = null;
    try {
      payload = await callNetease<NeteaseEnvelope & { data?: RawSongUrlItem[] }>({
        endpoint: 'song/enhance/player/url',
        // 实测：`ids` 与 `br` 都是必需的；缺任一个都返回 `code:400 参数错误`
        params: { ids: `[${id}]`, br },
      });
    } catch (error) {
      // 单档失败不终止，继续试更低档位
      // ⚠️ 这里也可能是**端点/参数写错**：那会以 `code:400` 的形式走到下面的检查，
      // 被转成异常后进到这里，于是表现为「所有档位都失败」。
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    // 与其它读接口一致：HTTP 200 也可能是 `code:400 参数错误` / `code:404 接口未找到`。
    // 不检查的话，「参数写错」会被当成「这首不可播」，排查方向整个跑偏。
    try {
      assertBusinessOk(payload, '取播放链');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!url) continue;

    // ⚠️ `expi` 是**剩余秒数**，要换算成绝对时间。
    // 直接当时间戳会把「还有 1200 秒」当成 1970 年，链接**立刻被判过期**。
    const expireAt =
      typeof item?.expi === 'number' && item.expi > 0 ? Date.now() + item.expi * 1000 : undefined;

    return {
      url,
      expireAt,
      br: typeof item?.br === 'number' ? item.br : undefined,
      level: typeof item?.level === 'string' ? item.level : undefined,
      type: typeof item?.type === 'string' ? item.type : undefined,
      fee: typeof item?.fee === 'number' ? item.fee : undefined,
    };
  }

  if (lastError) {
    // 所有档位都因为网络/协议错误失败 → 这是**异常**，应让上层看到
    throw lastError;
  }
  // 全部档位都返回空 URL → **正常业务结果**（不可播），不是异常
  return null;
};

/* ------------------------------------------------------------------ *
 * 歌词
 * ------------------------------------------------------------------ */

export interface NeteaseLyric {
  /** 原文歌词（LRC 文本）；无则为空串。 */
  lyric: string;
  /** 翻译歌词；无则为空串。 */
  translation: string;
}

/** 取歌词。端点实测为 `/api/song/lyric`（`/api/lyric` 是 404）。 */
export const getNeteaseLyric = async (id: string | number): Promise<NeteaseLyric> => {
  const payload = await callNetease<
    NeteaseEnvelope & {
      lrc?: { lyric?: string };
      tlyric?: { lyric?: string };
    }
  >({
    endpoint: 'song/lyric',
    params: { id, lv: -1, kv: -1, tv: -1 },
  });

  assertBusinessOk(payload, '歌词');

  return {
    lyric: typeof payload?.lrc?.lyric === 'string' ? payload.lrc.lyric : '',
    translation: typeof payload?.tlyric?.lyric === 'string' ? payload.tlyric.lyric : '',
  };
};
