/**
 * 听歌档案（C2）纯逻辑层：播放事件的采集、归一化、裁剪、聚合与情绪标签。
 *
 * 设计约束（依赖快照，2026-09-21）：
 *  - `yan-storage` 的 `play_history` 是「一曲一行」（`native/yan-storage/src/lib.rs:1366-1376`
 *    的 `ON CONFLICT(song_key) DO UPDATE`），只保留 `last_played_at` 与 `play_count`，
 *    **不存在逐次播放事件日志**。因此档案必须自行采集事件。
 *  - 历史存量无法还原真实时间点，只能合成为「近似基线」：每曲一条事件、
 *    时间取 `last_played_at`、次数记在 `baselinePlayCount`，并以 `synthetic: true` 显式标记。
 *    **不得把一个总次数摊开成多个伪造时间点**。
 *  - 本文件不依赖 Electron / Vue / Node 专有 API，可被 `node --test` 直接导入。
 */

export const MUSIC_JOURNAL_SCHEMA_VERSION = 1;
/** 事件上限：超出时保留最新的若干条，避免无限增长。 */
export const MUSIC_JOURNAL_MAX_EVENTS = 2000;
/** 基线合成上限：历史条目过多时只取最近的一批。 */
export const MUSIC_JOURNAL_BASELINE_MAX_EVENTS = 500;

export type JournalEventSource = 'kugou' | 'local' | 'plugin' | 'unknown';

export interface JournalPlayEvent {
  id: string;
  songKey: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  /** epoch 毫秒 */
  playedAt: number;
  source: JournalEventSource;
  /** true = 由既有 play_history 合成的近似基线，不是精确播放时刻 */
  synthetic: boolean;
  /** 仅合成事件使用：历史累计播放次数 */
  baselinePlayCount: number;
  /** 用户手动标注的情绪标签（不做自动推断） */
  mood?: string;
}

export interface MusicJournalState {
  schemaVersion: number;
  events: JournalPlayEvent[];
  baselineSynthesized: boolean;
}

const SOURCES: readonly JournalEventSource[] = ['kugou', 'local', 'plugin', 'unknown'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const toNonNegativeInt = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
};

const isValidTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const normalizeSource = (value: unknown): JournalEventSource => {
  const text = readText(value).toLowerCase();
  return (SOURCES as readonly string[]).includes(text) ? (text as JournalEventSource) : 'unknown';
};

const byPlayedAtDesc = (left: JournalPlayEvent, right: JournalPlayEvent): number =>
  right.playedAt - left.playedAt;

const sortAndCap = (events: JournalPlayEvent[], max: number): JournalPlayEvent[] =>
  [...events].sort(byPlayedAtDesc).slice(0, Math.max(0, Math.floor(max)));

/** 把任意外部输入归一化为合法事件；非法输入返回 null。 */
const normalizeEvent = (raw: unknown): JournalPlayEvent | null => {
  if (!isPlainObject(raw)) return null;

  const id = readText(raw.id);
  const songKey = readText(raw.songKey);
  if (!id || !songKey) return null;
  if (!isValidTimestamp(raw.playedAt)) return null;

  const mood = normalizeMoodText(raw.mood);
  return {
    id,
    songKey,
    title: readText(raw.title) || '未知曲目',
    artist: readText(raw.artist) || '未知歌手',
    album: readText(raw.album),
    durationSec: toNonNegativeInt(raw.durationSec),
    playedAt: Math.floor(raw.playedAt),
    source: normalizeSource(raw.source),
    synthetic: raw.synthetic === true,
    baselinePlayCount: toNonNegativeInt(raw.baselinePlayCount),
    ...(mood ? { mood } : {}),
  };
};

export const createEmptyJournalState = (): MusicJournalState => ({
  schemaVersion: MUSIC_JOURNAL_SCHEMA_VERSION,
  events: [],
  baselineSynthesized: false,
});

/**
 * 归一化持久化状态。
 * 约定：非对象（含数组/标量/null）一律回落为空状态；事件逐条校验，
 * 丢弃非法项、按时间倒序、裁剪到上限。
 */
