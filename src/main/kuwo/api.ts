/**
 * 酷我音源（v2.0.0）—— 经 `oiapi.net` 聚合接口。
 *
 * ## 来源与合规边界
 *
 * 本模块的接口事实来自对 **JJ Music** 的逆向报告
 * （`docs/reports-for-other-apps/JJ-Music-逆向分析报告.md` §4.2）。
 * 它调用的是该客户端**自己使用的同一条公开聚合接口**，不含任何签名、
 * 加密或私有凭据；服务端下发的是上游签发的 CDN 直链，客户端侧
 * **没有解密环节**，因此本实现也不涉及、不需要任何解密或权益绕过。
 *
 * ## 为什么不照抄原客户端（五处实测修正）
 *
 * | 原客户端做法 | 问题 | 本实现 |
 * |---|---|---|
 * | 固定 `br=1` | 上游为「曲目+码率」缓存签名，过期后返回 **410**，且**不会自动刷新** | `br=1 → 2` 逐档降级，并对直链做 Range 探测 |
 * | 详情用「原关键词 + 序号」 | 上游结果顺序一变，`n` 指向另一首歌（**播错歌**） | 用「歌名 歌手」重查，并用响应里的 `rid` 与目标比对 |
 * | 从不校验 `rid` | 同上，且错播时无任何迹象 | `rid` 不一致就换下一个 `n` |
 * | 直链直接赋给 `audio.src` | 直链是 `http://`，在 https 页面里属混合内容 | 统一升级为 `https://`（实测该主机 https 可用） |
 * | 音质标签按后缀猜 | 非无损一律标 "320K"，192K 的 OGG 也显示 320 | 用响应里的 `format` + `bitrate` 推导 |
 *
 * ## 实测记录（2026-10-18）
 *
 * - `br=1` → FLAC 2000；`br=2` → OGG 192；**`br=3` 返回空响应**（故只试 1、2）。
 * - 「晴天 / 周杰伦」的 `br=1` 直链签发自 2026-10-02，实测持续 `410 Gone`；
 *   同一首的 `br=2` 是新签发的，`206` 可用 —— 这就是降级链必须存在的直接证据。
 * - 「夜曲 / 周杰伦」的 `br=1` 为当次新签，`206` 可用 —— 证明**优先试最高档
 *   并不会误伤**，降级只在真的不可用时发生。
 */

import { networkFetch } from '../networkPolicy';
import log from '../logger';

/** 聚合接口基址。 */
const KUWO_ENDPOINT = 'https://oiapi.net/api/Kuwo';

/**
 * 直链探测用的 Range 头：只要 1 字节。
 *
 * 用 `Range` 而不是 `HEAD`：实测 CDN 对 `HEAD` 的响应不一致
 * （部分节点直接 405），而 `Range: bytes=0-0` 返回 `206` 且**只传 1 字节**。
 */
const PROBE_RANGE = 'bytes=0-0';

const DEFAULT_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 8_000;

/** 一次「定位 + 取链」最多往后找几个候选（防跑飞）。 */
const MAX_CANDIDATE_INDEX = 4;

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 与 `src/renderer/models/song.ts` 的 `Song` 兼容的子集。 */
export interface KuwoSong {
  id: string;
  songId: string;
  title: string;
  name: string;
  artist: string;
  artists: { id: string; name: string }[];
  albumName?: string;
  album?: string;
  coverUrl: string;
  cover: string;
  /** 秒 */
  duration: number;
  source: 'kuwo';
  /** 接口给的原始 rid（形如 `MUSIC_228908`），取链时用于校验身份 */
  kuwoRid: string;
  hash: '';
  mixSongId: '';
}

export type KuwoFailureReason = 'not-found' | 'unavailable' | 'network';

export type KuwoPlayResult =
  | {
      ok: true;
      url: string;
      /** 服务端实际下发的档位（`flac` / `ogg` / `mp3`…），诊断与标签用 */
      format: string;
      /** 实际码率（kbps） */
      bitrate?: number;
      /** 实际命中的 br 档位（1=最高，2=次高档） */
      br: number;
    }
  | { ok: false; reason: KuwoFailureReason; message: string };

/* ------------------------------------------------------------------ *
 * 底层请求
 * ------------------------------------------------------------------ */

interface KuwoEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

