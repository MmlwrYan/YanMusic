import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildJournalView,
  toLocalTimeZoneOffsetMinutes,
  type JournalPlayEvent,
} from '../src/shared/musicJournal.ts';

/**
 * 听歌档案（C2）子批次 4：视图模型 —— 纯逻辑测试。
 *
 * 视图本身（Vue 组件）不承载可测逻辑：它只渲染 `buildJournalView()` 的产物，
 * 因此本批次的验收证据是「视图模型的纯逻辑断言 + 类型检查 + 构建」。
 */

const TZ = 480;
const local = (year: number, month: number, day: number, hour = 0): number =>
  Date.UTC(year, month - 1, day, hour) - TZ * 60_000;

const event = (
  id: string,
  playedAt: number,
  extra: Partial<JournalPlayEvent> = {},
): JournalPlayEvent => ({
  id,
  songKey: `k-${id}`,
  title: `曲-${id}`,
  artist: `人-${id}`,
  album: `专-${id}`,
  durationSec: 200,
  playedAt,
  source: 'kugou',
  synthetic: false,
  baselinePlayCount: 0,
  ...extra,
});

test('toLocalTimeZoneOffsetMinutes：符号约定为「UTC 以东分钟数」', () => {
  // JS 的 getTimezoneOffset() 返回「UTC 以西分钟数」（UTC+8 → -480），此处必须取反。
  const fakeUtc8 = { getTimezoneOffset: () => -480 };
  const fakeUtcMinus5 = { getTimezoneOffset: () => 300 };
  assert.equal(toLocalTimeZoneOffsetMinutes(fakeUtc8 as never), 480);
  assert.equal(toLocalTimeZoneOffsetMinutes(fakeUtcMinus5 as never), -300);

  // 与本机时区保持同一约定
  const now = new Date();
  assert.equal(toLocalTimeZoneOffsetMinutes(now), -now.getTimezoneOffset());

  // 非法输入回落 0（等价 UTC），不抛错
  assert.equal(toLocalTimeZoneOffsetMinutes(null as never), 0);
});

test('buildJournalView：组合视图模型字段齐全且口径一致', () => {
  const now = local(2026, 3, 10, 20);
  const events = [
    event('a', local(2026, 3, 10, 9), { mood: '专注' }),
    event('b', local(2026, 3, 10, 22)),
    event('c', local(2026, 3, 9, 14), { mood: '专注' }),
    event('d', local(2026, 3, 2, 3)),
  ];

  const view = buildJournalView(events, {
    now,
    days: 7,
    weeks: 3,
    year: 2026,
    timeZoneOffsetMinutes: TZ,
  });

  assert.equal(view.timeline.length, 7);
  assert.equal(view.weekly.length, 3);
  assert.equal(view.timeOfDay.length, 6);
  assert.equal(view.year, 2026);

  // 每日峰值用于柱状图归一化
  assert.equal(view.maxDailyPlays, 2);
  // 汇总口径：4 次真实播放、4 首不同曲目
  assert.equal(view.summary.totalPlays, 4);
  assert.equal(view.summary.distinctSongs, 4);
  // 年度回顾覆盖全部事件
  assert.equal(view.review.totalPlays, 4);
  // 情绪聚合：专注 2 次，其余未标注 2 次
  assert.equal(view.moods.moods[0].mood, '专注');
  assert.equal(view.moods.moods[0].plays, 2);
  assert.equal(view.moods.untaggedPlays, 2);
  // 时段：09 时属上午、22 时属夜晚、14 时属下午、03 时属深夜
  const byId = Object.fromEntries(view.timeOfDay.map((item) => [item.id, item.plays]));
  assert.equal(byId.morning, 1);
  assert.equal(byId.night, 1);
  assert.equal(byId.afternoon, 1);
  assert.equal(byId.deepNight, 1);
});

test('buildJournalView：空数据返回完整骨架且不抛错', () => {
  const view = buildJournalView([], {
    now: local(2026, 3, 10, 12),
    days: 3,
    weeks: 2,
    year: 2026,
    timeZoneOffsetMinutes: TZ,
  });
  assert.equal(view.timeline.length, 3);
  assert.equal(view.weekly.length, 2);
  assert.equal(view.maxDailyPlays, 0);
  assert.equal(view.summary.totalPlays, 0);
  assert.equal(view.review.busiestDay, null);
  assert.deepEqual(view.moods.moods, []);

  const invalid = buildJournalView('x' as never, {
    now: local(2026, 3, 10, 12),
    days: 3,
    weeks: 2,
    year: 2026,
    timeZoneOffsetMinutes: TZ,
  });
  assert.equal(invalid.timeline.length, 3);
  assert.equal(invalid.summary.totalPlays, 0);
});

test('buildJournalView：合成基线在视图模型中被标记且计入总量', () => {
  const now = local(2026, 3, 10, 12);
  const synthetic = event('s', local(2026, 3, 10, 8), {
    synthetic: true,
    baselinePlayCount: 5,
  });
  const view = buildJournalView([synthetic], {
    now,
    days: 3,
    weeks: 2,
    year: 2026,
    timeZoneOffsetMinutes: TZ,
  });
  assert.equal(view.summary.syntheticEvents, 1);
  assert.equal(view.summary.totalPlays, 5);
  assert.equal(view.maxDailyPlays, 5);
  assert.equal(view.timeline[2].hasSynthetic, true);
});
