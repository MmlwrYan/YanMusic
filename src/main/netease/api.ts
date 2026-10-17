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
import log from '../logger';

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

  // ⚠️ 搜索端点**不给封面**（只有 `album.picId` 数字，无 picUrl），
  // 实测 30 首里 0 首带图。不补的话列表全是占位图。
  // 故这里补一次**批量** detail：实测 30 首一次调用 = 88 KB / 80 ms，代价可接受。
  const withCovers = await enrichCovers(songs);

  return {
    songs: withCovers,
    total,
    hasMore: typeof result.hasMore === 'boolean' ? result.hasMore : offset + songs.length < total,
  };
};

/**
 * 用一次批量 `song/detail` 给搜索结果补封面。
 *
 * ## 失败必须**降级而不是抛错**
 *
 * 封面是展示层信息，缺了只是占位图；若因它抛错，整个搜索会失败 ——
 * 那是**用装饰性信息换掉了核心功能**。所以这里吞掉异常并回退到原列表。
 */
const enrichCovers = async (songs: NeteaseSong[]): Promise<NeteaseSong[]> => {
  if (songs.length === 0) return songs;
  // 已经有封面的（未来上游可能直接给）就不重复请求
  if (songs.every((s) => s.coverUrl)) return songs;

  try {
    const details = await getNeteaseSongDetail(songs.map((s) => s.id));
    if (details.length === 0) return songs;

    const byId = new Map(details.map((d) => [d.id, d]));
    return songs.map((song) => {
      const detail = byId.get(song.id);
      if (!detail) return song;
      // 只补封面（和其它实为空的字段），**不整体替换**：
      // 搜索端点的歌名/歌手有时比 detail 更完整。
      return {
        ...song,
        coverUrl: detail.coverUrl || song.coverUrl,
        cover: detail.cover || song.cover,
        albumName: song.albumName || detail.albumName,
        album: song.album || detail.album,
      };
    });
  } catch (error) {
    // 记一笔即可，不打断搜索（封面缺失只影响观感）
    log.warn('[netease] 补封面失败，列表将使用占位图', {
      count: songs.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return songs;
  }
};

/**
 * 批量取歌曲详情。
 *
 * ## ⚠️ 这两个端点的「贫富」关系与直觉相反（实测更正）
 *
 * 我最初写下的是「`song/detail` 更贫瘠、`al.picUrl` 缺失」—— **这是错的**，
 * 因为我当时只查了 `al` 字段，而本端点给的是**完整 `album` 对象**，里面有 `picUrl`。
 *
 * 实测（2026-10-17，30 首）：
 *
 * | 端点 | 封面 | 歌手 | 备注 |
 * |---|---|---|---|
 * | `/api/search/get` | **0/30** —— 只有 `album.picId`（数字），**没有 picUrl** | 有 | 元数据够，但**拿不到图** |
 * | `/api/song/detail` | **30/30** —— `album.picUrl` 完整 | 有 | 响应 88 KB / 80 ms |
 *
 * ⇒ 所以分工是：**搜索拿列表，detail 补封面**。
 * 封面 URL 无法由 `picId` 直接拼出（CDN 路径含一段 hash，实测裸拼 4 个 host 全 404），
 * 必须靠本端点。
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
  freeTrialPrivilege?: {
    resConsumable?: boolean;
    userConsumable?: boolean;
    listenType?: unknown;
    cannotListenReason?: unknown;
  } | null;
}

/**
 * 取链「拿不到」的原因。
 *
 * ## 实测得出的判据（不要靠 `fee` 猜）
 *
 * 2026-10-17 实测 5 个关键词共 60 首，按 `fee` 分组：
 *
 * | `fee` | `url` | `freeTrialPrivilege.resConsumable` | 结论 |
 * |---|---|---|---|
 * | 0 | 有 | false | 可播 |
 * | 1 | **空** | **true** | 需购买/VIP |
 * | 8 | **有** | false | **可播** |
 *
 * ⚠️ 两个反直觉之处：
 * 1. **`fee=8`（付费专辑）照样给完整 URL** —— 所以 `fee>0` **不能**当作不可播，
 *    必须看响应。按 `fee` 判断会误杀一大批能放的歌。
 * 2. **没有 30 秒试听片段**：`freeTrialInfo` 恒为 `null`，
 *    不可播时直接返回 `url: null`。所以「试听标记」这一项**在数据上不成立**
 *    （原计划里的第 2 项据此取消，而不是漏做）。
 *
 * ⇒ 可播性的唯一可靠判据是「响应里有没有 url」，
 *   `resConsumable === true` 则给出「需购买/权限」这一**具体原因**。
 */
export type NeteaseUnplayableReason = 'need-purchase' | 'unknown';

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

/** 取链成功但所有档位都没有 URL：这是**正常业务结果**，不是异常。 */
export interface NeteaseAudioUrlEmpty {
  url: null;
  reason: NeteaseUnplayableReason;
  /** 是否所有档位都试过了（便于诊断） */
  triedBitrates: number[];
}

/**
 * 取播放链：按 br 从高到低试，**第一个返回非空 URL 即用**。
 *
 * 判据必须是「URL 非空」而不是「请求成功」：不可播时
 * 网易云返回的是 `url: null`，**不是 HTTP 错误**。
 */
export const resolveNeteaseAudioUrl = async (
  id: string | number,
  bitrates: number[],
): Promise<NeteaseAudioUrl | NeteaseAudioUrlEmpty> => {
  let lastError: Error | null = null;
  /** 记录最后一档见到的「不可播原因」，用于给出具体提示。 */
  let lastReason: NeteaseUnplayableReason = 'unknown';

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

    if (!url) {
      // 记住原因：`resConsumable === true` 表示「资源需购买/权限」，
      // 这是实测得出的判据（见 RawSongUrlItem 的注释）。不要用 `fee` 推。
      if (item?.freeTrialPrivilege?.resConsumable === true) {
        lastReason = 'need-purchase';
      }
      continue;
    }

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
  return { url: null, reason: lastReason, triedBitrates: bitrates };
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