/** 上游 `data` 的原始形状（搜索项与详情项同构，详情多 `url`）。 */
interface RawKuwoItem {
  song?: string;
  singer?: string;
  album?: string;
  rid?: string;
  picture?: string;
  /** 秒（字符串） */
  time?: string;
  level?: string;
  format?: string;
  bitrate?: string;
  url?: string;
}

const withTimeout = async <T>(
  what: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new Error(
      isAbort ? `酷我接口超时（${what}，${DEFAULT_TIMEOUT_MS}ms）` : `酷我接口失败（${what}）`,
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 发一次 GET 并解析 JSON。
 *
 * ⚠️ 上游的成功判据是 **`code === 1`**（不是 0，也不是 HTTP 状态）。
 * 只看 HTTP 会把「参数错 / 风控」当成「没搜到」，排查方向整个跑偏。
 */
const callKuwo = async <T>(params: Record<string, string>): Promise<T | null> => {
  const query = new URLSearchParams(params).toString();
  const url = `${KUWO_ENDPOINT}?${query}`;

  return withTimeout('query', async (signal) => {
    const response = await networkFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.trim()) return null;
    let payload: KuwoEnvelope<T>;
    try {
      payload = JSON.parse(text) as KuwoEnvelope<T>;
    } catch {
      // 上游异常时可能返回 HTML 错误页；当成「无数据」而不是抛出，
      // 让上层给出「没找到」而不是「接口挂了」—— 但记一笔便于定位。
      log.warn('[kuwo] 响应不是 JSON', { length: text.length, head: text.slice(0, 60) });
      return null;
    }
    if (payload.code !== 1) return null;
    return (payload.data ?? null) as T | null;
  });
};

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

/** 纯解析函数已抽到 `./parsers`（可脱离 electron 被 `node --test` 直接驱动）。 */
import { normalizeKuwoRid, parseKuwoUrlMeta, upgradeKuwoUrl } from './parsers';

const mapRawItem = (raw: RawKuwoItem): KuwoSong | null => {
  const title = String(raw.song ?? '').trim();
  const rid = String(raw.rid ?? '').trim();
  if (!title || !rid) return null;

  const singer = String(raw.singer ?? '').trim();
  const album = String(raw.album ?? '').trim() || undefined;
  const cover = String(raw.picture ?? '').trim();
  const durationRaw = Number.parseInt(String(raw.time ?? ''), 10);

  // `id` 用 `kuwo:<rid>`：与酷狗的纯 hash、网易云的纯数字 id 都不冲突，
  // 便于日志里一眼看出曲目来自哪个源。
  const id = `kuwo:${rid}`;

  return {
    id,
    songId: rid,
    title,
    name: title,
    artist: singer || '未知歌手',
    artists: singer
      ? singer
          .split(/[、,&/]/)
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => ({ id: '', name }))
      : [],
    albumName: album,
    album,
    coverUrl: cover,
    cover,
    duration: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0,
    source: 'kuwo',
    kuwoRid: rid,
    hash: '',
    mixSongId: '',
  };
};

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

export interface KuwoSearchResult {
  songs: KuwoSong[];
  total: number;
  hasMore: boolean;
}

/**
 * 搜索歌曲。
 *
 * 上游一次给一页（`page` + `limit`），`data` 是数组。
 * 接口**不返回总数**，故 `total` 用「本页条数」估算，
 * `hasMore` 用「本页是否满员」判断 —— 比编一个假的总数诚实。
 */
export const searchKuwo = async (
  keywords: string,
  limit = 30,
  page = 1,
): Promise<KuwoSearchResult> => {
  const list = await callKuwo<RawKuwoItem[]>({
    msg: keywords,
    page: String(page),
    limit: String(limit),
  });

  const songs = (Array.isArray(list) ? list : [])
    .map(mapRawItem)
    .filter((s): s is KuwoSong => s !== null);

  return {
    songs,
    total: songs.length,
    hasMore: songs.length >= limit,
  };
};

/* ------------------------------------------------------------------ *
 * 取链
 * ------------------------------------------------------------------ */