export const normalizeJournalState = (raw: unknown): MusicJournalState => {
  if (!isPlainObject(raw)) return createEmptyJournalState();

  const rawEvents = Array.isArray(raw.events) ? raw.events : [];
  const events: JournalPlayEvent[] = [];
  const seen = new Set<string>();
  for (const item of rawEvents) {
    const event = normalizeEvent(item);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }

  return {
    schemaVersion: MUSIC_JOURNAL_SCHEMA_VERSION,
    events: sortAndCap(events, MUSIC_JOURNAL_MAX_EVENTS),
    baselineSynthesized: raw.baselineSynthesized === true,
  };
};

/** 从播放曲目构造事件；曲目/时间非法时返回 null。 */
export const createPlayEvent = (song: unknown, playedAt: number): JournalPlayEvent | null => {
  if (!isPlainObject(song)) return null;
  if (!isValidTimestamp(playedAt)) return null;

  const songKey = readText(song.mixSongId) || readText(song.id) || readText(song.fileId);
  if (!songKey) return null;

  const timestamp = Math.floor(playedAt);
  return {
    id: `${songKey}:${timestamp}`,
    songKey,
    title: readText(song.title) || readText(song.name) || '未知曲目',
    artist: readText(song.artist) || '未知歌手',
    album: readText(song.albumName) || readText(song.album),
    durationSec: toNonNegativeInt(song.duration),
    playedAt: timestamp,
    source: normalizeSource(song.source),
    synthetic: false,
    baselinePlayCount: 0,
  };
};

/**
 * 追加事件：按 id 幂等、保持时间倒序、裁剪到上限。
 * 返回新数组，不修改入参。
 */
export const appendJournalEvent = (
  events: readonly JournalPlayEvent[],
  event: JournalPlayEvent | null,
  max: number = MUSIC_JOURNAL_MAX_EVENTS,
): JournalPlayEvent[] => {
  const current = normalizeJournalState({ events }).events;
  const next = normalizeEvent(event);
  if (!next) return current;
  if (current.some((item) => item.id === next.id)) return current;
  return sortAndCap([...current, next], max);
};

/**
 * 由既有 play_history 条目合成近似基线。
 *
 * 条目形状（见 `native/yan-storage/src/lib.rs:869-920` 的 history_entry_from_row）：
 *   { historyKey, lastPlayedAt, playCount, song }
 * 只有 `lastPlayedAt > 0` 且能取出 songKey 的条目才会被合成。
 */
export const synthesizeBaselineEvents = (
  entries: unknown,
  max: number = MUSIC_JOURNAL_BASELINE_MAX_EVENTS,
): JournalPlayEvent[] => {
  if (!Array.isArray(entries)) return [];

  const result: JournalPlayEvent[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;

    const lastPlayedAt = entry.lastPlayedAt;
    if (!isValidTimestamp(lastPlayedAt) || lastPlayedAt <= 0) continue;

    const song = isPlainObject(entry.song) ? entry.song : {};
    const songKey =
      readText(song.mixSongId) ||
      readText(song.id) ||
      readText(song.fileId) ||
      readText(entry.historyKey).split(':')[0] ||
      '';
    if (!songKey) continue;

    const playedAt = Math.floor(lastPlayedAt);
    const event = normalizeEvent({
      id: `baseline:${songKey}:${playedAt}`,
      songKey,
      title: readText(song.title) || readText(song.name),
      artist: readText(song.artist),
      album: readText(song.albumName) || readText(song.album),
      durationSec: song.duration,
      playedAt,
      source: song.source,
      synthetic: true,
      baselinePlayCount: Math.max(1, toNonNegativeInt(entry.playCount)),
    });
    if (event) result.push(event);
  }

  return sortAndCap(result, max);
};

export interface JournalSummary {
  totalPlays: number;
  distinctSongs: number;
  syntheticEvents: number;
  realEvents: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
}

/**
 * 汇总统计。
 * 计权规则：合成事件按 `baselinePlayCount` 计入（它代表历史累计次数），
 * 真实事件每次计 1 —— 这样「总次数」不失真，而时间轴上的位置仍以 `synthetic` 标记为近似。
 */
