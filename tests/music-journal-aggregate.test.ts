import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDailyTimeline,
  buildWeeklySummary,
  buildYearReview,
  clusterByTimeOfDay,
  synthesizeBaselineEvents,
  type JournalPlayEvent,
} from '../src/shared/musicJournal.ts';

/**
 * 听歌档案（C2）子批次 2：聚合引擎 —— 纯逻辑测试。
 *
 * 全部用例显式传入 `timeZoneOffsetMinutes`（UTC 以东的分钟数，UTC+8 = 480），
 * 保证在不同时区的机器上结果一致、可复现。
 */

const TZ = 480; // UTC+8

/** 构造某个「本地时间」的 epoch 毫秒：本地 = UTC + TZ。 */
const local = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour, minute) - TZ * 60_000;

const event = (
  songKey: string,
  playedAt: number,
  extra: Partial<JournalPlayEvent> = {},
): JournalPlayEvent => ({
  id: `${songKey}:${playedAt}`,
  songKey,
  title: `曲-${songKey}`,
  artist: `人-${songKey}`,
  album: `专-${songKey}`,
  durationSec: 200,
  playedAt,
  source: 'kugou',
  synthetic: false,
  baselinePlayCount: 0,
  ...extra,
});

test('buildDailyTimeline：按本地日分桶，窗口外的播放不计入', () => {
  const now = local(2026, 3, 10, 20, 0);
  const events = [
    event('a', local(2026, 3, 10, 9, 0)),
    event('b', local(2026, 3, 10, 23, 30)),
    event('c', local(2026, 3, 9, 9, 0)),
    event('d', local(2026, 3, 1, 9, 0)), // 窗口外
  ];

  const timeline = buildDailyTimeline(events, { now, days: 3, timeZoneOffsetMinutes: TZ });
  assert.equal(timeline.length, 3);
  assert.deepEqual(
    timeline.map((item) => item.dayKey),
    ['2026-03-08', '2026-03-09', '2026-03-10'],
  );
  assert.deepEqual(
    timeline.map((item) => item.plays),
    [0, 1, 2],
  );
  assert.equal(timeline[2].distinctSongs, 2);
});

test('buildDailyTimeline：跨日边界按本地时区划分', () => {
  // UTC 时间 2026-03-09 17:00 = UTC+8 的 2026-03-10 01:00
  const utcEvening = Date.UTC(2026, 2, 9, 17, 0);
  const now = local(2026, 3, 10, 12, 0);

  const atUtc8 = buildDailyTimeline([event('a', utcEvening)], {
    now,
    days: 2,
    timeZoneOffsetMinutes: 480,
  });
  assert.equal(atUtc8[1].dayKey, '2026-03-10');
  assert.equal(atUtc8[1].plays, 1);

  const atUtc = buildDailyTimeline([event('a', utcEvening)], {
    now,
    days: 2,
    timeZoneOffsetMinutes: 0,
  });
  // UTC 下同一个时间戳落在 03-09，即窗口的第一天
  assert.equal(atUtc[0].dayKey, '2026-03-09');
  assert.equal(atUtc[0].plays, 1);
  assert.equal(atUtc[1].plays, 0);
});

test('buildDailyTimeline：合成事件按历史次数计权并标记该日含近似数据', () => {
  const now = local(2026, 3, 10, 12, 0);
  const synthetic = synthesizeBaselineEvents([
    {
      historyKey: 'base:1',
      lastPlayedAt: local(2026, 3, 9, 8, 0),
      playCount: 6,
      song: { mixSongId: 'base', title: '旧曲', artist: '旧人' },
    },
  ]);

  const timeline = buildDailyTimeline([...synthetic], { now, days: 3, timeZoneOffsetMinutes: TZ });
  const day = timeline.find((item) => item.dayKey === '2026-03-09')!;
  assert.equal(day.plays, 6);
  assert.equal(day.hasSynthetic, true);
  assert.equal(timeline[2].hasSynthetic, false);
});

test('buildDailyTimeline：非法参数回落为安全值', () => {
  // days <= 0 → 空窗口
  assert.deepEqual(buildDailyTimeline([], { now: 0, days: 0, timeZoneOffsetMinutes: TZ }), []);
  // 非有限 now → 空窗口（不猜测窗口位置）
  assert.deepEqual(
    buildDailyTimeline([], { now: Number.NaN, days: 5, timeZoneOffsetMinutes: TZ }),
    [],
  );
  // 非法 events 视为「无事件」→ 仍返回完整的空窗口，便于视图直接渲染
  const zeroWindow = buildDailyTimeline('not-an-array' as never, {
    now: 100,
    days: 5,
    timeZoneOffsetMinutes: TZ,
  });
  assert.equal(zeroWindow.length, 5);
  assert.ok(zeroWindow.every((item) => item.plays === 0 && item.distinctSongs === 0));
});

