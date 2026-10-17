import type { Song, SongRelateGood } from '@/models/song';

export interface SongPrivilegeTag {
  label: string;
  color: string;
  message: string;
}

export interface SongDerivedState {
  isVip: boolean;
  isPaid: boolean;
  isNoCopyright: boolean;
  isUnavailable: boolean;
  canPlay: boolean;
  isPlayable: boolean;
  unavailableMessage: string | null;
  qualityTag: string;
  privilegeTags: SongPrivilegeTag[];
}

const QUALITY_LABEL_MAP: Record<string, string> = {
  super: 'DSD',
  high: 'Hi-Res',
  flac: 'SQ',
  '320': 'HQ',
};

const EFFECT_QUALITIES = new Set([
  'piano',
  'vocal',
  'accompaniment',
  'subwoofer',
  'ancient',
  'surnay',
  'dj',
  'viper_tape',
  'viper_atmos',
  'viper_clear',
]);

const AUDIO_QUALITY_ORDER: Array<'128' | '320' | 'flac' | 'high' | 'super'> = [
  '128',
  '320',
  'flac',
  'high',
  'super',
];

/**
 * VIP / 付费判定。
 *
 * ## 网易云分支（v2.0.0）：靠 `fee`，因为**没有** `privilege`/`payType`
 *
 * 酷狗用 `privilege` + `payType` 表达权益；网易云的搜索端点不返回这两个字段，
 * 它给的是 `fee`。若不补这一支，网易云的付费/VIP 曲目在本项目里
 * **永远被当成免费歌**，于是「不可播」时只会给出笼统的「暂时无法获取可用音源」，
 * 用户不知道是自己没买还是真没版权。
 *
 * ## ⚠️ `fee` 只用于**提示**，绝不用于判定能不能播
 *
 * 2026-10-17 实测（5 个关键词 60 首，按 `fee` 分组）：
 *
 * | `fee` | 取链结果 | 含义 |
 * |---|---|---|
 * | 0 | 有 url | 免费可播 |
 * | 1 | **url 为空** + `resConsumable: true` | 需购买/VIP |
 * | 8 | **有 url**（完整 12 MB） | **付费但可播** |
 *
 * ⇒ `fee === 8` 的歌**照样能放**。若拿 `fee` 去卡可播性，会**误杀一大批能放的歌**。
 * 因此这里只把它映射成「提示标签」，可播性仍由**取链结果**决定
 * （见 `neteaseSource.ts` 与 `canPlaySong` 的注释）。
 */
export const isVipSong = (song: Song): boolean =>
  (song.privilege === 10 && song.payType === 3) || song.fee === 1;

export const isPaidSong = (song: Song): boolean =>
  (song.privilege === 10 && song.payType === 2) || song.fee === 4 || song.fee === 8;

export const isNoCopyrightSong = (song: Song): boolean => song.privilege === 5;

export const isUnavailableSong = (song: Song): boolean => song.privilege === 40;

export const canPlaySong = (song: Song): boolean => {
  if (isUnavailableSong(song)) return false;
  if (isNoCopyrightSong(song)) return song.oldCpy === 1;
  return true;
};

/**
 * 该曲目**具备取链依据**（不代表一定取得到，取链结果才是最终判据）。
 *
 * ## 为什么网易云要单独一条（v2.0.0 的一个真 bug）
 *
 * 原判据是 `hash || audioUrl` —— 这是**酷狗形状**的假设：酷狗曲目一进列表就带 `hash`，
 * 网易云曲目两者都是空：
 * - `hash` 恒为空（网易云没有酷狗 hash，靠 `songId`）；
 * - `audioUrl` 是**懒解析**的，播放前本来就是空。
 *
 * 于是网易云曲目一律被判为「不可播」，`resolvePlayableQueue` 把它们**整个过滤掉**
 * 并回退到队列里第一首酷狗歌 —— 用户看到的现象是：
 * **点了网易云的歌，却播放了另一首（上一次队列里的酷狗曲目）**。
 * 更糟的是**日志里一行 netease 都没有**，因为请求根本没发出去。
 *
 * ⇒ 网易云曲目的可播性只能由**取链结果**决定（`neteaseSource.ts` 负责），
 * 这里只判断「有没有取链依据」，所以对网易云直接放行。
 */