export const summarizeJournal = (events: readonly JournalPlayEvent[]): JournalSummary => {
  const valid = normalizeJournalState({ events }).events;
  const songKeys = new Set<string>();
  let totalPlays = 0;
  let syntheticEvents = 0;
  let realEvents = 0;
  let firstPlayedAt: number | null = null;
  let lastPlayedAt: number | null = null;

  for (const event of valid) {
    songKeys.add(event.songKey);
    if (event.synthetic) {
      syntheticEvents += 1;
      totalPlays += event.baselinePlayCount;
    } else {
      realEvents += 1;
      totalPlays += 1;
    }
    firstPlayedAt =
      firstPlayedAt === null ? event.playedAt : Math.min(firstPlayedAt, event.playedAt);
    lastPlayedAt = lastPlayedAt === null ? event.playedAt : Math.max(lastPlayedAt, event.playedAt);
  }

  return {
    totalPlays,
    distinctSongs: songKeys.size,
    syntheticEvents,
    realEvents,
    firstPlayedAt,
    lastPlayedAt,
  };
};

// ── 聚合引擎（子批次 2）──────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

/** 时段分桶定义（按本地小时划分，左闭右开）。 */
export const TIME_OF_DAY_BUCKETS = [
  { id: 'deepNight', label: '深夜', fromHour: 0, toHour: 5 },
  { id: 'earlyMorning', label: '清晨', fromHour: 5, toHour: 8 },
  { id: 'morning', label: '上午', fromHour: 8, toHour: 12 },
  { id: 'afternoon', label: '下午', fromHour: 12, toHour: 17 },
  { id: 'evening', label: '傍晚', fromHour: 17, toHour: 20 },
  { id: 'night', label: '夜晚', fromHour: 20, toHour: 24 },
] as const;

export type TimeOfDayBucketId = (typeof TIME_OF_DAY_BUCKETS)[number]['id'];

const normalizeOffsetMinutes = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? Math.round(num) : 0;
};

const toLocalEpoch = (timestamp: number, offsetMinutes: number): number =>
  timestamp + offsetMinutes * 60_000;

/** 本地日索引（自 epoch 起的天数，已按给定时区偏移平移）。 */
export const dayIndexOf = (timestamp: number, offsetMinutes: number): number =>
  Math.floor(toLocalEpoch(timestamp, offsetMinutes) / DAY_MS);