/** 探测直链是否真的能取到字节。返回 true 表示 2xx。 */
const probeUrl = async (url: string): Promise<boolean> => {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await networkFetch(url, {
      method: 'GET',
      headers: { Range: PROBE_RANGE },
      signal: controller.signal,
    });
    // 200/206 都算可用。410 是「签名过期」，403 是「防盗链」，都不是。
    return response.ok || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** 取一次详情（单个 n / 单个 br）。网络层失败会抛错；上游明确无数据返回 null。 */
const fetchDetail = async (
  keywords: string,
  index: number,
  br: 1 | 2,
): Promise<{ item: RawKuwoItem; url: string; br: number } | null> => {
  const data = await callKuwo<RawKuwoItem>({
    msg: keywords,
    n: String(index),
    br: String(br),
  });
  if (!data) return null;
  const url = upgradeKuwoUrl(String(data.url ?? '').trim());
  if (!url) return null;
  return { item: data, url, br };
};

/**
 * 取播放地址。
 *
 * ## 流程（每一步都有实测依据，见文件头表格）
 *
 * 1. 用「**歌名 + 歌手**」作为关键词重查，而不是用「原关键词 + 原序号」——
 *    后者在上游结果顺序变化时会指向另一首歌。
 * 2. 校验响应里的 `rid`：与目标的 `rid` 不一致就换下一个序号（最多 4 个）。
 * 3. 命中后先试 `br=1`（FLAC 2000）并**探测**；探测不过再试 `br=2`（OGG 192）。
 * 4. 都不行 → 返回结构化失败，不抛异常（上层据此给「不可播」而非「接口挂了」）。
 */
export const resolveKuwoPlayUrl = async (song: {
  title: string;
  artist: string;
  kuwoRid?: string;
}): Promise<KuwoPlayResult> => {
  const title = String(song.title ?? '').trim();
  const artist = String(song.artist ?? '').trim();
  if (!title) return { ok: false, reason: 'not-found', message: '缺少歌名，无法定位曲目' };

  const expectedRid = normalizeKuwoRid(song.kuwoRid);
  // 「歌名 歌手」是接口文档要求的形态；没有歌手时退回纯歌名。
  const keywords = artist && !artist.includes('未知') ? `${title} ${artist}` : title;

  for (let index = 1; index <= MAX_CANDIDATE_INDEX; index += 1) {
    let first: Awaited<ReturnType<typeof fetchDetail>>;
    try {
      first = await fetchDetail(keywords, index, 1);
    } catch (error) {
      log.warn('[kuwo] 详情请求失败', {
        keywords,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      // 第一个候选就连不上 → 是网络问题，不是「没这首歌」。
      if (index === 1) {
        return { ok: false, reason: 'network', message: '酷我接口无响应' };
      }
      // 后续候选失败：前面已经确认过接口可达，按「候选已尽」处理更稳。
      break;
    }

    if (!first) {
      // 上游对该序号返回空 data —— 候选已尽（不是错误）。
      break;
    }

    // rid 校验：只在两边都能拿到 rid 时比对，避免因字段缺失误杀。
    const gotRid = normalizeKuwoRid(first.item.rid);
    if (expectedRid && gotRid && gotRid !== expectedRid) {
      log.warn('[kuwo] 候选 rid 不匹配，继续找下一个序号', {
        expected: expectedRid,
        got: gotRid,
        index,
      });
      continue;
    }

    if (await probeUrl(first.url)) {
      const meta = parseKuwoUrlMeta(first.url);
      return {
        ok: true,
        url: first.url,
        format: meta.format ?? String(first.item.format ?? ''),
        bitrate: meta.bitrate ?? (Number(first.item.bitrate) || undefined),
        br: 1,
      };
    }

    // br=1 不可用（典型原因：上游缓存了过期签名，实测 `410 Gone`）→ 降级到 br=2
    let second: Awaited<ReturnType<typeof fetchDetail>> = null;
    try {
      second = await fetchDetail(keywords, index, 2);
    } catch (error) {
      log.warn('[kuwo] 次高档请求失败', {
        keywords,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (second && (await probeUrl(second.url))) {
      const meta = parseKuwoUrlMeta(second.url);
      log.info('[kuwo] 最高档不可用，已降级到次高档', {
        title,
        br: 2,
        format: meta.format,
        bitrate: meta.bitrate,
      });
      return {
        ok: true,
        url: second.url,
        format: meta.format ?? String(second.item.format ?? ''),
        bitrate: meta.bitrate ?? (Number(second.item.bitrate) || undefined),
        br: 2,
      };
    }

    return {
      ok: false,
      reason: 'unavailable',
      message: '该曲目的所有可用档位均无法取到（直链签名可能已过期或被限流）',
    };
  }

  return { ok: false, reason: 'not-found', message: '未定位到该曲目（酷我侧可能无此歌或已下架）' };
};