test('clusterByTimeOfDay：时段边界归属正确', () => {
  const now = local(2026, 3, 10, 23, 0);
  const at = (hour: number, minute = 0) => event(`h${hour}`, local(2026, 3, 10, hour, minute));
  const events = [
    at(0, 30), // 深夜
    at(4, 59), // 深夜
    at(5, 0), // 清晨
    at(7, 59), // 清晨
    at(8, 0), // 上午
    at(11, 59), // 上午
    at(12, 0), // 下午
    at(16, 59), // 下午
    at(17, 0), // 傍晚
    at(19, 59), // 傍晚
    at(20, 0), // 夜晚
    at(23, 0), // 夜晚
  ];

  const buckets = clusterByTimeOfDay(events, { timeZoneOffsetMinutes: TZ });
  const byId = Object.fromEntries(buckets.map((item) => [item.id, item.plays]));

  assert.equal(byId.deepNight, 2);
  assert.equal(byId.earlyMorning, 2);
  assert.equal(byId.morning, 2);
  assert.equal(byId.afternoon, 2);
  assert.equal(byId.evening, 2);
  assert.equal(byId.night, 2);
  assert.equal(buckets.length, 6);
  assert.ok(now > 0);
});

test('buildWeeklySummary：按自然周聚合，空周补零', () => {
  // 2026-03-09 是周一；用它作为基准周
  const now = local(2026, 3, 18, 12, 0);
  const events = [
    event('a', local(2026, 3, 9, 10, 0)),
    event('b', local(2026, 3, 10, 10, 0)),
    event('c', local(2026, 3, 17, 10, 0)),
  ];

  const weeks = buildWeeklySummary(events, { now, weeks: 3, timeZoneOffsetMinutes: TZ });
  assert.equal(weeks.length, 3);
  assert.deepEqual(
    weeks.map((item) => item.plays),
    [0, 2, 1],
  );
  assert.equal(weeks[1].distinctSongs, 2);
});

test('buildYearReview：榜单排序稳定、统计口径与汇总一致', () => {
  const events = [
    event('a', local(2026, 1, 5, 10, 0), { title: '乙', artist: 'A' }),
    event('b', local(2026, 1, 5, 11, 0), { title: '甲', artist: 'A' }),
    event('c', local(2026, 2, 5, 11, 0), { title: '丙', artist: 'B' }),
    event('a', local(2026, 2, 6, 11, 0), { title: '乙', artist: 'A' }),
    // 跨年事件不应计入 2026
    event('z', local(2025, 12, 31, 23, 0), { title: '旧', artist: 'C' }),
  ];

  const review = buildYearReview(events, { year: 2026, timeZoneOffsetMinutes: TZ });
  assert.equal(review.totalPlays, 4);
  assert.equal(review.distinctSongs, 3);
  assert.equal(review.activeDays, 3);

  // 榜单口径：次数降序；次数并列时按**码位序**升序稳定排序（不使用 localeCompare，
  // 以免排序结果依赖运行环境 locale）。
  // 曲 'a'（乙）2 次；'b'（甲，U+7532）与 'c'（丙，U+4E19）各 1 次且并列 → 丙 < 甲。
  assert.deepEqual(
    review.topSongs.map((item) => item.title),
    ['乙', '丙', '甲'],
  );
  assert.equal(review.topSongs[0].plays, 2);

  assert.deepEqual(
    review.topArtists.map((item) => [item.artist, item.plays]),
    [
      ['A', 3],
      ['B', 1],
    ],
  );
  // 2026-01-05 有 2 次播放，是最忙的一天
  assert.equal(review.busiestDay?.dayKey, '2026-01-05');
  assert.equal(review.busiestDay?.plays, 2);
});

test('buildYearReview：空数据返回零值而非抛错', () => {
  const review = buildYearReview([], { year: 2026, timeZoneOffsetMinutes: TZ });
  assert.equal(review.totalPlays, 0);
  assert.equal(review.distinctSongs, 0);
  assert.equal(review.activeDays, 0);
  assert.deepEqual(review.topSongs, []);
  assert.equal(review.busiestDay, null);

  const invalid = buildYearReview('x' as never, { year: 2026, timeZoneOffsetMinutes: TZ });
  assert.equal(invalid.totalPlays, 0);
});

test('buildYearReview：合成事件计入年度总量并被单独标记', () => {
  const synthetic = synthesizeBaselineEvents([
    {
      historyKey: 'base:1',
      lastPlayedAt: local(2026, 5, 5, 8, 0),
      playCount: 9,
      song: { mixSongId: 'base', title: '老歌', artist: '老人', albumName: '老专' },
    },
  ]);
  const review = buildYearReview(synthetic, { year: 2026, timeZoneOffsetMinutes: TZ });
  assert.equal(review.totalPlays, 9);
  assert.equal(review.syntheticEvents, 1);
  assert.equal(review.realEvents, 0);
  assert.equal(review.topSongs[0].title, '老歌');
  assert.equal(review.topSongs[0].plays, 9);
  assert.equal(review.topAlbums[0].album, '老专');
});