const hasResolvableSource = (song: Song): boolean =>
  song.source === 'netease' ? true : Boolean(song.hash?.trim() || song.audioUrl?.trim());

export const isPlayableSong = (song: Song): boolean =>
  hasResolvableSource(song) && canPlaySong(song);

export const isSameSong = (left: Song, right: Song): boolean => {
  const leftMixSongId = String(left.mixSongId ?? '0');
  const rightMixSongId = String(right.mixSongId ?? '0');
  if (leftMixSongId !== '0' && rightMixSongId !== '0' && leftMixSongId === rightMixSongId) {
    return true;
  }

  const leftHash = String(left.hash ?? '')
    .trim()
    .toLowerCase();
  const rightHash = String(right.hash ?? '')
    .trim()
    .toLowerCase();
  if (leftHash && rightHash && leftHash === rightHash) {
    return true;
  }

  return false;
};

export const getSongPrivilegeTags = (song: Song): SongPrivilegeTag[] => {
  const tags: SongPrivilegeTag[] = [];

  if (isPaidSong(song)) {
    tags.push({ label: '付费', color: '#EF4444', message: '需要购买' });
  }
  if (isVipSong(song)) {
    tags.push({ label: 'VIP', color: '#F59E0B', message: '需要VIP' });
  }
  if (!isPlayableSong(song) && isNoCopyrightSong(song)) {
    tags.push({ label: '版权', color: '#8B5CF6', message: '无版权' });
  }
  if (isUnavailableSong(song)) {
    tags.push({ label: '音源', color: '#6B7280', message: '不可用' });
  }

  return tags;
};

export const getSongUnavailableMessage = (song: Song): string | null => {
  if (isPlayableSong(song)) return null;
  if (isPaidSong(song)) return '需要购买';
  if (isNoCopyrightSong(song)) return '无版权';
  if (isUnavailableSong(song)) return '不可用';
  return '暂无音源';
};

export const getSongQualityTag = (song: Pick<Song, 'relateGoods'>): string => {
  const goods = song.relateGoods ?? [];
  const hasQuality = (quality: string, level: number) =>
    goods.some((item: SongRelateGood) => item.quality === quality || item.level === level);

  if (hasQuality('super', 7)) return 'DSD';
  if (hasQuality('high', 6)) return 'Hi-Res';
  if (hasQuality('flac', 5)) return 'SQ';
  if (hasQuality('320', 4)) return 'HQ';
  return '';
};

export const getSongQualityTags = (relateGoods: SongRelateGood[] | undefined): string[] => {
  if (!relateGoods?.length) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of relateGoods) {
    const quality = item.quality ?? '';
    const normalized = QUALITY_LABEL_MAP[quality] ?? '';
    if (!normalized || EFFECT_QUALITIES.has(quality) || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
};

export const getSongEffectTags = (relateGoods: SongRelateGood[] | undefined): string[] => {
  if (!relateGoods?.length) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of relateGoods) {
    const quality = item.quality ?? '';
    if (!quality || !EFFECT_QUALITIES.has(quality) || seen.has(quality)) continue;
    seen.add(quality);
    tags.push(quality);
  }
  return tags;
};

export const doesRelateGoodMatchQuality = (
  item: SongRelateGood,
  quality: '128' | '320' | 'flac' | 'high' | 'super',
): boolean => {
  if (quality === '128') return true;

  const normalizedQuality = String(item.quality ?? '')
    .trim()
    .toLowerCase();
  const level = item.level;

  if (quality === '320') {
    return normalizedQuality === '320' || normalizedQuality === 'hq' || level === 4;
  }

  if (quality === 'flac') {
    return normalizedQuality === 'flac' || normalizedQuality === 'sq' || level === 5;
  }

  if (quality === 'high') {
    return (
      normalizedQuality === 'high' ||
      normalizedQuality === 'hires' ||
      normalizedQuality === 'hi-res' ||
      normalizedQuality === 'res' ||
      level === 6
    );
  }

  // super (DSD)
  return normalizedQuality === 'super' || normalizedQuality === 'dsd' || level === 7;
};

