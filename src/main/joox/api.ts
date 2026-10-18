/**
 * JOOX 音源（v2.0.0）—— 经 `apicx.asia` 聚合接口。
 *
 * ## 来源与合规边界
 *
 * 接口事实来自 `docs/reports-for-other-apps/JJ-Music-逆向分析报告.md` §4.3。
 * 与酷我一样：调用该客户端自己使用的公开聚合接口，无签名、无加密、
 * 无 DRM 绕过。服务端下发 CDN 直链，客户端只做播放。
 *
 * ## 相对原客户端的四处修正（都有实测依据）
 *
 * | 原客户端 | 问题 | 本实现 |
 * |---|---|---|
 * | 详情用「关键词 + 序号」 | 序号错位会播错歌 | 用搜索阶段拿到的 **`mid` 精确查询**（接口自述支持 `msg` 或 `mid`） |
 * | 候选以 `Atmos全景声` 打头 | 只要有 Atmos 版本就永远轮不到母带/无损 FLAC | 按**真实音质**重排：母带 → Hi-Res → 无损FLAC → Atmos → 有损 |
 * | 把所有 flac 后缀都标「无损」 | Atmos 是对象音频，被误标成无损 | 按**命中的键名**给标签，Atmos 单独标注 |
 * | token 硬编码在页面里 | 上游吊销后整条线路失效，只能重发版 | token 可由环境变量覆盖，见 `resolveJooxToken` |
 *
 * ## 实测（2026-10-18）
 *
 * - 搜索关键词「晴天」返回 20 条，字段为中文键名（`歌曲名称` / `songmid`…）。
 * - `mid=ZE2F3FF0FB5C62` 返回 **12 档**播放链接，实测 `206` 可播。
 * - `mid` 查询**不返回**歌名/歌手/专辑/歌词，只返回 `播放链接` 字典 ——
 *   所以元数据必须在搜索阶段保留，详情不能反查。
 */

import { networkFetch } from '../networkPolicy';
import log from '../logger';
import { JOOX_PREVIEW_KEY, jooxCandidateKeys, parseJooxDuration } from './parsers';

const JOOX_ENDPOINT = 'https://apicx.asia/api/joox_music';

/**
 * 页面里写死的明文 token。
 *
 * ⚠️ **这是上游前端下发的常量，不是本项目的凭据**。放这里是为了让默认可用，
 * 同时允许 `YANMUSIC_JOOX_TOKEN` 覆盖 —— 原客户端把它硬编码且无刷新机制，
 * 一旦吊销就只能重发版，那是它的一处明确缺陷（报告 §6.3.1）。
 */
const DEFAULT_JOOX_TOKEN = 'f84ao9lMF_q7husBWRfgUw';

export const resolveJooxToken = (): string => {
  const fromEnv = String(process.env.YANMUSIC_JOOX_TOKEN ?? '').trim();
  return fromEnv || DEFAULT_JOOX_TOKEN;
};

const DEFAULT_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_RANGE = 'bytes=0-0';

/* ------------------------------------------------------------------ *
 * 音质候选（纯逻辑在 `./parsers`，可被 `node --test` 直接驱动）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface JooxSong {
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
  source: 'joox';
  /** 搜索阶段拿到的 mid，取链的唯一依据 */
  jooxMid: string;
  hash: '';
  mixSongId: '';
}

export type JooxFailureReason = 'not-found' | 'unavailable' | 'network';

export type JooxPlayResult =
  | {
      ok: true;
      url: string;
      /** 命中的档位键名，如 `母带无损` */
      qualityKey: string;
      isPreview: boolean;
    }
  | { ok: false; reason: JooxFailureReason; message: string };

/* ------------------------------------------------------------------ *
 * 底层请求
 * ------------------------------------------------------------------ */

interface RawJooxSearchItem {
  序号?: number | string;
  歌曲名称?: string;
  歌手?: string;
  专辑?: string;
  /** 形如 `04:29` */
  时长?: string;
  歌曲ID?: string | number;
  songmid?: string;
}

interface JooxEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