/** 本地日索引 → `YYYY-MM-DD`。 */
export const dayKeyFromIndex = (dayIndex: number): string => {
  const date = new Date(dayIndex * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** 时间戳 → 本地 `YYYY-MM-DD`。 */
export const dayKeyOf = (timestamp: number, offsetMinutes: number): string =>
  dayKeyFromIndex(dayIndexOf(timestamp, offsetMinutes));

/** 时间戳 → 本地小时（0–23）。 */
export const localHourOf = (timestamp: number, offsetMinutes: number): number =>
  new Date(toLocalEpoch(timestamp, offsetMinutes)).getUTCHours();

/** 单事件的计权播放次数：合成事件按历史累计次数计，真实事件每次计 1。 */
export const playsOfEvent = (event: JournalPlayEvent): number =>
  event.synthetic ? event.baselinePlayCount : 1;

const normalizeEventsInput = (events: unknown): JournalPlayEvent[] =>
  Array.isArray(events) ? normalizeJournalState({ events }).events : [];

const toWindowSize = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
};

export interface DailyTimelinePoint {
  dayKey: string;
  dayIndex: number;
  plays: number;
  distinctSongs: number;
  /** 该日包含由既有历史合成的近似数据（时间点为近似） */
  hasSynthetic: boolean;
}

export interface DailyTimelineOptions {
  now: number;
  days: number;
  timeZoneOffsetMinutes: number;
}

/**
 * 最近 `days` 天的逐日时间轴（升序，含空日）。
 * `now` 非有限或 `days <= 0` 时返回空数组 —— 不猜测窗口位置。
 */
export const buildDailyTimeline = (
  events: unknown,
  options: DailyTimelineOptions,
): DailyTimelinePoint[] => {
  const days = toWindowSize(options?.days);
  if (!Number.isFinite(options?.now) || days <= 0) return [];

  const offset = normalizeOffsetMinutes(options.timeZoneOffsetMinutes);
  const endDay = dayIndexOf(options.now, offset);
  const startDay = endDay - days + 1;

  const buckets = new Map<number, { plays: number; songs: Set<string>; hasSynthetic: boolean }>();
  for (const event of normalizeEventsInput(events)) {
    const dayIndex = dayIndexOf(event.playedAt, offset);
    if (dayIndex < startDay || dayIndex > endDay) continue;
    const bucket = buckets.get(dayIndex) ?? {
      plays: 0,
      songs: new Set<string>(),
      hasSynthetic: false,
    };
    bucket.plays += playsOfEvent(event);
    bucket.songs.add(event.songKey);
    bucket.hasSynthetic = bucket.hasSynthetic || event.synthetic;
    buckets.set(dayIndex, bucket);
  }

  const timeline: DailyTimelinePoint[] = [];
  for (let dayIndex = startDay; dayIndex <= endDay; dayIndex += 1) {
    const bucket = buckets.get(dayIndex);
    timeline.push({
      dayKey: dayKeyFromIndex(dayIndex),
      dayIndex,
      plays: bucket?.plays ?? 0,
      distinctSongs: bucket?.songs.size ?? 0,
      hasSynthetic: bucket?.hasSynthetic ?? false,
    });
  }
  return timeline;
};

export interface TimeOfDayBucket {
  id: TimeOfDayBucketId;
  label: string;
  plays: number;
  distinctSongs: number;
}

/** 时段分布（固定 6 桶，始终返回全部桶，便于直接渲染）。 */
export const clusterByTimeOfDay = (
  events: unknown,
  options: { timeZoneOffsetMinutes: number },
): TimeOfDayBucket[] => {
  const offset = normalizeOffsetMinutes(options?.timeZoneOffsetMinutes);
  const buckets = new Map<TimeOfDayBucketId, { plays: number; songs: Set<string> }>();

  for (const event of normalizeEventsInput(events)) {
    const hour = localHourOf(event.playedAt, offset);
    const definition = TIME_OF_DAY_BUCKETS.find(
      (item) => hour >= item.fromHour && hour < item.toHour,
    );
    if (!definition) continue;
    const bucket = buckets.get(definition.id) ?? { plays: 0, songs: new Set<string>() };
    bucket.plays += playsOfEvent(event);
    bucket.songs.add(event.songKey);
    buckets.set(definition.id, bucket);
  }

  return TIME_OF_DAY_BUCKETS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    plays: buckets.get(definition.id)?.plays ?? 0,
    distinctSongs: buckets.get(definition.id)?.songs.size ?? 0,
  }));
};

export interface WeeklySummaryPoint {
  weekIndex: number;
  label: string;
  startDayKey: string;
  endDayKey: string;
  plays: number;
  distinctSongs: number;
}

/**
 * 最近 `weeks` 个「7 天块」的汇总（升序，含空周）。
 * 分块基准是 epoch 对齐的 7 天窗口（1970-01-01 为周四），保证跨时区可复现。
 */
export const buildWeeklySummary = (
  events: unknown,
  options: { now: number; weeks: number; timeZoneOffsetMinutes: number },
): WeeklySummaryPoint[] => {
  const weeks = toWindowSize(options?.weeks);
  if (!Number.isFinite(options?.now) || weeks <= 0) return [];

  const offset = normalizeOffsetMinutes(options.timeZoneOffsetMinutes);
  const endWeek = Math.floor(dayIndexOf(options.now, offset) / 7);
  const startWeek = endWeek - weeks + 1;

  const buckets = new Map<number, { plays: number; songs: Set<string> }>();
  for (const event of normalizeEventsInput(events)) {
    const weekIndex = Math.floor(dayIndexOf(event.playedAt, offset) / 7);
    if (weekIndex < startWeek || weekIndex > endWeek) continue;
    const bucket = buckets.get(weekIndex) ?? { plays: 0, songs: new Set<string>() };
    bucket.plays += playsOfEvent(event);
    bucket.songs.add(event.songKey);
    buckets.set(weekIndex, bucket);
  }

  const summary: WeeklySummaryPoint[] = [];
  for (let weekIndex = startWeek; weekIndex <= endWeek; weekIndex += 1) {
    const startDayKey = dayKeyFromIndex(weekIndex * 7);
    const endDayKey = dayKeyFromIndex(weekIndex * 7 + 6);
    summary.push({
      weekIndex,
      label: `${startDayKey} ~ ${endDayKey}`,
      startDayKey,
      endDayKey,
      plays: buckets.get(weekIndex)?.plays ?? 0,
      distinctSongs: buckets.get(weekIndex)?.songs.size ?? 0,
    });
  }
  return summary;
};