export const hasSongQuality = (
  song: Pick<Song, 'relateGoods'>,
  quality: '128' | '320' | 'flac' | 'high' | 'super',
): boolean => {
  if (quality === '128') return true;
  const goods = song.relateGoods ?? [];
  return goods.some((item: SongRelateGood) => doesRelateGoodMatchQuality(item, quality));
};

export const getAvailableSongQualities = (
  song: Pick<Song, 'relateGoods'>,
): Array<'128' | '320' | 'flac' | 'high' | 'super'> => {
  const result: Array<'128' | '320' | 'flac' | 'high' | 'super'> = ['128'];
  if (hasSongQuality(song, '320')) result.push('320');
  if (hasSongQuality(song, 'flac')) result.push('flac');
  if (hasSongQuality(song, 'high')) result.push('high');
  if (hasSongQuality(song, 'super')) result.push('super');
  return result;
};

export const getSongQualityCandidates = (
  preferred: '128' | '320' | 'flac' | 'high' | 'super',
  compatibilityMode = true,
): Array<'128' | '320' | 'flac' | 'high' | 'super'> => {
  const normalized = AUDIO_QUALITY_ORDER.includes(preferred) ? preferred : '128';
  const index = AUDIO_QUALITY_ORDER.indexOf(normalized);
  if (!compatibilityMode) return [normalized];
  return AUDIO_QUALITY_ORDER.slice(0, index + 1).reverse() as Array<
    '128' | '320' | 'flac' | 'high' | 'super'
  >;
};

export const resolveEffectiveSongQuality = (
  song: Pick<Song, 'relateGoods'>,
  preferred: '128' | '320' | 'flac' | 'high' | 'super',
  compatibilityMode = true,
): '128' | '320' | 'flac' | 'high' | 'super' => {
  const goods = song.relateGoods ?? [];
  if (goods.length === 0) return preferred;

  const candidates = getSongQualityCandidates(preferred, compatibilityMode);
  for (const quality of candidates) {
    if (hasSongQuality(song, quality)) return quality;
  }

  const available = getAvailableSongQualities(song);
  return available[available.length - 1] ?? '128';
};

export const getSongDerivedState = (song: Song): SongDerivedState => {
  const isVip = isVipSong(song);
  const isPaid = isPaidSong(song);
  const isNoCopyright = isNoCopyrightSong(song);
  const isUnavailable = isUnavailableSong(song);
  const canPlay = canPlaySong(song);
  const isPlayable = isPlayableSong(song);
  const unavailableMessage = getSongUnavailableMessage(song);
  const qualityTag = getSongQualityTag(song);
  const privilegeTags = getSongPrivilegeTags(song);

  return {
    isVip,
    isPaid,
    isNoCopyright,
    isUnavailable,
    canPlay,
    isPlayable,
    unavailableMessage,
    qualityTag,
    privilegeTags,
  };
};

export const hasUsableSongHash = (song: Song): boolean => Boolean(String(song.hash ?? '').trim());

export const isMeaninglessHashlessSong = (song: Song): boolean => {
  const title = String(song.name ?? '').trim();
  const artist = String(song.artist ?? '').trim();
  const album = String(song.album ?? '').trim();
  const cover = String(song.coverUrl ?? '').trim();
  const hash = String(song.hash ?? '').trim();
  const mixSongId = String(song.mixSongId ?? '0').trim();
  const artists = song.artists ?? [];

  return (
    !hash &&
    !title &&
    !artist &&
    artists.length === 0 &&
    !album &&
    !cover &&
    (!mixSongId || mixSongId === '0')
  );
};

export const shouldFilterInvalidSong = (song: Song): boolean => {
  return isMeaninglessHashlessSong(song) || !hasUsableSongHash(song);
};

export const splitValidSongs = (songs: Song[]): { songs: Song[]; filteredCount: number } => {
  const validSongs: Song[] = [];
  let filteredCount = 0;

  for (const song of songs) {
    if (shouldFilterInvalidSong(song)) {
      filteredCount += 1;
      continue;
    }
    validSongs.push(song);
  }

  return {
    songs: validSongs,
    filteredCount,
  };
};