const callJoox = async <T>(params: Record<string, string>): Promise<T | null> => {
  const query = new URLSearchParams({ ...params, token: resolveJooxToken() }).toString();
  const url = `${JOOX_ENDPOINT}?${query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await networkFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();
    if (!text.trim()) return null;

    let payload: JooxEnvelope<T>;
    try {
      payload = JSON.parse(text) as JooxEnvelope<T>;
    } catch {
      log.warn('[joox] 响应不是 JSON', { length: text.length, head: text.slice(0, 60) });
      return null;
    }

    // 成功判据是 `code === 200`（与 HTTP 状态无关）。
    if (payload.code !== 200) {
      log.warn('[joox] 业务失败', { code: payload.code, msg: payload.msg });
      return null;
    }
    return (payload.data ?? null) as T | null;
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new Error(
      isAbort ? `JOOX 接口超时（${DEFAULT_TIMEOUT_MS}ms）` : `JOOX 接口失败：${String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

/** JOOX 搜索响应**不提供封面**，故 `coverUrl` 留空，由列表用占位图。 */
const mapRawJooxItem = (raw: RawJooxSearchItem): JooxSong | null => {
  const title = String(raw.歌曲名称 ?? '').trim();
  const mid = String(raw.songmid ?? '').trim();
  if (!title || !mid) return null;

  const singer = String(raw.歌手 ?? '').trim();
  const album = String(raw.专辑 ?? '').trim() || undefined;

  return {
    id: `joox:${mid}`,
    songId: mid,
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
    // 搜索接口不给封面；硬拼 CDN 路径不可靠（实测无稳定规则），留空更诚实。
    coverUrl: '',
    cover: '',
    duration: parseJooxDuration(raw.时长),
    source: 'joox',
    jooxMid: mid,
    hash: '',
    mixSongId: '',
  };
};

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

export interface JooxSearchResult {
  songs: JooxSong[];
  total: number;
  hasMore: boolean;
}

/**
 * 搜索歌曲。
 *
 * `br=4` 是搜索阶段请求的档位（原客户端固定传 4）。**搜索不返回播放链接**，
 * 所以这个参数对结果没有实质影响，但实测缺它会改变响应形态，故照传。
 */
export const searchJoox = async (keywords: string, limit = 30): Promise<JooxSearchResult> => {
  const data = await callJoox<{ count?: number; songs?: RawJooxSearchItem[] }>({
    msg: keywords,
    br: '4',
  });

  const rawList: RawJooxSearchItem[] = data && Array.isArray(data.songs) ? data.songs : [];
  const songs = rawList
    .map(mapRawJooxItem)
    .filter((s): s is JooxSong => s !== null)
    // 上游不支持 limit 参数（固定 20 条），这里在本地截断，保持各音源行为一致。
    .slice(0, limit);

  const count = typeof data?.count === 'number' ? data.count : rawList.length;
  return { songs, total: count, hasMore: count > songs.length };
};

/* ------------------------------------------------------------------ *
 * 取链
 * ------------------------------------------------------------------ */

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
    return response.ok || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 取播放地址。
 *
 * 用 `mid` 精确查询（**不是**关键词 + 序号）。返回的 `播放链接` 是一个
 * 含 12 档的字典，本函数按 `jooxCandidateKeys` 的顺序逐个探测，
 * 第一个返回 2xx 的即用。
 *
 * ⚠️ 探测次数直接影响点播延迟：最坏情况 12 次。故候选顺序按**真实命中率**
 * 排（无损在前，短片段在最后），实测常见曲目第一次就命中。
 */
export const resolveJooxPlayUrl = async (
  mid: string,
  quality?: string,
): Promise<JooxPlayResult> => {
  const songMid = String(mid ?? '').trim();
  if (!songMid) return { ok: false, reason: 'not-found', message: '缺少 songmid' };

  let data: { songmid?: string; 播放链接?: Record<string, string> } | null;
  try {
    data = await callJoox<{ songmid?: string; 播放链接?: Record<string, string> }>({
      mid: songMid,
      br: '4',
    });
  } catch (error) {
    log.warn('[joox] 详情请求失败', {
      mid: songMid,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'network', message: 'JOOX 接口无响应' };
  }

  const links = data?.播放链接;
  if (!links || typeof links !== 'object') {
    return { ok: false, reason: 'unavailable', message: '该曲目未返回任何播放链接（可能已下架）' };
  }

  for (const key of jooxCandidateKeys(quality)) {
    const url = String(links[key] ?? '').trim();
    if (!url) continue;
    if (!(await probeUrl(url))) {
      log.warn('[joox] 档位探测失败，继续下一档', { mid: songMid, key });
      continue;
    }
    return { ok: true, url, qualityKey: key, isPreview: key === JOOX_PREVIEW_KEY };
  }

  return {
    ok: false,
    reason: 'unavailable',
    message: '所有档位的播放链接均不可取（可能已过期或被限制）',
  };
};