export interface RankedSong {
  songKey: string;
  title: string;
  artist: string;
  plays: number;
  lastPlayedAt: number;
}

export interface RankedArtist {
  artist: string;
  plays: number;
  distinctSongs: number;
}

export interface RankedAlbum {
  album: string;
  plays: number;
  distinctSongs: number;
}

export interface YearReview {
  year: number;
  totalPlays: number;
  distinctSongs: number;
  activeDays: number;
  syntheticEvents: number;
  realEvents: number;
  topSongs: RankedSong[];
  topArtists: RankedArtist[];
  topAlbums: RankedAlbum[];
  busiestDay: { dayKey: string; plays: number } | null;
}

const compareRank = <T extends { plays: number }>(left: T, right: T): number =>
  right.plays - left.plays;

/**
 * 名称比较：使用**码位序**而非 `localeCompare`。
 * `localeCompare` 的结果依赖运行环境的 locale（例如中文默认排序按拼音，会让「丙(b)」
 * 排在「甲(j)」之前），导致聚合结果在不同机器上不一致、测试不可复现。
 */
const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

/**
 * 年度回顾。
 * 排序口径：次数降序 → 并列时按名称码位序升序（保证结果稳定、可测试）。
 * 空数据返回零值而非抛错；跨年事件不计入。
 */
export const buildYearReview = (
  events: unknown,
  options: { year: number; timeZoneOffsetMinutes: number },
): YearReview => {
  const year = Number.isFinite(options?.year) ? Math.floor(options.year) : 0;
  const offset = normalizeOffsetMinutes(options?.timeZoneOffsetMinutes);

  const songs = new Map<string, RankedSong>();
  const artists = new Map<string, { plays: number; songs: Set<string> }>();
  const albums = new Map<string, { plays: number; songs: Set<string> }>();
  const days = new Map<string, number>();
  let totalPlays = 0;
  let syntheticEvents = 0;
  let realEvents = 0;

  for (const event of normalizeEventsInput(events)) {
    if (new Date(toLocalEpoch(event.playedAt, offset)).getUTCFullYear() !== year) continue;

    const plays = playsOfEvent(event);
    totalPlays += plays;
    if (event.synthetic) syntheticEvents += 1;
    else realEvents += 1;

    const song = songs.get(event.songKey);
    if (song) {
      song.plays += plays;
      if (event.playedAt > song.lastPlayedAt) song.lastPlayedAt = event.playedAt;
    } else {
      songs.set(event.songKey, {
        songKey: event.songKey,
        title: event.title,
        artist: event.artist,
        plays,
        lastPlayedAt: event.playedAt,
      });
    }

    const artistKey = event.artist || '未知歌手';
    const artist = artists.get(artistKey) ?? { plays: 0, songs: new Set<string>() };
    artist.plays += plays;
    artist.songs.add(event.songKey);
    artists.set(artistKey, artist);

    if (event.album) {
      const album = albums.get(event.album) ?? { plays: 0, songs: new Set<string>() };
      album.plays += plays;
      album.songs.add(event.songKey);
      albums.set(event.album, album);
    }

    const dayKey = dayKeyOf(event.playedAt, offset);
    days.set(dayKey, (days.get(dayKey) ?? 0) + plays);
  }

  const topSongs = [...songs.values()].sort(
    (left, right) => compareRank(left, right) || compareText(left.title, right.title),
  );
  const topArtists: RankedArtist[] = [...artists.entries()]
    .map(([artist, value]) => ({
      artist,
      plays: value.plays,
      distinctSongs: value.songs.size,
    }))
    .sort((left, right) => compareRank(left, right) || compareText(left.artist, right.artist));
  const topAlbums: RankedAlbum[] = [...albums.entries()]
    .map(([album, value]) => ({ album, plays: value.plays, distinctSongs: value.songs.size }))
    .sort((left, right) => compareRank(left, right) || compareText(left.album, right.album));

  let busiestDay: { dayKey: string; plays: number } | null = null;
  for (const [dayKey, plays] of days.entries()) {
    const isBusier =
      !busiestDay ||
      plays > busiestDay.plays ||
      (plays === busiestDay.plays && dayKey < busiestDay.dayKey);
    if (isBusier) busiestDay = { dayKey, plays };
  }

  return {
    year,
    totalPlays,
    distinctSongs: songs.size,
    activeDays: days.size,
    syntheticEvents,
    realEvents,
    topSongs,
    topArtists,
    topAlbums,
    busiestDay,
  };
};

// ── 情绪标签（子批次 3）──────────────────────────────────────────────────────

/**
 * 情绪标签候选值。
 *
 * **本功能不做情绪自动推断**：项目内不存在任何音频情绪分析能力
 * （依赖快照：`src/**` 无相关实现），凭空推断会产出无依据的结论。
 * 时段维度由 `clusterByTimeOfDay` 提供，情绪维度只接受用户手动标注。
 */
export const MOOD_PRESETS = ['专注', '放松', '伤感', '兴奋', '怀旧', '深夜'] as const;

export const MOOD_MAX_LENGTH = 24;

/** 归一化情绪文本：仅接受字符串，去除控制字符与首尾空白，并截断长度。 */
export const normalizeMoodText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return stripped.trim().slice(0, MOOD_MAX_LENGTH);
};

/**
 * 给指定事件设置/覆盖/清除情绪标签，返回新数组（不修改入参）。
 * `mood` 归一化后为空字符串时表示清除该字段。
 */
export const applyEventMood = (
  events: readonly JournalPlayEvent[],
  eventId: string,
  mood: unknown,
): JournalPlayEvent[] => {
  const targetId = typeof eventId === 'string' ? eventId.trim() : '';
  const current = normalizeJournalState({ events }).events;
  if (!targetId || !current.some((event) => event.id === targetId)) return current;

  const next = normalizeMoodText(mood);
  return current.map((event) => {
    if (event.id !== targetId) return event;
    if (!next) {
      const { mood: _removed, ...rest } = event;
      void _removed;
      return rest;
    }
    return { ...event, mood: next };
  });
};

export interface MoodBucket {
  mood: string;
  plays: number;
  distinctSongs: number;
}

export interface MoodSummary {
  moods: MoodBucket[];
  /** 已标注情绪事件的计权播放次数 */
  taggedPlays: number;
  /** 未标注情绪事件的计权播放次数 */
  untaggedPlays: number;
  taggedEvents: number;
  totalEvents: number;
}

/** 按情绪聚合：次数降序，并列按情绪文本的码位序（保证跨环境可复现）。 */
export const summarizeMoods = (events: unknown): MoodSummary => {
  const valid = normalizeEventsInput(events);
  const buckets = new Map<string, { plays: number; songs: Set<string> }>();
  let taggedPlays = 0;
  let untaggedPlays = 0;
  let taggedEvents = 0;

  for (const event of valid) {
    const plays = playsOfEvent(event);
    const mood = normalizeMoodText(event.mood);
    if (!mood) {
      untaggedPlays += plays;
      continue;
    }
    taggedEvents += 1;
    taggedPlays += plays;
    const bucket = buckets.get(mood) ?? { plays: 0, songs: new Set<string>() };
    bucket.plays += plays;
    bucket.songs.add(event.songKey);
    buckets.set(mood, bucket);
  }

  const moods: MoodBucket[] = [...buckets.entries()]
    .map(([mood, value]) => ({ mood, plays: value.plays, distinctSongs: value.songs.size }))
    .sort((left, right) => compareRank(left, right) || compareText(left.mood, right.mood));

  return {
    moods,
    taggedPlays,
    untaggedPlays,
    taggedEvents,
    totalEvents: valid.length,
  };
};

// ── 视图模型（子批次 4）──────────────────────────────────────────────────────

/**
 * 本机时区偏移，单位「UTC 以东的分钟数」（UTC+8 → 480）。
 *
 * 注意符号：JS 的 `Date.prototype.getTimezoneOffset()` 返回的是 **UTC 以西**分钟数
 * （UTC+8 → -480），与聚合函数使用的约定相反，因此这里必须取反。
 * 非法输入回落 0（等价 UTC），不抛错。
 */
export const toLocalTimeZoneOffsetMinutes = (date: Date = new Date()): number => {
  if (!date || typeof date.getTimezoneOffset !== 'function') return 0;
  const offset = date.getTimezoneOffset();
  return Number.isFinite(offset) ? -offset : 0;
};

export interface JournalViewOptions {
  now: number;
  days: number;
  weeks: number;
  year: number;
  timeZoneOffsetMinutes: number;
}

export interface JournalView {
  timeline: DailyTimelinePoint[];
  weekly: WeeklySummaryPoint[];
  timeOfDay: TimeOfDayBucket[];
  moods: MoodSummary;
  review: YearReview;
  summary: JournalSummary;
  /** 时间轴柱状图归一化用的每日峰值 */
  maxDailyPlays: number;
  year: number;
}

/**
 * 一次性组装视图模型。
 * 视图组件只负责渲染本函数的产物，不承载聚合逻辑 —— 保证视图行为可被纯逻辑测试覆盖。
 */
export const buildJournalView = (events: unknown, options: JournalViewOptions): JournalView => {
  const valid = normalizeEventsInput(events);
  const timeZoneOffsetMinutes = normalizeOffsetMinutes(options?.timeZoneOffsetMinutes);
  const now = Number.isFinite(options?.now) ? options.now : Number.NaN;
  const days = toWindowSize(options?.days);
  const weeks = toWindowSize(options?.weeks);
  const year = Number.isFinite(options?.year) ? Math.floor(options.year) : 0;

  const timeline = buildDailyTimeline(valid, { now, days, timeZoneOffsetMinutes });
  const weekly = buildWeeklySummary(valid, { now, weeks, timeZoneOffsetMinutes });
  const timeOfDay = clusterByTimeOfDay(valid, { timeZoneOffsetMinutes });
  const moods = summarizeMoods(valid);
  const review = buildYearReview(valid, { year, timeZoneOffsetMinutes });
  const summary = summarizeJournal(valid);
  const maxDailyPlays = timeline.reduce((max, point) => Math.max(max, point.plays), 0);

  return {
    timeline,
    weekly,
    timeOfDay,
    moods,
    review,
    summary,
    maxDailyPlays,
    year,
  };
};

// ── 导出/分享文案（子批次 5）────────────────────────────────────────────────

/**
 * 生成可复制的纯文本摘要（用于「复制摘要」与分享）。
 * 只输出实际存在的数据：无事件时明确写「暂无记录」，含合成基线时显式声明，
 * 不夸大、不臆造统计口径。
 */
export const buildJournalShareText = (view: JournalView | null | undefined): string => {
  if (!view || typeof view !== 'object') return '听歌档案\n暂无记录';

  const summary = view.summary ?? summarizeJournal([]);
  const review = view.review;
  const lines: string[] = [
    `${view.year ?? 0} 年听歌档案`,
    `总播放 ${summary.totalPlays} 次 · 曲目 ${summary.distinctSongs} 首 · 活跃 ${
      review?.activeDays ?? 0
    } 天`,
  ];

  if (summary.syntheticEvents > 0) {
    lines.push(
      `（其中 ${summary.syntheticEvents} 条为近似基线：时间点取最后一次播放，次数按历史累计）`,
    );
  }

  const topSongs = Array.isArray(review?.topSongs) ? review.topSongs.slice(0, 5) : [];
  if (topSongs.length === 0) {
    lines.push('暂无记录');
  } else {
    topSongs.forEach((song, index) => {
      lines.push(`${index + 1}. ${song.title} — ${song.artist}（${song.plays} 次）`);
    });
  }

  return lines.join('\n');
};
